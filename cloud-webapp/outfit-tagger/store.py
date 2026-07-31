"""
store.py — the outfit-tagger's own flat-file vector store, and blob IO.

Layout, a deliberate SIBLING of the matcher's store under the same derivatives
root — never inside it:

    <root>/<eventId>/embeddings/{faces,persons}.npy + manifest.json   # matcher, read-only
    <root>/<eventId>/photos/orig/<photoId>.<ext>                      # indexer, read-only
    <root>/<eventId>/outfit/crops.npy                                 # ours: float32 [N, dim]
    <root>/<eventId>/outfit/index.json                                # ours: row → photoId/region/box

Nothing the matcher reads is written by this service, so the matcher needs no
redeploy, cannot be broken by a bad prepare run, and a rollback here is just
deleting `outfit/`. The two files we DO read (`embeddings/manifest.json` for the
boxes, the mirrored originals for pixels) are immutable artifacts of a completed
index run.

`sourceModelVersion` in the index records which matcher `modelVersion` supplied
the boxes. A later re-index under a new version shifts boxes slightly, which is
harmless for ranking but worth being able to *see* — so drift is recorded rather
than hidden.

**`parse_root` is duplicated from `matcher/store.py` / `indexer/blobs.py`** and
pinned by `test_store.py::test_uri_parsing_matches_matcher`. Same reason as those
two: separate deployables with separate Docker build contexts, where a shared
module is one more thing a hand-kept COPY list can silently omit (that failure
has shipped once already — see CLAUDE.md). Change one, change all three; the
parity test will tell you.
"""

from __future__ import annotations

import io
import json
import os
import threading
from typing import NamedTuple

import numpy as np

OUTFIT_SUBDIR = "outfit"
CROPS_FILE = "crops.npy"
INDEX_FILE = "index.json"
EMB_SUBDIR = "embeddings"
MANIFEST_FILE = "manifest.json"

AZURE_SUFFIX = ".blob.core.windows.net"


class AzureRoot(NamedTuple):
    """A parsed Azure Blob root."""

    account_url: str
    container: str
    prefix: str


def parse_root(root: str) -> tuple[str, object]:
    """Classify `root` → ("local" | "gcs" | "azure", details).

    Recognized forms:

        gs://bucket[/prefix]
        az://container[/prefix]                     + AZURE_STORAGE_ACCOUNT_URL
        https://<acct>.blob.core.windows.net/container[/prefix]
        http://127.0.0.1:10000/devstoreaccount1/container[/prefix]   (Azurite)
        /any/local/path

    For azure, details is an AzureRoot.
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
        return "azure", AzureRoot(account_url, container, prefix)
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
        return "azure", AzureRoot(account_url, container, prefix)
    return "local", root


class BlobIO:
    """read / write / exists against a local dir, GCS, or Azure Blob.

    Cloud SDKs are imported lazily so the whole test suite runs with neither
    installed — same posture as `indexer/blobs.py`.
    """

    def __init__(self, root: str):
        self.root = root.rstrip("/")
        self.backend, details = parse_root(self.root)
        if self.backend == "gcs":
            from google.cloud import storage  # lazy: not needed in tests

            self._bucket_name, self._prefix = details  # type: ignore[misc]
            self._bucket = storage.Client().bucket(self._bucket_name)
        elif self.backend == "azure":
            assert isinstance(details, AzureRoot)
            self._prefix = details.prefix
            self._container = _azure_container(details)

    def _key(self, rel: str) -> str:
        return "/".join(p for p in (getattr(self, "_prefix", ""), rel) if p)

    def read(self, rel: str) -> bytes:
        if self.backend == "gcs":
            return self._bucket.blob(self._key(rel)).download_as_bytes()
        if self.backend == "azure":
            return self._container.get(self._key(rel))
        with open(os.path.join(self.root, rel), "rb") as f:
            return f.read()

    def write(self, rel: str, data: bytes, content_type: str = "application/octet-stream") -> None:
        if self.backend == "gcs":
            self._bucket.blob(self._key(rel)).upload_from_string(data, content_type=content_type)
        elif self.backend == "azure":
            self._container.put(self._key(rel), data, content_type)
        else:
            path = os.path.join(self.root, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(data)

    def exists(self, rel: str) -> bool:
        if self.backend == "gcs":
            return self._bucket.blob(self._key(rel)).exists()
        if self.backend == "azure":
            return self._container.has(self._key(rel))
        return os.path.exists(os.path.join(self.root, rel))


class _AzureContainer:
    """The three operations BlobIO needs, and the ONLY place
    `azure.storage.blob` is touched — a narrow port so BlobIO itself imports no
    SDK on any code path. Mirrors `indexer/blobs._AzureContainer`."""

    def __init__(self, container):
        self._c = container

    def put(self, key: str, data: bytes, content_type: str) -> None:
        from azure.storage.blob import ContentSettings

        # overwrite=True is REQUIRED: Azure raises BlobAlreadyExists by default
        # where GCS just replaces, and re-running a partially-failed prepare is
        # the normal recovery path.
        self._c.upload_blob(
            name=key,
            data=data,
            overwrite=True,
            content_settings=ContentSettings(content_type=content_type),
        )

    def get(self, key: str) -> bytes:
        return self._c.download_blob(key).readall()

    def has(self, key: str) -> bool:
        return self._c.get_blob_client(key).exists()


def _azure_container(root: AzureRoot) -> _AzureContainer:
    """Container port for `root`. Auth is the service's managed identity
    (Storage Blob Data Contributor for the job, Reader is enough for the
    service), matching the keyless posture on GCP.
    `AZURE_STORAGE_CONNECTION_STRING` exists only for Azurite."""
    from azure.storage.blob import BlobServiceClient

    conn = os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "")
    if conn:
        service = BlobServiceClient.from_connection_string(conn)
    else:
        from azure.identity import DefaultAzureCredential

        service = BlobServiceClient(root.account_url, credential=DefaultAzureCredential())
    return _AzureContainer(service.get_container_client(root.container))


# ── paths ────────────────────────────────────────────────────────────────────


def outfit_path(event_id: str, name: str) -> str:
    return f"{event_id}/{OUTFIT_SUBDIR}/{name}"


def manifest_path(event_id: str) -> str:
    return f"{event_id}/{EMB_SUBDIR}/{MANIFEST_FILE}"


def load_matcher_manifest(blobs: BlobIO, event_id: str) -> dict:
    """The indexer's manifest, our source of boxes and per-photo mimeType.

    Read-only. A missing manifest means the event was never indexed, which is a
    precondition failure for this service rather than something it can repair.
    """
    rel = manifest_path(event_id)
    if not blobs.exists(rel):
        raise FileNotFoundError(
            f"event '{event_id}' has no matcher manifest ({rel}) — index the event first"
        )
    return json.loads(blobs.read(rel).decode("utf-8"))


# ── the outfit index ─────────────────────────────────────────────────────────


def build_index(
    event_id: str,
    model_version: str,
    source_model_version: str,
    rows: list[dict],
    photos: int,
    skipped: list[dict] | None = None,
) -> dict:
    """Index rows are parallel to the crops.npy rows.
    Each row: {photoId, region, box, small}."""
    return {
        "version": 1,
        "eventId": event_id,
        "modelVersion": model_version,
        "sourceModelVersion": source_model_version,
        "photos": photos,
        "rows": rows,
        "skipped": skipped or [],
    }


def write_outfit(blobs: BlobIO, event_id: str, index: dict, vectors: np.ndarray) -> None:
    """Write crops.npy + index.json.

    The vectors go FIRST: a run that dies between the two writes leaves an index
    that is simply absent, so `OutfitStore` reports "not prepared" and a re-run
    fixes it. The reverse order would advertise an index whose vectors do not
    exist yet, which reads as corruption instead of as unprepared.
    """
    buf = io.BytesIO()
    np.save(buf, vectors.astype(np.float32))
    blobs.write(outfit_path(event_id, CROPS_FILE), buf.getvalue(), "application/octet-stream")
    blobs.write(
        outfit_path(event_id, INDEX_FILE),
        json.dumps(index, ensure_ascii=False).encode("utf-8"),
        "application/json",
    )


class OutfitIndex:
    """One event's crop vectors + row metadata, ready to score."""

    def __init__(self, index: dict, vectors: np.ndarray):
        self.index = index
        self.vectors = vectors
        self.rows: list[dict] = index.get("rows", [])
        self.model_version: str = index.get("modelVersion", "")
        self.source_model_version: str = index.get("sourceModelVersion", "")
        if len(self.rows) != len(self.vectors):
            raise ValueError(
                f"index/vector length mismatch: {len(self.rows)} rows vs {len(self.vectors)} vectors"
            )
        self._rows_by_photo: dict[str, list[int]] = {}
        for i, r in enumerate(self.rows):
            self._rows_by_photo.setdefault(str(r.get("photoId")), []).append(i)

    def __len__(self) -> int:
        return len(self.rows)

    @property
    def dim(self) -> int:
        return int(self.vectors.shape[1]) if self.vectors.ndim == 2 else 0

    def rows_for_photo(self, photo_id: str) -> list[int]:
        return list(self._rows_by_photo.get(str(photo_id), ()))

    def region_mask(self, region: str | None, include_small: bool) -> np.ndarray:
        """Boolean mask over rows for a region filter ('person' | 'head' | None
        for both), optionally excluding crops flagged too small to be meaningful.

        A row with no `small` key is treated as NOT small — absent means
        unmeasured, and an index written before the flag existed must keep
        behaving as it did rather than having every row silently excluded.
        """
        mask = np.ones(len(self.rows), dtype=bool)
        for i, r in enumerate(self.rows):
            if region is not None and r.get("region") != region:
                mask[i] = False
            elif not include_small and r.get("small") is True:
                mask[i] = False
        return mask

    def sims(self, query: np.ndarray) -> np.ndarray:
        """Cosine similarity of every row against `query` (rows are unit
        vectors, so this is a dot product)."""
        if self.vectors.size == 0:
            return np.zeros((0,), dtype=np.float32)
        q = np.asarray(query, dtype=np.float32).reshape(-1)
        q = q / max(float(np.linalg.norm(q)), 1e-12)
        return (self.vectors @ q).astype(np.float32)

    def vectors_for_photo(self, photo_id: str, region: str | None = None) -> np.ndarray:
        """A photo's stored crop vectors — how a sample given as a photoId costs
        no inference at all, since its embedding is already a row here."""
        rows = [
            i
            for i in self.rows_for_photo(photo_id)
            if region is None or self.rows[i].get("region") == region
        ]
        if not rows:
            return np.zeros((0, self.dim), dtype=np.float32)
        return self.vectors[rows]


class OutfitStore:
    """Loads + caches OutfitIndex per event, for the instance lifetime.

    Read-only from the service's point of view — `job.py` is the writer. Cached
    because an event's index is immutable between prepare runs; `invalidate` is
    the hook a re-prepare needs (the service is not notified, so in practice a
    re-prepared event is picked up by the next instance).
    """

    def __init__(self, root: str):
        self.root = root.rstrip("/")
        self._blobs = BlobIO(self.root)
        self._cache: dict[str, OutfitIndex] = {}
        self._lock = threading.Lock()

    @property
    def blobs(self) -> BlobIO:
        return self._blobs

    def is_prepared(self, event_id: str) -> bool:
        return self._blobs.exists(outfit_path(event_id, INDEX_FILE))

    def load_event(self, event_id: str) -> OutfitIndex:
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

    def _load(self, event_id: str) -> OutfitIndex:
        index_rel = outfit_path(event_id, INDEX_FILE)
        crops_rel = outfit_path(event_id, CROPS_FILE)
        if not self._blobs.exists(index_rel):
            raise FileNotFoundError(
                f"event '{event_id}' is not prepared: missing {index_rel} — "
                "run the outfit-prepare job for it"
            )
        index = json.loads(self._blobs.read(index_rel).decode("utf-8"))
        vectors = np.load(io.BytesIO(self._blobs.read(crops_rel)))
        return OutfitIndex(index, vectors)
