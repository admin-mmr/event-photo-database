"""
store.py — flat-file embedding store + in-memory cosine search.

Zero-cost vector store (decision 2026-06-09, see SETUP_NOTES.md / runbook
Phase F). Per-event layout, local dir / GCS / Azure Blob:

    <root>/<event_id>/embeddings/faces.npy      # float32 [N, dim], L2-normalized rows
    <root>/<event_id>/embeddings/persons.npy    # float32 [M, dim]
    <root>/<event_id>/embeddings/manifest.json  # row → photoId/box/score + model info

Search is brute-force cosine similarity (dot product on normalized vectors) —
milliseconds at per-event scale (a few thousand photos). Events are cached
in memory for the instance lifetime; the indexer bumping `model_version`
implies new files + cache invalidation on the next deploy/restart.
"""

from __future__ import annotations

import json
import os
import threading

import numpy as np

import quality as quality_mod

EMB_SUBDIR = "embeddings"
FILES = {"face": "faces.npy", "person": "persons.npy"}
MANIFEST = "manifest.json"

AZURE_SUFFIX = ".blob.core.windows.net"


def parse_root(root: str) -> tuple[str, object]:
    """Classify `root` → ("local" | "gcs" | "azure", details).

    Recognized forms:

        gs://bucket[/prefix]
        az://container[/prefix]                     + AZURE_STORAGE_ACCOUNT_URL
        https://<acct>.blob.core.windows.net/container[/prefix]
        http://127.0.0.1:10000/devstoreaccount1/container[/prefix]   (Azurite)
        /any/local/path

    **Duplicated verbatim in `indexer/blobs.py`**, which is the writer to this
    reader — the two are separate deployables with separate Docker build contexts
    (the indexer image copies a hand-listed set of matcher modules), so a shared
    module would be one more entry on a list that has already shipped a
    ModuleNotFoundError once. `indexer/test_blobs.py` pins the two in sync.
    Change one, change both.

    For azure, details is (account_url, container, prefix).
    """
    root = root.rstrip("/")
    if root.startswith("gs://"):
        bucket, _, prefix = root[len("gs://") :].partition("/")
        return "gcs", (bucket, prefix)
    if root.startswith("az://"):
        account_url = os.environ.get("AZURE_STORAGE_ACCOUNT_URL", "").rstrip("/")
        if not account_url:
            raise ValueError(
                "az:// root needs AZURE_STORAGE_ACCOUNT_URL "
                "(e.g. https://myacct.blob.core.windows.net)"
            )
        container, _, prefix = root[len("az://") :].partition("/")
        return "azure", (account_url, container, prefix)
    if root.startswith(("https://", "http://")):
        scheme, _, rest = root.partition("://")
        netloc, _, path = rest.partition("/")
        if netloc.endswith(AZURE_SUFFIX):
            account_url = f"{scheme}://{netloc}"
        else:
            # Azurite puts the account name in the FIRST path segment, so the
            # account URL has to swallow it or every blob path is off by one.
            account, _, path = path.partition("/")
            if not account:
                raise ValueError(f"cannot find the storage account in {root!r}")
            account_url = f"{scheme}://{netloc}/{account}"
        container, _, prefix = path.partition("/")
        if not container:
            raise ValueError(f"no container in {root!r}")
        return "azure", (account_url, container, prefix)
    return "local", root


def build_manifest(event_id: str, model_version: str, faces_meta: list[dict], persons_meta: list[dict]) -> dict:
    """Manifest rows are parallel to the .npy rows for each kind.
    Each row: {photoId, box: [x1,y1,x2,y2], score, ...extra}."""
    return {
        "version": 1,
        "eventId": event_id,
        "modelVersion": model_version,
        "faces": faces_meta,
        "persons": persons_meta,
    }


def write_local(dir_path: str, manifest: dict, faces: np.ndarray, persons: np.ndarray) -> None:
    """Write the three files to <dir_path>/embeddings/."""
    emb_dir = os.path.join(dir_path, EMB_SUBDIR)
    os.makedirs(emb_dir, exist_ok=True)
    np.save(os.path.join(emb_dir, FILES["face"]), faces.astype(np.float32))
    np.save(os.path.join(emb_dir, FILES["person"]), persons.astype(np.float32))
    with open(os.path.join(emb_dir, MANIFEST), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False)


def _iso_to_epoch_ms(iso: str | None) -> int | None:
    """Parse the manifest's `takenAt` (ISO-8601, usually zone-less e.g.
    '2026-06-20T14:30:52') → epoch milliseconds, or None. A zone-less value is
    treated as UTC to match the query anchor convention in
    `pipeline.read_capture_time_ms`; the absolute offset cancels in the
    query↔candidate delta as long as both use the same convention."""
    if not iso:
        return None
    from datetime import datetime, timezone

    try:
        dt = datetime.fromisoformat(str(iso))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except Exception:
        return None


class EventEmbeddings:
    """One event's vectors + manifest, ready to query."""

    def __init__(self, manifest: dict, faces: np.ndarray, persons: np.ndarray):
        self.manifest = manifest
        self.vectors = {"face": faces, "person": persons}
        self.meta = {"face": manifest.get("faces", []), "person": manifest.get("persons", [])}
        # Per-photo metadata (photoId → {takenAt, md5, ...}); written by the
        # indexer. Used for capture-time-conditional outfit fusion. Absent in
        # manifests built by build_manifest() → taken_at_ms() returns None.
        self.photos = manifest.get("photos", {})
        for kind in ("face", "person"):
            n_vec, n_meta = len(self.vectors[kind]), len(self.meta[kind])
            if n_vec != n_meta:
                raise ValueError(
                    f"manifest/{kind} length mismatch: {n_meta} meta rows vs {n_vec} vectors"
                )
        # photoId → its row indices, per kind. Built once here because the
        # anchor/PRF paths look rows up per photoId and a linear scan of every
        # meta row per lookup is O(crops × lookups) on the hot search path.
        self._rows_by_photo: dict[str, dict[str, list[int]]] = {"face": {}, "person": {}}
        for kind in ("face", "person"):
            for i, m in enumerate(self.meta[kind]):
                self._rows_by_photo[kind].setdefault(str(m.get("photoId")), []).append(i)
        # Lazily built per-row attenuation vectors, keyed by (kind, weight).
        self._quality_cache: dict[tuple[str, float], np.ndarray] = {}

    def taken_at_ms(self, photo_id: str) -> int | None:
        """Capture time (epoch ms) for a photo from the manifest `photos` map,
        or None if unknown. Anchor for capture-time-conditional outfit fusion —
        the indexer already resolves `takenAt` per photo (EXIF → Drive metadata),
        so this needs no new manifest field and no re-index."""
        rec = self.photos.get(photo_id)
        return _iso_to_epoch_ms(rec.get("takenAt")) if rec else None

    def rows_for_photo(self, kind: str, photo_id: str) -> list[int]:
        """Row indices of `photo_id`'s `kind` crops (empty list if it has none).

        Rows — not just vectors — because the anchor path needs each crop's
        metadata (box, quality) alongside its embedding."""
        return list(self._rows_by_photo[kind].get(str(photo_id), ()))

    def face_count(self, photo_id: str) -> int:
        """How many faces the indexer found in this photo. The cheap "is this a
        solo shot or a crowd?" signal behind anchor suggestion — a solo photo's
        matched crop cannot be somebody else's face."""
        return len(self._rows_by_photo["face"].get(str(photo_id), ()))

    def crop_meta(self, kind: str, row: int) -> dict:
        """Manifest metadata for one crop row ({photoId, box, score, quality?})."""
        return self.meta[kind][row]

    def embeddings_for_photo(self, kind: str, photo_id: str) -> np.ndarray:
        """Every `kind` ('face'|'person') crop vector belonging to `photo_id`.

        Returns a [n, dim] array (n = number of that photo's crops; rows are the
        stored L2-normalized embeddings). Empty [0, dim] if the photo has no
        crops of that kind. Used for pseudo-relevance feedback (§1.2): a photo
        the user confirmed is a clean in-domain reference, so its own embeddings
        are folded back into the query."""
        vecs = self.vectors[kind]
        rows = self.rows_for_photo(kind, photo_id)
        if not rows:
            dim = vecs.shape[1] if vecs.ndim == 2 else 0
            return np.zeros((0, dim), dtype=np.float32)
        return vecs[rows]

    def quality_factors(self, kind: str, weight: float) -> np.ndarray:
        """Per-row score multipliers in [1 - weight, 1.0] from each crop's stored
        quality (Item 5). `weight` 0.0 → all ones (feature off).

        Cached per (kind, weight): the manifest is immutable for the instance
        lifetime, so this is computed once per event rather than per search."""
        key = (kind, float(weight))
        cached = self._quality_cache.get(key)
        if cached is not None:
            return cached
        n = len(self.meta[kind])
        if weight <= 0:
            factors = np.ones(n, dtype=np.float32)
        else:
            terms = np.empty(n, dtype=np.float32)
            for i, m in enumerate(self.meta[kind]):
                q = m.get("quality") or {}
                terms[i] = quality_mod.quality_term(q.get("frontality"), q.get("face_frac"))
            factors = (1.0 - weight * (1.0 - terms)).astype(np.float32)
        self._quality_cache[key] = factors
        return factors

    def top_k(
        self,
        kind: str,
        query: np.ndarray,
        k: int | None = 50,
        tnorm: bool = False,
        quality_weight: float = 0.0,
    ) -> list[dict]:
        """Cosine top-k crops for `kind` ('face'|'person').
        Returns [{photoId, score, row, ...meta}], best first. Vectors are
        L2-normalized so cosine similarity = dot product. `k=None` returns
        every crop, fully sorted (used when the caller wants no cap).

        `tnorm=True` applies test-normalization (§1.3): each raw cosine is
        turned into a z-score against the event's own crops as the background
        cohort — (sim - mean) / std over all `kind` vectors. This removes the
        per-query bias where a "generic-looking" face scores moderately high
        against everyone, so a single threshold behaves the same for distinctive
        and generic queries. The transform is affine (monotonic), so it never
        changes single-query ordering — it only rescales the scores that the
        fusion threshold and cross-modality blend compare.

        `quality_weight > 0` additionally attenuates each crop's score by its own
        stored quality (Item 5) — a small, side-on face must score higher than a
        clean frontal one to rank alongside it. Applied AFTER T-norm (the knob
        belongs in z-space, where the threshold lives) and only to positive
        scores: scaling a negative z toward zero would *promote* a bad crop."""
        vecs = self.vectors[kind]
        if vecs.size == 0:
            return []
        if k is not None and k <= 0:
            return []  # "no results", not "one result" (see the max(k, 1) below)
        q = np.asarray(query, dtype=np.float32).reshape(-1)
        q = q / max(np.linalg.norm(q), 1e-12)
        sims = vecs @ q
        if tnorm:
            sims = (sims - float(sims.mean())) / max(float(sims.std()), 1e-6)
        if quality_weight > 0:
            sims = np.where(sims > 0, sims * self.quality_factors(kind, quality_weight), sims)
        n = len(sims)
        if k is None or k >= n:
            idx = np.argsort(-sims)
        else:
            k = max(k, 1)
            idx = np.argpartition(-sims, k - 1)[:k]
            idx = idx[np.argsort(-sims[idx])]
        return [{**self.meta[kind][i], "row": int(i), "score": float(sims[i])} for i in idx]

    def top_photos(
        self,
        kind: str,
        query: np.ndarray,
        k: int | None = 50,
        tnorm: bool = False,
        quality_weight: float = 0.0,
    ) -> list[dict]:
        """Per-photo results: max crop score per photo, best first. `k=None`
        returns every photo ranked (no cap) — the caller is expected to gate
        the list some other way (e.g. the fused score threshold). `tnorm` and
        `quality_weight` are forwarded to `top_k` (see there); attenuation
        happens before the per-photo max, so a group shot is still represented by
        its best face rather than being penalized as a whole."""
        pool = None if k is None else max(k * 4, 200)
        best = self._best_crop_per_photo(kind, query, pool, tnorm, quality_weight)
        # `pool` caps CROPS, not photos. A photo with many crops (a big group
        # shot) can fill the pool and crowd distinct photos out, returning fewer
        # than `k`. Only then — and only if the pool actually held anything back
        # — rescan uncapped, so the common case keeps the cheap partial sort.
        if k is not None and len(best) < k and pool is not None and pool < len(self.meta[kind]):
            best = self._best_crop_per_photo(kind, query, None, tnorm, quality_weight)
        ranked = sorted(best.values(), key=lambda h: -h["score"])
        return ranked if k is None else ranked[:k]

    def _best_crop_per_photo(
        self,
        kind: str,
        query: np.ndarray,
        pool: int | None,
        tnorm: bool,
        quality_weight: float = 0.0,
    ) -> dict[str, dict]:
        """photoId → its highest-scoring crop, over the top `pool` crops."""
        best: dict[str, dict] = {}
        for hit in self.top_k(kind, query, k=pool, tnorm=tnorm, quality_weight=quality_weight):
            pid = hit["photoId"]
            if pid not in best or hit["score"] > best[pid]["score"]:
                best[pid] = hit
        return best


class EmbeddingStore:
    """Loads + caches EventEmbeddings from a local dir, GCS, or Azure Blob.

    root = "/path/to/dir" | "gs://bucket[/prefix]" | "az://container[/prefix]"
           | "https://<acct>.blob.core.windows.net/container[/prefix]"

    Read-only: the indexer writes these files (indexer/blobs.py), the matcher
    only loads them. The cloud SDKs are imported lazily, so a local run needs
    neither installed.
    """

    def __init__(self, root: str):
        self.root = root.rstrip("/")
        self._cache: dict[str, EventEmbeddings] = {}
        self._lock = threading.Lock()

    def load_event(self, event_id: str) -> EventEmbeddings:
        ev = self._cache.get(event_id)
        if ev is not None:
            return ev
        with self._lock:
            ev = self._cache.get(event_id)
            if ev is None:
                ev = self._load(event_id)
                self._cache[event_id] = ev
            return ev

    def invalidate(self, event_id: str | None = None) -> None:
        with self._lock:
            if event_id is None:
                self._cache.clear()
            else:
                self._cache.pop(event_id, None)

    # ── backends ────────────────────────────────────────────────────────────

    def _load(self, event_id: str) -> EventEmbeddings:
        backend, details = parse_root(self.root)
        if backend == "gcs":
            blobs = self._read_gcs(event_id)
        elif backend == "azure":
            blobs = self._read_azure(event_id, details)  # type: ignore[arg-type]
        else:
            blobs = self._read_local(event_id)
        import io

        manifest = json.loads(blobs[MANIFEST].decode("utf-8"))
        faces = np.load(io.BytesIO(blobs[FILES["face"]]))
        persons = np.load(io.BytesIO(blobs[FILES["person"]]))
        return EventEmbeddings(manifest, faces, persons)

    def _read_local(self, event_id: str) -> dict[str, bytes]:
        emb_dir = os.path.join(self.root, event_id, EMB_SUBDIR)
        out = {}
        for name in (MANIFEST, FILES["face"], FILES["person"]):
            path = os.path.join(emb_dir, name)
            if not os.path.exists(path):
                raise FileNotFoundError(f"event '{event_id}' not indexed: missing {path}")
            with open(path, "rb") as f:
                out[name] = f.read()
        return out

    def _read_gcs(self, event_id: str) -> dict[str, bytes]:
        from google.cloud import storage  # lazy: not needed for local/test runs

        without_scheme = self.root[len("gs://") :]
        bucket_name, _, prefix = without_scheme.partition("/")
        client = storage.Client()
        bucket = client.bucket(bucket_name)
        base = "/".join(p for p in (prefix, event_id, EMB_SUBDIR) if p)
        out = {}
        for name in (MANIFEST, FILES["face"], FILES["person"]):
            blob = bucket.blob(f"{base}/{name}")
            if not blob.exists():
                raise FileNotFoundError(
                    f"event '{event_id}' not indexed: gs://{bucket_name}/{base}/{name} missing"
                )
            out[name] = blob.download_as_bytes()
        return out

    def _read_azure(self, event_id: str, details: tuple[str, str, str]) -> dict[str, bytes]:
        account_url, container_name, prefix = details
        container = _azure_container(account_url, container_name)
        base = "/".join(p for p in (prefix, event_id, EMB_SUBDIR) if p)
        out = {}
        for name in (MANIFEST, FILES["face"], FILES["person"]):
            blob = container.get_blob_client(f"{base}/{name}")
            if not blob.exists():
                raise FileNotFoundError(
                    f"event '{event_id}' not indexed: {account_url}/{container_name}/{base}/{name} missing"
                )
            out[name] = blob.download_blob().readall()
        return out


def _azure_container(account_url: str, container: str):
    """A ContainerClient. Auth is the service's **managed identity** (Storage Blob
    Data Reader is enough — the matcher never writes), matching the keyless
    posture on GCP. `AZURE_STORAGE_CONNECTION_STRING` exists only for Azurite,
    which has no Entra identity."""
    from azure.storage.blob import BlobServiceClient

    conn = os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "")
    if conn:
        service = BlobServiceClient.from_connection_string(conn)
    else:
        from azure.identity import DefaultAzureCredential

        service = BlobServiceClient(account_url, credential=DefaultAzureCredential())
    return service.get_container_client(container)
