"""
test_blobs.py — BlobStore backend selection, URI parsing, and the Azure writer.

No cloud SDK is installed in CI (`pip install numpy Pillow pytest`), which is the
point: the SDKs must stay behind lazy imports so a local run and this suite never
need them. The Azure backend is exercised by injecting a fake container client,
which also keeps the test honest about WHICH SDK calls are made — `overwrite=True`
on upload is the one that matters.
"""

from __future__ import annotations

import os
import sys

import pytest

from blobs import AzureRoot, BlobStore, _AzureContainer, parse_root

ACCT = "https://myacct.blob.core.windows.net"


# ── URI parsing ──────────────────────────────────────────────────────────────

def test_local_path_is_the_default():
    assert parse_root("/tmp/derivs") == ("local", "/tmp/derivs")
    assert parse_root("relative/dir") == ("local", "relative/dir")


def test_gcs_splits_bucket_and_prefix():
    assert parse_root("gs://bkt") == ("gcs", ("bkt", ""))
    assert parse_root("gs://bkt/pre/fix") == ("gcs", ("bkt", "pre/fix"))


def test_trailing_slash_is_ignored():
    # DERIVATIVES_ROOT is hand-edited in deploy scripts and env vars; a stray
    # slash must not produce a "//" in every object key.
    assert parse_root("gs://bkt/") == ("gcs", ("bkt", ""))
    assert parse_root(f"{ACCT}/derivatives/")[1] == AzureRoot(ACCT, "derivatives", "")


def test_az_scheme_needs_the_account_url(monkeypatch):
    monkeypatch.delenv("AZURE_STORAGE_ACCOUNT_URL", raising=False)
    # Failing loudly beats defaulting to some account: a silent default would
    # write a whole event's derivatives into the wrong storage account.
    with pytest.raises(ValueError, match="AZURE_STORAGE_ACCOUNT_URL"):
        parse_root("az://derivatives")


def test_az_scheme_mirrors_gs(monkeypatch):
    monkeypatch.setenv("AZURE_STORAGE_ACCOUNT_URL", ACCT)
    assert parse_root("az://derivatives")[1] == AzureRoot(ACCT, "derivatives", "")
    assert parse_root("az://derivatives/pre")[1] == AzureRoot(ACCT, "derivatives", "pre")


def test_https_form_is_self_describing():
    kind, details = parse_root(f"{ACCT}/derivatives/pre/fix")
    assert kind == "azure"
    assert details == AzureRoot(ACCT, "derivatives", "pre/fix")


def test_azurite_account_lives_in_the_first_path_segment():
    # http://127.0.0.1:10000/devstoreaccount1/derivatives — if the account is not
    # folded into the account URL, every blob key is off by one segment and the
    # emulator run writes to a container called "devstoreaccount1".
    kind, details = parse_root("http://127.0.0.1:10000/devstoreaccount1/derivatives/pre")
    assert kind == "azure"
    assert details == AzureRoot("http://127.0.0.1:10000/devstoreaccount1", "derivatives", "pre")


def test_a_url_with_no_container_is_rejected():
    with pytest.raises(ValueError, match="no container"):
        parse_root(ACCT)
    with pytest.raises(ValueError, match="storage account"):
        parse_root("http://127.0.0.1:10000")


def test_uri_parsing_matches_matcher(monkeypatch):
    """The indexer writes what the matcher reads, so the two parsers must agree.

    They are duplicated on purpose (separate deployables, separate Docker build
    contexts — see the module docstring), which is exactly why this test exists.
    """
    matcher_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "matcher")
    sys.path.insert(0, matcher_dir)
    try:
        import store as matcher_store
    finally:
        sys.path.remove(matcher_dir)

    monkeypatch.setenv("AZURE_STORAGE_ACCOUNT_URL", ACCT)
    for root in (
        "/tmp/derivs",
        "gs://bkt",
        "gs://bkt/pre",
        "az://derivatives",
        "az://derivatives/pre",
        f"{ACCT}/derivatives",
        f"{ACCT}/derivatives/pre/fix",
        "http://127.0.0.1:10000/devstoreaccount1/derivatives",
    ):
        mine, theirs = parse_root(root), matcher_store.parse_root(root)
        assert mine[0] == theirs[0], root
        # blobs.py returns a NamedTuple for azure, store.py a plain tuple. Compare
        # as tuples where both are tuples, and by value for the local-dir string.
        mine_v = tuple(mine[1]) if isinstance(mine[1], tuple) else mine[1]
        theirs_v = tuple(theirs[1]) if isinstance(theirs[1], tuple) else theirs[1]
        assert mine_v == theirs_v, root


# ── the local backend still works ────────────────────────────────────────────

def test_local_roundtrip(tmp_path):
    store = BlobStore(str(tmp_path))
    assert store.backend == "local"
    assert not store.exists("e1/photos/thumb/p1.jpg")
    store.write("e1/photos/thumb/p1.jpg", b"bytes", "image/jpeg")
    assert store.exists("e1/photos/thumb/p1.jpg")
    assert store.read("e1/photos/thumb/p1.jpg") == b"bytes"


# ── the Azure backend, over a fake container port ────────────────────────────

class FakeSdkContainer:
    """The real ContainerClient surface `_AzureContainer` calls, in Azure's own
    terms — so the port's translation (overwrite, ContentSettings, readall) is
    exercised rather than assumed."""

    def __init__(self):
        self.blobs: dict[str, bytes] = {}
        self.uploads: list[dict] = []

    def upload_blob(self, name, data, overwrite=False, content_settings=None):
        if name in self.blobs and not overwrite:
            # What the service actually does, and the reason overwrite=True is
            # not optional here.
            raise RuntimeError("BlobAlreadyExists")
        self.blobs[name] = data
        self.uploads.append(
            {"name": name, "overwrite": overwrite,
             "content_type": getattr(content_settings, "content_type", None)}
        )

    def download_blob(self, name):
        return _FakeDownload(self.blobs[name])

    def get_blob_client(self, name):
        return _FakeBlobClient(self, name)


class _FakeDownload:
    def __init__(self, data: bytes):
        self._data = data

    def readall(self) -> bytes:
        return self._data


class _FakeBlobClient:
    def __init__(self, container: FakeSdkContainer, name: str):
        self._container, self._name = container, name

    def exists(self) -> bool:
        return self._name in self._container.blobs


class FakeContentSettings:
    """Stands in for azure.storage.blob.ContentSettings, which is not installed."""

    def __init__(self, content_type=None):
        self.content_type = content_type


def _port(sdk_container) -> object:
    """`_AzureContainer` wrapping `sdk_container`, with the SDK's ContentSettings
    swapped for a stub — the module imports it lazily inside put()."""
    import sys
    import types

    mod = types.ModuleType("azure.storage.blob")
    mod.ContentSettings = FakeContentSettings  # type: ignore[attr-defined]
    pkg_azure = sys.modules.setdefault("azure", types.ModuleType("azure"))
    pkg_storage = sys.modules.setdefault("azure.storage", types.ModuleType("azure.storage"))
    pkg_azure.storage = pkg_storage  # type: ignore[attr-defined]
    pkg_storage.blob = mod  # type: ignore[attr-defined]
    sys.modules["azure.storage.blob"] = mod
    return _AzureContainer(sdk_container)


@pytest.fixture()
def azure_store(monkeypatch):
    monkeypatch.setenv("AZURE_STORAGE_ACCOUNT_URL", ACCT)
    sdk = FakeSdkContainer()
    monkeypatch.setattr("blobs._azure_container", lambda root: _port(sdk))
    return BlobStore("az://derivatives"), sdk


def test_azure_roundtrip(azure_store):
    store, container = azure_store
    assert store.backend == "azure"
    assert not store.exists("e1/photos/web/p1.jpg")
    store.write("e1/photos/web/p1.jpg", b"jpegbytes", "image/jpeg")
    assert store.exists("e1/photos/web/p1.jpg")
    assert store.read("e1/photos/web/p1.jpg") == b"jpegbytes"


def test_azure_write_overwrites(azure_store):
    # THE behavioural difference from GCS: upload_blob defaults to raising
    # BlobAlreadyExists, where upload_from_string replaces. A re-index re-writes
    # derivatives it has already written, and re-running a partially-failed run is
    # the normal recovery path — so without overwrite=True the second run dies on
    # the first photo.
    store, container = azure_store
    store.write("e1/photos/web/p1.jpg", b"first", "image/jpeg")
    store.write("e1/photos/web/p1.jpg", b"second", "image/jpeg")
    assert store.read("e1/photos/web/p1.jpg") == b"second"
    assert all(u["overwrite"] is True for u in container.uploads)


def test_azure_write_sets_the_content_type(azure_store):
    # The gallery serves these blobs straight to an <img>; without a content type
    # the browser gets application/octet-stream and offers a download instead.
    store, container = azure_store
    store.write("e1/photos/thumb/p1.jpg", b"x", "image/jpeg")
    assert container.uploads[-1]["content_type"] == "image/jpeg"


def test_azure_applies_the_prefix(monkeypatch):
    monkeypatch.setenv("AZURE_STORAGE_ACCOUNT_URL", ACCT)
    sdk = FakeSdkContainer()
    monkeypatch.setattr("blobs._azure_container", lambda root: _port(sdk))
    store = BlobStore("az://derivatives/staging")
    store.write("e1/photos/web/p1.jpg", b"x")
    assert "staging/e1/photos/web/p1.jpg" in sdk.blobs
