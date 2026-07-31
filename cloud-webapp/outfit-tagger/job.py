"""
job.py — prepare one event: embed its person + head crops into the outfit store.

    EVENT_ID=<id> DERIVATIVES_ROOT=gs://<proj>-derivatives python job.py

**This is a Cloud Run Job, not an endpoint, on purpose.** A 1,600-photo event is
~3,000 crops, minutes of CPU-ONNX work — it does not fit the 60s Firebase
Hosting / Cloud Run request ceiling, and this repo has paid for that lesson three
times (duplicate removal, folder rebuild, the upload worker: see CLAUDE.md). A job
has no request deadline, so there is no budget to tune and no killed-mid-work
`catch` that never runs.

One execution = one event, mirroring `indexer/job.py`. Idempotent: re-running an
event re-embeds it and overwrites its store. Cheap to re-run, and a partially
failed run leaves the previous index in place (the writes happen once, at the end).

Inputs, both read-only artifacts of a completed index run:
  * `<eventId>/embeddings/manifest.json` — person + face boxes, per-photo mimeType
  * `<eventId>/photos/orig/<photoId>.<ext>` — full-resolution pixels

Output: `<eventId>/outfit/{crops.npy,index.json}`. Nothing else is touched.
"""

from __future__ import annotations

import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np

import crops as crops_mod
import siglip
from images import decode_image
from store import (
    BlobIO,
    INDEX_FILE,
    OutfitIndex,
    build_index,
    load_matcher_manifest,
    outfit_path,
    write_outfit,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("outfit-prepare")

# Threads for the read → decode → embed stage. ONNX Runtime sessions are safe to
# Run concurrently and native inference releases the GIL, so threads do help. Kept
# modest because each in-flight photo holds a decoded full-resolution array (a
# 24 MP original is ~72 MB as uint8) — the ceiling here is memory, not CPU.
DEFAULT_CONCURRENCY = 4


def _already_prepared(blobs: BlobIO, event_id: str, model_version: str, source_version: str) -> bool:
    """True when a usable index for this exact pair of model versions exists.

    Guards the common re-run (a scheduled sweep over every event) from redoing
    work. A mismatch in EITHER version means the stored vectors are not
    comparable to what this build would produce, so it re-embeds.
    """
    rel = outfit_path(event_id, INDEX_FILE)
    if not blobs.exists(rel):
        return False
    try:
        import json

        index = json.loads(blobs.read(rel).decode("utf-8"))
    except Exception:
        return False
    return (
        index.get("modelVersion") == model_version
        and index.get("sourceModelVersion") == source_version
        and bool(index.get("rows"))
    )


def _embed_photo(
    blobs: BlobIO,
    bundle,
    event_id: str,
    photo_id: str,
    mime_type: str | None,
    specs: list[tuple[int, dict]],
) -> tuple[list[tuple[int, dict, np.ndarray]], list[dict]]:
    """Embed every crop of one photo. Returns (results, skipped).

    Results carry the spec's global position so the caller can restore
    deterministic row order after the thread pool scrambles completion order.
    """
    rel = crops_mod.orig_path(event_id, photo_id, mime_type)
    if not blobs.exists(rel):
        # The mirrored original is how we get boxes and pixels into the same
        # coordinate space; without it the manifest's boxes cannot be placed on
        # any other copy (see crops.py). Skipping is the honest outcome — a
        # guessed rescale onto the web derivative would crop the wrong region.
        return [], [{"photoId": photo_id, "reason": "orig_missing", "path": rel}]
    try:
        img = decode_image(blobs.read(rel))
    except Exception as exc:  # noqa: BLE001 — one bad file must not kill the run
        return [], [{"photoId": photo_id, "reason": "decode_failed", "detail": str(exc)[:200]}]

    height, width = img.shape[:2]
    results: list[tuple[int, dict, np.ndarray]] = []
    skipped: list[dict] = []
    for position, spec in specs:
        box = crops_mod.resolve_box(spec, width, height)
        crop = crops_mod.cut(img, box)
        if crop.size == 0:
            skipped.append({"photoId": photo_id, "region": spec["region"], "reason": "empty_crop"})
            continue
        row = {
            "photoId": photo_id,
            "region": spec["region"],
            "box": [round(float(v), 2) for v in box],
        }
        if crops_mod.short_side(box) < crops_mod.MIN_CROP_PX:
            # Recorded, not dropped: "too small to be meaningful" is the caller's
            # call at query time (`include_small`), and re-preparing an event just
            # to change the cutoff would waste the whole run.
            row["small"] = True
        results.append((position, row, bundle.vision.embed(crop)))
    return results, skipped


def run(
    blobs: BlobIO,
    bundle,
    event_id: str,
    force: bool = False,
    limit: int = 0,
    concurrency: int = DEFAULT_CONCURRENCY,
) -> dict:
    manifest = load_matcher_manifest(blobs, event_id)
    source_version = str(manifest.get("modelVersion", ""))
    photos_meta: dict = manifest.get("photos") or {}

    if not force and _already_prepared(blobs, event_id, bundle.version, source_version):
        log.info("event %s already prepared for %s — skipping (FORCE=1 to redo)", event_id, bundle.version)
        return {"eventId": event_id, "status": "skipped", "reason": "already_prepared"}

    specs = crops_mod.specs_for_event(manifest)
    if not specs:
        log.warning("event %s has no person/face boxes in its manifest — nothing to embed", event_id)

    # Group by photo so each original is read and decoded ONCE for both its
    # person and head crops, while keeping each spec's global position.
    by_photo: dict[str, list[tuple[int, dict]]] = {}
    for position, spec in enumerate(specs):
        by_photo.setdefault(spec["photoId"], []).append((position, spec))
    photo_ids = list(by_photo)
    if limit > 0:
        photo_ids = photo_ids[:limit]
        log.info("LIMIT=%d → preparing %d of %d photos", limit, len(photo_ids), len(by_photo))

    log.info(
        "preparing event %s: %d photos, %d crops, model=%s source=%s",
        event_id,
        len(photo_ids),
        sum(len(by_photo[p]) for p in photo_ids),
        bundle.version,
        source_version,
    )

    collected: list[tuple[int, dict, np.ndarray]] = []
    skipped: list[dict] = []

    def work(photo_id: str):
        meta = photos_meta.get(photo_id) or {}
        return _embed_photo(
            blobs, bundle, event_id, photo_id, meta.get("mimeType"), by_photo[photo_id]
        )

    done = 0
    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        for results, photo_skipped in pool.map(work, photo_ids):
            collected.extend(results)
            skipped.extend(photo_skipped)
            done += 1
            if done % 100 == 0:
                log.info("… %d/%d photos (%d crops)", done, len(photo_ids), len(collected))

    collected.sort(key=lambda r: r[0])
    rows = [row for _, row, _ in collected]
    vectors = (
        np.stack([vec for _, _, vec in collected])
        if collected
        else np.zeros((0, bundle.dim), dtype=np.float32)
    )

    index = build_index(
        event_id=event_id,
        model_version=bundle.version,
        source_model_version=source_version,
        rows=rows,
        photos=len({r["photoId"] for r in rows}),
        skipped=skipped,
    )
    # Validate before publishing: OutfitIndex is what the service constructs, so
    # building it here means a shape bug fails the job rather than every query.
    OutfitIndex(index, vectors)
    write_outfit(blobs, event_id, index, vectors)

    summary = {
        "eventId": event_id,
        "status": "done",
        "crops": len(rows),
        "photos": index["photos"],
        "skipped": len(skipped),
        "modelVersion": bundle.version,
        "sourceModelVersion": source_version,
    }
    log.info("done: %s", summary)
    return summary


def main() -> int:
    event_id = os.environ.get("EVENT_ID", "").strip()
    if not event_id:
        log.error("EVENT_ID is required")
        return 2
    root = (
        os.environ.get("DERIVATIVES_ROOT")
        or os.environ.get("EMBEDDINGS_ROOT")
        or ""
    ).strip()
    if not root:
        log.error("DERIVATIVES_ROOT (or EMBEDDINGS_ROOT) is required")
        return 2

    force = os.environ.get("FORCE", "") == "1"
    limit = int(os.environ.get("LIMIT", "0") or "0")
    concurrency = int(os.environ.get("OUTFIT_CONCURRENCY", str(DEFAULT_CONCURRENCY)))

    try:
        run(BlobIO(root), siglip.load_encoders(), event_id, force=force, limit=limit, concurrency=concurrency)
        return 0
    except Exception:
        log.exception("prepare failed for event %s", event_id)
        return 1


if __name__ == "__main__":
    sys.exit(main())
