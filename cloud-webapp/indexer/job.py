"""
job.py — M1 indexer: Drive → GCS mirror + embed + flat-file vector store.

Cloud Run Job (one execution = one event). Dev plan M1.3/M1.5:

  1. Resolve the event's Drive folder (env override or Firestore `events` doc).
  2. List the folder recursively; diff against the previous run's manifest
     (md5 + model_version) — only new/changed photos are downloaded/embedded;
     rows for photos deleted from Drive are dropped. Re-running is a no-op.
  3. Per changed photo: mirror original + web/thumb derivatives to the
     derivatives bucket; detect + embed faces/persons (matcher pipeline).
  4. Write faces.npy / persons.npy / manifest.json (store.py layout, the
     zero-cost vector store) and upsert Firestore `photos` docs + the
     event's `indexState`.

photoId = Drive fileId everywhere (Firestore doc id, manifest rows, GCS keys).

Env:
  EVENT_ID            required
  DRIVE_FOLDER_ID     optional (else events/<EVENT_ID>.driveFolderId)
  DERIVATIVES_ROOT    gs://<proj>-derivatives (or local dir for tests)
  MODEL_DIR           matcher ONNX models
  MATCHER_DIR         where matcher/*.py lives (default ../matcher, /app/matcher in Docker)
  FORCE_REINDEX=1     ignore the old manifest, re-embed everything
  LIMIT               cap photo count (spike/testing)
"""

from __future__ import annotations

import io
import json
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field

import numpy as np

from derivatives import make_derivatives
from capture_time import read_exif_datetime, resolve_taken_at, prefix_for, apply_prefix

log = logging.getLogger("indexer")

# Drive-direct browsing: when set, the indexer renames each file to a
# `YYYYMMDD-HHMMSS[_NNN]_<name>` prefix and stamps its Drive modifiedTime to the
# capture time, so "Sort by Name"/"Last modified" in the Drive UI become
# chronological (CAPTURE_TIME_SORT_DESIGN §3/§6). Off by default — it mutates
# Drive and needs the read-write Drive scope on the DWD client. The backfill
# turns it on. Setting takenAt in Firestore (the in-app sort) does NOT need it.
RENAME_ENABLED = os.environ.get("CAPTURE_TIME_RENAME", "") == "1"

# Default fan-out for the download+embed+upload stage. The work is dominated by
# Drive download + 3 GCS uploads (I/O) and ONNX inference (native, releases the
# GIL), so threads overlap well even on a 2-vCPU job. Override with the
# INDEX_CONCURRENCY env var; 1 reproduces the old serial behaviour.
DEFAULT_CONCURRENCY = 8

EMB_DIR = "embeddings"
FILES = {"face": "faces.npy", "person": "persons.npy"}
MANIFEST = "manifest.json"
ORIG_EXT_BY_MIME = {"image/jpeg": "jpg", "image/png": "png", "image/heic": "heic",
                    "image/heif": "heif", "image/webp": "webp", "image/tiff": "tif",
                    "image/bmp": "bmp", "image/avif": "avif"}


@dataclass
class Config:
    event_id: str
    drive_folder_id: str | None = None
    force: bool = False
    limit: int = 0
    extra: dict = field(default_factory=dict)


# ── Firestore metadata (PRD §6.2: photos, events.indexState) ────────────────

class FirestoreMeta:
    """Real Firestore implementation; tests substitute a fake with the same API."""

    def __init__(self, project: str | None = None):
        from google.cloud import firestore

        self._db = firestore.Client(project=project) if project else firestore.Client()

    def get_event(self, event_id: str) -> dict | None:
        snap = self._db.collection("events").document(event_id).get()
        return snap.to_dict() if snap.exists else None

    def set_index_state(self, event_id: str, state: dict) -> None:
        from datetime import datetime, timezone

        stamped = {"updatedAt": datetime.now(timezone.utc).isoformat(), **state}
        self._db.collection("events").document(event_id).set({"indexState": stamped}, merge=True)

    def set_event_name_if_empty(self, event_id: str, name: str) -> bool:
        """Set events.name only if it's currently empty (B5).

        Never clobbers a name already set by an admin or the master-Sheet
        reconciler — the Drive folder name is just a sensible default for
        events that have none. Returns True if a write happened.
        """
        if not name:
            return False
        ev = self.get_event(event_id) or {}
        if str(ev.get("name", "") or "").strip():
            return False
        self._db.collection("events").document(event_id).set({"name": name}, merge=True)
        return True

    def upsert_photo(self, photo_id: str, doc: dict) -> None:
        self._db.collection("photos").document(photo_id).set(doc, merge=True)

    def delete_photo(self, photo_id: str) -> None:
        self._db.collection("photos").document(photo_id).delete()


# ── store helpers (manifest with idempotency map) ────────────────────────────

def _load_previous(blobs, event_id: str) -> dict | None:
    rel = f"{event_id}/{EMB_DIR}/{MANIFEST}"
    if not blobs.exists(rel):
        return None
    manifest = json.loads(blobs.read(rel).decode("utf-8"))
    vectors = {}
    for kind, fname in FILES.items():
        vectors[kind] = np.load(io.BytesIO(blobs.read(f"{event_id}/{EMB_DIR}/{fname}")))
    return {"manifest": manifest, "vectors": vectors}


def _rows_by_photo(manifest: dict, vectors: dict) -> dict[str, dict]:
    """photoId → {"face": [(meta, vec)...], "person": [...]} from a previous run."""
    out: dict[str, dict] = {}
    for kind, meta_key in (("face", "faces"), ("person", "persons")):
        for i, meta in enumerate(manifest.get(meta_key, [])):
            pid = meta["photoId"]
            out.setdefault(pid, {"face": [], "person": []})
            out[pid][kind].append((meta, vectors[kind][i]))
    return out


def _write_store(blobs, event_id: str, manifest: dict,
                 faces: np.ndarray, persons: np.ndarray) -> None:
    for kind, arr in (("face", faces), ("person", persons)):
        buf = io.BytesIO()
        np.save(buf, arr.astype(np.float32))
        blobs.write(f"{event_id}/{EMB_DIR}/{FILES[kind]}", buf.getvalue())
    blobs.write(f"{event_id}/{EMB_DIR}/{MANIFEST}",
                json.dumps(manifest, ensure_ascii=False).encode("utf-8"),
                content_type="application/json")


# ── the run ──────────────────────────────────────────────────────────────────

def run(cfg: Config, drive, blobs, fs, embed, model_version: str,
        face_dim: int = 512, person_dim: int = 512, concurrency: int = 0) -> dict:
    """Index one event. All collaborators injected for testability.

    drive: .list_images(folder_id) / .download(file_id)
    blobs: BlobStore-like (write/read/exists)
    fs:    FirestoreMeta-like
    embed: bytes → {"faces": [{box, score, embedding}], "persons": [...]}
    concurrency: worker threads for the download+embed+upload stage. 0 → read
                 INDEX_CONCURRENCY env (default DEFAULT_CONCURRENCY). The
                 manifest/vector arrays are always assembled in Drive-listing
                 order regardless of completion order, so output stays
                 byte-identical across runs (idempotency).
    """
    folder_id = cfg.drive_folder_id
    if not folder_id:
        ev = fs.get_event(cfg.event_id) or {}
        folder_id = ev.get("driveFolderId")
    if not folder_id:
        raise SystemExit(f"event '{cfg.event_id}' has no driveFolderId (set it in Firestore "
                         f"events/{cfg.event_id} or pass DRIVE_FOLDER_ID)")

    fs.set_index_state(cfg.event_id, {"status": "running", "modelVersion": model_version})

    # Label the event from its Drive folder name when it has none yet (B5).
    # Best-effort: a metadata hiccup must not fail the run.
    try:
        if hasattr(fs, "set_event_name_if_empty") and hasattr(drive, "get_folder_name"):
            folder_name = drive.get_folder_name(folder_id)
            if folder_name and fs.set_event_name_if_empty(cfg.event_id, folder_name):
                log.info("event %s named from Drive folder: %r", cfg.event_id, folder_name)
    except Exception as exc:  # noqa: BLE001
        log.warning("event-name backfill skipped (%s)", exc)

    files = sorted(drive.list_images(folder_id), key=lambda f: f["relPath"])
    if cfg.limit:
        files = files[: cfg.limit]
    log.info("event %s: %d images in Drive folder %s", cfg.event_id, len(files), folder_id)

    # De-duplicate exact-duplicate images by content hash (B6 / FR-2c). Drive's
    # md5Checksum is a content hash of the bytes and is already in the listing,
    # so identical images (re-uploads, the same file copied into several
    # folders) collapse to ONE photo with no extra download. Canonical = first
    # in relPath order; later duplicates are dropped from indexing. Files with
    # no md5 (rare for images) are always kept. Near-duplicate *re-encodes*
    # (different bytes, same picture) need perceptual hashing — tracked as a B6
    # follow-up; this pass handles byte-identical duplicates.
    deduped: list[dict] = []
    canonical_by_hash: dict[str, str] = {}
    dup_map: dict[str, list[str]] = {}
    for f in files:
        h = f.get("md5Checksum", "")
        if h and h in canonical_by_hash:
            dup_map.setdefault(canonical_by_hash[h], []).append(f["id"])
            continue
        if h:
            canonical_by_hash[h] = f["id"]
        deduped.append(f)
    dup_count = sum(len(v) for v in dup_map.values())
    if dup_count:
        log.info("deduped %d byte-identical duplicate(s) → %d unique image(s)",
                 dup_count, len(deduped))
    files = deduped

    prev = None if cfg.force else _load_previous(blobs, cfg.event_id)
    prev_rows: dict[str, dict] = {}
    prev_photos: dict[str, dict] = {}
    if prev and prev["manifest"].get("modelVersion") == model_version:
        prev_rows = _rows_by_photo(prev["manifest"], prev["vectors"])
        prev_photos = prev["manifest"].get("photos", {})
    elif prev:
        log.info("model_version changed (%s → %s): full re-embed",
                 prev["manifest"].get("modelVersion"), model_version)

    faces_vecs, faces_meta = [], []
    persons_vecs, persons_meta = [], []
    photos_map: dict[str, dict] = {}
    embedded = reused = skipped = 0

    # Partition into reused (cheap, no I/O) vs changed (needs download+embed).
    changed = []
    for f in files:
        pid, md5 = f["id"], f.get("md5Checksum", "")
        if pid in prev_photos and md5 and prev_photos[pid].get("md5") == md5 and pid in prev_rows:
            continue  # assembled below from the previous run
        changed.append(f)

    # The heavy stage (Drive download → embed → 2 encodes → 3 GCS writes) runs
    # concurrently. Each worker is self-contained and returns its result; no
    # shared mutable state is touched here, so assembly stays deterministic.
    def _process(f: dict) -> dict:
        pid = f["id"]
        data = drive.download(pid)
        result = embed(data)
        # Read capture time from the bytes we already have (authoritative tier).
        result["exif"] = read_exif_datetime(data)
        ext = ORIG_EXT_BY_MIME.get(f["mimeType"], "bin")
        blobs.write(f"{cfg.event_id}/photos/orig/{pid}.{ext}", data, f["mimeType"])
        deriv = make_derivatives(data)
        blobs.write(f"{cfg.event_id}/photos/web/{pid}.jpg", deriv["web"], "image/jpeg")
        blobs.write(f"{cfg.event_id}/photos/thumb/{pid}.jpg", deriv["thumb"], "image/jpeg")
        return result

    workers = concurrency or int(os.environ.get("INDEX_CONCURRENCY", DEFAULT_CONCURRENCY))
    workers = max(1, min(workers, len(changed) or 1))
    log.info("processing %d changed photos with %d worker(s)", len(changed), workers)

    results: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_process, f): f for f in changed}
        done = 0
        for fut in as_completed(futures):
            f = futures[fut]
            try:
                results[f["id"]] = fut.result()
            except Exception as exc:
                log.warning("SKIP %s (%s): %s", f["relPath"], f["id"], exc)
                results[f["id"]] = None  # mark skipped; assembled below
            done += 1
            if done % 25 == 0:
                log.info("  %d/%d changed photos processed", done, len(changed))

    # ── Capture time (CAPTURE_TIME_SORT_DESIGN) ──────────────────────────────
    # Resolve takenAt + source per photo: EXIF (from the bytes _process read) →
    # Drive imageMediaMetadata.time → createdTime → modifiedTime. Reused photos
    # carry their value forward from the previous manifest.
    taken: dict[str, tuple] = {}
    for f in files:
        pid = f["id"]
        ex_iso, ex_sub = (results.get(pid) or {}).get("exif", (None, None)) if pid in results else (None, None)
        if pid in prev_photos and pid not in results:
            prev = prev_photos[pid]
            taken[pid] = (prev.get("takenAt"), prev.get("takenAtSource") or "modified", None)
        else:
            iso, src = resolve_taken_at(ex_iso, f)
            taken[pid] = (iso, src, ex_sub)

    # Plan Drive renames (only when enabled). Same-second collisions without a
    # sub-second EXIF tag get a per-second _NNN sequence (relPath order) so the
    # name-sort never relies on Drive's own "(1)" suffix.
    rename_to: dict[str, str] = {}
    if RENAME_ENABLED:
        sec_counts: dict[str, int] = {}
        for f in files:
            iso = taken[f["id"]][0]
            secp = prefix_for(iso) if iso else None
            if secp:
                sec_counts[secp] = sec_counts.get(secp, 0) + 1
        sec_seq: dict[str, int] = {}
        for f in files:
            pid = f["id"]
            iso, _src, sub = taken[pid]
            if not iso:
                continue
            secp = prefix_for(iso)
            if sub:
                prefix = prefix_for(iso, subsec=sub)
            elif sec_counts.get(secp, 0) > 1:
                i = sec_seq.get(secp, 0)
                sec_seq[secp] = i + 1
                prefix = f"{secp}_{i:03d}"
            else:
                prefix = secp
            desired = apply_prefix(f["name"], prefix)
            if desired != f["name"]:
                rename_to[pid] = desired

    # Assemble vectors/manifest/Firestore in Drive-listing order so the stored
    # arrays are identical regardless of which worker finished first.
    for f in files:
        pid, md5 = f["id"], f.get("md5Checksum", "")
        unchanged = (pid in prev_photos and md5 and prev_photos[pid].get("md5") == md5)

        # Apply the planned Drive rename + capture-time modifiedTime, then carry
        # the new name into the manifest/Firestore. Best-effort: a rename hiccup
        # must not fail indexing.
        if pid in rename_to:
            new_name = rename_to[pid]
            taken_iso = taken[pid][0]
            try:
                drive.rename(pid, new_name, modified_time=taken_iso)
                rel = f.get("relPath", f["name"])
                slash = rel.rfind("/")
                f["relPath"] = (rel[: slash + 1] + new_name) if slash >= 0 else new_name
                f["name"] = new_name
            except Exception as exc:  # noqa: BLE001
                log.warning("rename SKIP %s (%s): %s", f["name"], pid, exc)

        if unchanged and pid in prev_rows:
            for meta, vec in prev_rows[pid]["face"]:
                faces_meta.append(meta), faces_vecs.append(vec)
            for meta, vec in prev_rows[pid]["person"]:
                persons_meta.append(meta), persons_vecs.append(vec)
            carried = prev_photos[pid]
            # A reused (byte-unchanged) photo that we just renamed on Drive needs
            # its stored name/relPath refreshed (the bytes/vectors are reused but
            # the filename changed). Patch the manifest entry + Firestore doc.
            if pid in rename_to:
                carried = {**carried, "name": f["name"], "relPath": f["relPath"]}
                fs.upsert_photo(pid, {"name": f["name"], "relPath": f["relPath"]})
            photos_map[pid] = carried
            reused += 1
            continue

        result = results.get(pid)
        if result is None:  # download/embed/derivative failed → skip, non-fatal
            skipped += 1
            continue

        for face in result["faces"]:
            faces_vecs.append(face["embedding"])
            faces_meta.append({"photoId": pid, "box": face["box"], "score": face["score"]})
        for person in result["persons"]:
            persons_vecs.append(person["embedding"])
            persons_meta.append({"photoId": pid, "box": person["box"],
                                 "score": person["score"],
                                 "source": person.get("source", "detector")})
        dup_n = len(dup_map.get(pid, []))
        taken_at, taken_src, _sub = taken[pid]
        photos_map[pid] = {"md5": md5, "name": f["name"], "relPath": f["relPath"],
                           "mimeType": f["mimeType"], "modifiedTime": f.get("modifiedTime", ""),
                           "contentHash": md5, "duplicateCount": dup_n,
                           "takenAt": taken_at, "takenAtSource": taken_src}
        embedded += 1

        fs.upsert_photo(pid, {
            "eventId": cfg.event_id, "driveFileId": pid, "name": f["name"],
            "relPath": f["relPath"], "mimeType": f["mimeType"], "md5": md5,
            # contentHash mirrors md5 (Drive's byte checksum); surfaced so the
            # gallery can defensively de-dupe at list time (B6).
            "contentHash": md5, "duplicateCount": dup_n,
            "faceCount": len(result["faces"]), "personCount": len(result["persons"]),
            "modelVersion": model_version,
            # Capture-time sort (CAPTURE_TIME_SORT_DESIGN §4c/§5).
            "takenAt": taken_at, "takenAtSource": taken_src,
        })

    # Photos that disappeared from Drive: drop their rows + Firestore docs.
    removed = [pid for pid in prev_photos if pid not in photos_map]
    for pid in removed:
        fs.delete_photo(pid)
    if removed:
        log.info("removed %d photos no longer in Drive", len(removed))

    faces = (np.stack([np.asarray(v, np.float32) for v in faces_vecs])
             if faces_vecs else np.zeros((0, face_dim), np.float32))
    persons = (np.stack([np.asarray(v, np.float32) for v in persons_vecs])
               if persons_vecs else np.zeros((0, person_dim), np.float32))

    manifest = {
        "version": 1, "eventId": cfg.event_id, "modelVersion": model_version,
        "faces": faces_meta, "persons": persons_meta, "photos": photos_map,
        # Audit trail of collapsed duplicates: canonical photoId → [dropped ids].
        "duplicates": dup_map,
    }
    _write_store(blobs, cfg.event_id, manifest, faces, persons)

    summary = {"eventId": cfg.event_id, "photoCount": len(photos_map),
               "faces": len(faces_meta), "persons": len(persons_meta),
               "embedded": embedded, "reused": reused, "skipped": skipped,
               "removed": len(removed), "duplicates": dup_count,
               "modelVersion": model_version}
    fs.set_index_state(cfg.event_id, {"status": "done", **summary})
    log.info("done: %s", summary)
    return summary


# ── entrypoint (real wiring) ─────────────────────────────────────────────────

def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    matcher_dir = os.environ.get(
        "MATCHER_DIR",
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "matcher"),
    )
    sys.path.insert(0, matcher_dir)
    from models import load_bundle  # noqa: E402  (matcher modules)
    from pipeline import decode_image, embed_image  # noqa: E402

    cfg = Config(
        event_id=os.environ["EVENT_ID"],
        drive_folder_id=os.environ.get("DRIVE_FOLDER_ID") or None,
        force=os.environ.get("FORCE_REINDEX", "") == "1",
        limit=int(os.environ.get("LIMIT", "0")),
    )
    root = os.environ.get("DERIVATIVES_ROOT", "gs://mmr-data-pipeline-derivatives")

    bundle = load_bundle()

    def embed(data: bytes) -> dict:
        return embed_image(decode_image(data), bundle=bundle)

    from blobs import BlobStore
    from drive import DriveClient

    try:
        run(cfg, DriveClient(), BlobStore(root), FirestoreMeta(), embed,
            model_version=bundle.version,
            face_dim=bundle.face_emb.dim, person_dim=bundle.person_emb.dim)
        return 0
    except Exception:
        log.exception("indexing failed")
        try:
            FirestoreMeta().set_index_state(cfg.event_id, {"status": "failed"})
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
