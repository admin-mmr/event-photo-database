"""
test_store.py — EmbeddingStore backend selection and the Azure read path (AZ2).

The matcher only READS what the indexer wrote, so these cases are the mirror of
`indexer/test_blobs.py`. No cloud SDK is needed: the backends are behind lazy
imports and the Azure one is exercised through an injected fake container.

`parse_root` is duplicated in `indexer/blobs.py` on purpose (separate deployables
with separate Docker build contexts) and pinned in sync by
`indexer/test_blobs.py::test_uri_parsing_matches_matcher`.
"""

from __future__ import annotations

import io
import json

import numpy as np
import pytest

import store as store_mod
from store import EMB_SUBDIR, FILES, MANIFEST, EmbeddingStore, parse_root

ACCT = "https://myacct.blob.core.windows.net"
DIM = 4


def _manifest() -> dict:
    return {
        "version": 1,
        "eventId": "e1",
        "modelVersion": "test@1",
        "faces": [{"photoId": "p1", "box": [0, 0, 10, 10], "score": 0.9}],
        "persons": [{"photoId": "p1", "box": [0, 0, 20, 20], "score": 0.8}],
    }


def _npy(rows: int) -> bytes:
    buf = io.BytesIO()
    arr = np.zeros((rows, DIM), dtype=np.float32)
    arr[:, 0] = 1.0
    np.save(buf, arr)
    return buf.getvalue()


# ── URI parsing (see indexer/blobs.py for the shared spec) ───────────────────

def test_local_and_gcs_forms():
    assert parse_root("/tmp/embeds") == ("local", "/tmp/embeds")
    assert parse_root("gs://bkt/pre") == ("gcs", ("bkt", "pre"))


def test_azure_forms(monkeypatch):
    monkeypatch.setenv("AZURE_STORAGE_ACCOUNT_URL", ACCT)
    assert parse_root("az://derivatives/pre") == ("azure", (ACCT, "derivatives", "pre"))
    assert parse_root(f"{ACCT}/derivatives") == ("azure", (ACCT, "derivatives", ""))
    # Azurite keeps the account in the first path segment.
    assert parse_root("http://127.0.0.1:10000/devstoreaccount1/derivatives") == (
        "azure",
        ("http://127.0.0.1:10000/devstoreaccount1", "derivatives", ""),
    )


def test_az_scheme_without_the_account_url_is_an_error(monkeypatch):
    monkeypatch.delenv("AZURE_STORAGE_ACCOUNT_URL", raising=False)
    with pytest.raises(ValueError, match="AZURE_STORAGE_ACCOUNT_URL"):
        parse_root("az://derivatives")


# ── the local backend still works ────────────────────────────────────────────

def test_local_load(tmp_path):
    emb = tmp_path / "e1" / EMB_SUBDIR
    emb.mkdir(parents=True)
    (emb / MANIFEST).write_text(json.dumps(_manifest()), encoding="utf-8")
    (emb / FILES["face"]).write_bytes(_npy(1))
    (emb / FILES["person"]).write_bytes(_npy(1))

    ev = EmbeddingStore(str(tmp_path)).load_event("e1")
    assert ev.manifest["eventId"] == "e1"
    assert ev.vectors["face"].shape == (1, DIM)


def test_a_missing_local_event_says_not_indexed(tmp_path):
    with pytest.raises(FileNotFoundError, match="not indexed"):
        EmbeddingStore(str(tmp_path)).load_event("nope")


# ── the Azure read path ──────────────────────────────────────────────────────

class FakeBlobClient:
    def __init__(self, blobs: dict[str, bytes], name: str):
        self._blobs, self._name = blobs, name

    def exists(self) -> bool:
        return self._name in self._blobs

    def download_blob(self):
        return FakeDownload(self._blobs[self._name])


class FakeDownload:
    def __init__(self, data: bytes):
        self._data = data

    def readall(self) -> bytes:
        return self._data


class FakeContainer:
    def __init__(self, blobs: dict[str, bytes]):
        self.blobs = blobs
        self.requested: list[str] = []

    def get_blob_client(self, name):
        self.requested.append(name)
        return FakeBlobClient(self.blobs, name)


@pytest.fixture()
def azure(monkeypatch):
    """An EmbeddingStore on az://derivatives, over a fake container."""
    monkeypatch.setenv("AZURE_STORAGE_ACCOUNT_URL", ACCT)
    blobs: dict[str, bytes] = {}
    container = FakeContainer(blobs)
    monkeypatch.setattr(store_mod, "_azure_container", lambda account_url, name: container)
    return EmbeddingStore("az://derivatives"), blobs, container


def _seed(blobs: dict[str, bytes], base: str) -> None:
    blobs[f"{base}/{MANIFEST}"] = json.dumps(_manifest()).encode("utf-8")
    blobs[f"{base}/{FILES['face']}"] = _npy(1)
    blobs[f"{base}/{FILES['person']}"] = _npy(1)


def test_azure_load(azure):
    store, blobs, _container = azure
    _seed(blobs, f"e1/{EMB_SUBDIR}")
    ev = store.load_event("e1")
    assert ev.manifest["eventId"] == "e1"
    assert ev.vectors["face"].shape == (1, DIM)
    assert ev.vectors["person"].shape == (1, DIM)


def test_azure_keys_match_the_indexer_layout(azure):
    # The matcher reads exactly what indexer/blobs.py wrote:
    # <prefix>/<eventId>/embeddings/{manifest.json,faces.npy,persons.npy}.
    store, blobs, container = azure
    _seed(blobs, f"e1/{EMB_SUBDIR}")
    store.load_event("e1")
    assert container.requested == [
        f"e1/{EMB_SUBDIR}/{MANIFEST}",
        f"e1/{EMB_SUBDIR}/{FILES['face']}",
        f"e1/{EMB_SUBDIR}/{FILES['person']}",
    ]


def test_azure_applies_the_prefix(monkeypatch):
    monkeypatch.setenv("AZURE_STORAGE_ACCOUNT_URL", ACCT)
    blobs: dict[str, bytes] = {}
    container = FakeContainer(blobs)
    monkeypatch.setattr(store_mod, "_azure_container", lambda account_url, name: container)
    _seed(blobs, f"staging/e1/{EMB_SUBDIR}")
    EmbeddingStore("az://derivatives/staging").load_event("e1")
    assert container.requested[0].startswith("staging/")


def test_a_missing_azure_event_says_not_indexed(azure):
    # The api turns this into "event not indexed yet" rather than a 500, so the
    # exception TYPE matters as much as the message.
    store, _blobs, _container = azure
    with pytest.raises(FileNotFoundError, match="not indexed"):
        store.load_event("nope")


def test_a_half_written_event_is_not_indexed(azure):
    # The indexer writes the store only at the END of a run, but a killed run or a
    # partial delete can leave the manifest without its vectors. Loading that as
    # "indexed" would raise a length-mismatch deep inside EventEmbeddings.
    store, blobs, _container = azure
    blobs[f"e1/{EMB_SUBDIR}/{MANIFEST}"] = json.dumps(_manifest()).encode("utf-8")
    with pytest.raises(FileNotFoundError, match="not indexed"):
        store.load_event("e1")


def test_azure_events_are_cached(azure):
    # The matcher scales to zero, so the first request after idle pays the load;
    # every later one must not.
    store, blobs, container = azure
    _seed(blobs, f"e1/{EMB_SUBDIR}")
    store.load_event("e1")
    store.load_event("e1")
    assert len(container.requested) == 3  # one pass, not two


def test_invalidate_forces_a_reload(azure):
    store, blobs, container = azure
    _seed(blobs, f"e1/{EMB_SUBDIR}")
    store.load_event("e1")
    store.invalidate("e1")
    store.load_event("e1")
    assert len(container.requested) == 6
