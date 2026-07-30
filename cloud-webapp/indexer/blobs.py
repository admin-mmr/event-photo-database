"""
blobs.py — derivatives writer with local-dir, gs:// and Azure Blob backends.

Layout under <root> (= gs://<proj>-derivatives, az://derivatives, or a local dir
in tests):

    <eventId>/photos/orig/<fileId>.<ext>    # mirrored original
    <eventId>/photos/web/<fileId>.jpg       # ≤1600px serving copy
    <eventId>/photos/thumb/<fileId>.jpg     # ≤320px grid thumbnail
    <eventId>/embeddings/{faces,persons}.npy + manifest.json   (store.py layout)

`DERIVATIVES_ROOT` selects the backend by scheme — see `parse_root`. The cloud
SDKs are imported lazily, so a local run (and the whole test suite) needs neither
installed: CI installs only numpy/Pillow/pytest.

**The URI parsing here is duplicated in `matcher/store.py`** and pinned by
`test_blobs.py::test_uri_parsing_matches_matcher`. The two services are separate
deployables with separate Docker build contexts (the indexer image copies a
hand-listed set of matcher modules — see indexer/Dockerfile), so a shared module
would be one more entry on a list that has already shipped a
ModuleNotFoundError once. Same convention as ORIG_EXT_BY_MIME ↔ origExtParity.
Change one, change both; the parity test will tell you.
"""

from __future__ import annotations

import os
from typing import NamedTuple

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

    `az://` is the terse form that mirrors `gs://` in config; the https form is
    self-describing and needs no extra env var. Both are accepted because the
    deploy scripts favour the short one while a human debugging a run pastes the
    URL they see in the portal.
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
            # Azurite and other emulators put the account name in the FIRST path
            # segment (http://127.0.0.1:10000/devstoreaccount1/...), so the
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


class BlobStore:
    def __init__(self, root: str):
        self.root = root.rstrip("/")
        self.backend, details = parse_root(self.root)
        self._is_gcs = self.backend == "gcs"  # kept: read by existing callers/tests
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

    def read(self, rel: str) -> bytes:
        if self.backend == "gcs":
            return self._bucket.blob(self._key(rel)).download_as_bytes()
        if self.backend == "azure":
            return self._container.get(self._key(rel))
        with open(os.path.join(self.root, rel), "rb") as f:
            return f.read()

    def exists(self, rel: str) -> bool:
        if self.backend == "gcs":
            return self._bucket.blob(self._key(rel)).exists()
        if self.backend == "azure":
            return self._container.has(self._key(rel))
        return os.path.exists(os.path.join(self.root, rel))


class _AzureContainer:
    """The three operations BlobStore needs, and the ONLY place
    `azure.storage.blob` is touched.

    A narrow port rather than the raw ContainerClient (which is what the first
    draft used) so that BlobStore itself imports no SDK on any code path — the
    lazy import is otherwise trivially defeated by needing `ContentSettings` to
    build a write. Mirrors `BlobOps` in `api/src/lib/storage/blobStore.ts`, and
    is what `test_blobs.py` substitutes.
    """

    def __init__(self, container):
        self._c = container

    def put(self, key: str, data: bytes, content_type: str) -> None:
        from azure.storage.blob import ContentSettings

        # overwrite=True is REQUIRED: Azure raises BlobAlreadyExists by default,
        # where GCS's upload_from_string just replaces. Without it a re-index
        # fails on the first photo it had already written — and re-running a
        # partially-failed run is the normal recovery path.
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
    """Build the container port for `root`.

    Auth is the job's **managed identity** (Storage Blob Data Contributor),
    matching the keyless posture on GCP. `AZURE_STORAGE_CONNECTION_STRING` exists
    only for Azurite, which has no Entra identity.
    """
    from azure.storage.blob import BlobServiceClient

    conn = os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "")
    if conn:
        service = BlobServiceClient.from_connection_string(conn)
    else:
        from azure.identity import DefaultAzureCredential

        service = BlobServiceClient(root.account_url, credential=DefaultAzureCredential())
    return _AzureContainer(service.get_container_client(root.container))
