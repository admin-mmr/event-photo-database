"""
blobs.py — derivatives-bucket writer with local-dir and gs:// backends.

Layout under <root> (= gs://<proj>-derivatives or a local dir in tests):

    <eventId>/photos/orig/<fileId>.<ext>    # mirrored original
    <eventId>/photos/web/<fileId>.jpg       # ≤1600px serving copy
    <eventId>/photos/thumb/<fileId>.jpg     # ≤320px grid thumbnail
    <eventId>/embeddings/{faces,persons}.npy + manifest.json   (store.py layout)
"""

from __future__ import annotations

import os


class BlobStore:
    def __init__(self, root: str):
        self.root = root.rstrip("/")
        self._is_gcs = self.root.startswith("gs://")
        if self._is_gcs:
            from google.cloud import storage  # lazy: not needed in tests

            without = self.root[len("gs://"):]
            self._bucket_name, _, self._prefix = without.partition("/")
            self._bucket = storage.Client().bucket(self._bucket_name)

    def _key(self, rel: str) -> str:
        return "/".join(p for p in (getattr(self, "_prefix", ""), rel) if p)

    def write(self, rel: str, data: bytes, content_type: str = "application/octet-stream") -> None:
        if self._is_gcs:
            self._bucket.blob(self._key(rel)).upload_from_string(data, content_type=content_type)
        else:
            path = os.path.join(self.root, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(data)

    def read(self, rel: str) -> bytes:
        if self._is_gcs:
            return self._bucket.blob(self._key(rel)).download_as_bytes()
        with open(os.path.join(self.root, rel), "rb") as f:
            return f.read()

    def exists(self, rel: str) -> bool:
        if self._is_gcs:
            return self._bucket.blob(self._key(rel)).exists()
        return os.path.exists(os.path.join(self.root, rel))
