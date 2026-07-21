"""
store.py — flat-file embedding store + in-memory cosine search.

Zero-cost vector store (decision 2026-06-09, see SETUP_NOTES.md / runbook
Phase F). Per-event layout, local dir or GCS:

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

EMB_SUBDIR = "embeddings"
FILES = {"face": "faces.npy", "person": "persons.npy"}
MANIFEST = "manifest.json"


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


class EventEmbeddings:
    """One event's vectors + manifest, ready to query."""

    def __init__(self, manifest: dict, faces: np.ndarray, persons: np.ndarray):
        self.manifest = manifest
        self.vectors = {"face": faces, "person": persons}
        self.meta = {"face": manifest.get("faces", []), "person": manifest.get("persons", [])}
        for kind in ("face", "person"):
            n_vec, n_meta = len(self.vectors[kind]), len(self.meta[kind])
            if n_vec != n_meta:
                raise ValueError(
                    f"manifest/{kind} length mismatch: {n_meta} meta rows vs {n_vec} vectors"
                )

    def embeddings_for_photo(self, kind: str, photo_id: str) -> np.ndarray:
        """Every `kind` ('face'|'person') crop vector belonging to `photo_id`.

        Returns a [n, dim] array (n = number of that photo's crops; rows are the
        stored L2-normalized embeddings). Empty [0, dim] if the photo has no
        crops of that kind. Used for pseudo-relevance feedback (§1.2): a photo
        the user confirmed is a clean in-domain reference, so its own embeddings
        are folded back into the query."""
        vecs = self.vectors[kind]
        rows = [i for i, m in enumerate(self.meta[kind]) if m.get("photoId") == photo_id]
        if not rows:
            dim = vecs.shape[1] if vecs.ndim == 2 else 0
            return np.zeros((0, dim), dtype=np.float32)
        return vecs[rows]

    def top_k(
        self, kind: str, query: np.ndarray, k: int | None = 50, tnorm: bool = False
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
        fusion threshold and cross-modality blend compare."""
        vecs = self.vectors[kind]
        if vecs.size == 0:
            return []
        q = np.asarray(query, dtype=np.float32).reshape(-1)
        q = q / max(np.linalg.norm(q), 1e-12)
        sims = vecs @ q
        if tnorm:
            sims = (sims - float(sims.mean())) / max(float(sims.std()), 1e-6)
        n = len(sims)
        if k is None or k >= n:
            idx = np.argsort(-sims)
        else:
            k = max(k, 1)
            idx = np.argpartition(-sims, k - 1)[:k]
            idx = idx[np.argsort(-sims[idx])]
        return [{**self.meta[kind][i], "row": int(i), "score": float(sims[i])} for i in idx]

    def top_photos(
        self, kind: str, query: np.ndarray, k: int | None = 50, tnorm: bool = False
    ) -> list[dict]:
        """Per-photo results: max crop score per photo, best first. `k=None`
        returns every photo ranked (no cap) — the caller is expected to gate
        the list some other way (e.g. the fused score threshold). `tnorm` is
        forwarded to `top_k` (see there)."""
        pool = None if k is None else max(k * 4, 200)
        best: dict[str, dict] = {}
        for hit in self.top_k(kind, query, k=pool, tnorm=tnorm):
            pid = hit["photoId"]
            if pid not in best or hit["score"] > best[pid]["score"]:
                best[pid] = hit
        ranked = sorted(best.values(), key=lambda h: -h["score"])
        return ranked if k is None else ranked[:k]


class EmbeddingStore:
    """Loads + caches EventEmbeddings from a local dir or a GCS bucket.

    root = "/path/to/dir"  or  "gs://bucket[/prefix]"
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
        if self.root.startswith("gs://"):
            blobs = self._read_gcs(event_id)
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
