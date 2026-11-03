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
import os

import numpy as np
import pytest

import store as store_mod
from store import EMB_SUBDIR, FILES, MANIFEST, EmbeddingStore, parse_root

ACCT = "https://myacct.blob.core.windows.net"
DIM = 4


def _manifest(photos: int = 1) -> dict:
    return {
        "version": 1,
        "eventId": "e1",
        "modelVersion": "test@1",
        "faces": [{"photoId": f"p{i}", "box": [0, 0, 10, 10], "score": 0.9} for i in range(1, photos + 1)],
        "persons": [{"photoId": f"p{i}", "box": [0, 0, 20, 20], "score": 0.8} for i in range(1, photos + 1)],
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

class FakeNotFound(Exception):
    """Stands in for azure.core's ResourceNotFoundError (status_code 404)."""

    status_code = 404


class FakeProps:
    def __init__(self, etag: str):
        self.etag = etag


class FakeBlobClient:
    def __init__(self, blobs: dict[str, bytes], name: str):
        self._blobs, self._name = blobs, name

    def exists(self) -> bool:
        return self._name in self._blobs

    def download_blob(self):
        return FakeDownload(self._blobs[self._name])

    def get_blob_properties(self):
        if self._name not in self._blobs:
            raise FakeNotFound(self._name)
        # Content-derived, so a rewrite with different bytes changes the ETag.
        return FakeProps(f'"{hash(self._blobs[self._name]) & 0xFFFFFFFF:x}"')


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
    return EmbeddingStore("az://derivatives", spawn=_inline), blobs, container


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
        f"e1/{EMB_SUBDIR}/{MANIFEST}",  # the version check (properties only)
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
    assert len(container.requested) == 4  # one version check + one pass, not two


def test_invalidate_forces_a_reload(azure):
    store, blobs, container = azure
    _seed(blobs, f"e1/{EMB_SUBDIR}")
    store.load_event("e1")
    store.invalidate("e1")
    store.load_event("e1")
    assert len(container.requested) == 8


# ── a warm instance notices a re-index (no restart) ──────────────────────────
#
# `event-scale.sh up` holds the matcher at min-instances=1, so an instance can
# outlive many index runs. It used to serve its FIRST load forever: new photos
# never matched and deleted ones came back. These pin the lazy version check.

def _inline(fn) -> None:
    """Run a background reload synchronously, so a test sees its result at once."""
    fn()


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def _write_local_event(root, photos: int, mtime_ns: int) -> None:
    emb = root / "e1" / EMB_SUBDIR
    emb.mkdir(parents=True, exist_ok=True)
    (emb / FILES["face"]).write_bytes(_npy(photos))
    (emb / FILES["person"]).write_bytes(_npy(photos))
    (emb / MANIFEST).write_text(json.dumps(_manifest(photos)), encoding="utf-8")
    # Pin the mtime: two writes inside one filesystem tick must still differ.
    os.utime(emb / MANIFEST, ns=(mtime_ns, mtime_ns))


@pytest.fixture()
def local(tmp_path, monkeypatch):
    """A local store with a fake clock that counts full loads."""
    clock = Clock()
    store = EmbeddingStore(str(tmp_path), check_sec=60, clock=clock, spawn=_inline)
    loads = []
    real_load = store._load
    monkeypatch.setattr(store, "_load", lambda eid: loads.append(eid) or real_load(eid))
    return store, tmp_path, clock, loads


def test_a_reindexed_event_is_reloaded_after_the_check_interval(local):
    store, root, clock, loads = local
    _write_local_event(root, photos=1, mtime_ns=1_000_000_000)
    assert len(store.load_event("e1").meta["face"]) == 1

    _write_local_event(root, photos=3, mtime_ns=2_000_000_000)  # the indexer re-ran
    clock.t += 59
    assert len(store.load_event("e1").meta["face"]) == 1  # inside the window: cached
    clock.t += 2
    assert len(store.load_event("e1").meta["face"]) == 3  # stale -> reloaded
    assert loads == ["e1", "e1"]


def test_an_unchanged_event_stays_cached(local, monkeypatch):
    store, root, clock, loads = local
    _write_local_event(root, photos=1, mtime_ns=1_000_000_000)
    first = store.load_event("e1")
    checks = []
    real_version = store._version
    monkeypatch.setattr(store, "_version", lambda eid: checks.append(eid) or real_version(eid))

    store.load_event("e1")  # inside the window: no metadata read at all
    assert checks == []
    for _ in range(3):
        clock.t += 61
        assert store.load_event("e1") is first
    assert checks == ["e1"] * 3  # one cheap check per interval...
    assert loads == ["e1"]  # ...and never a second download


def test_a_deleted_store_stops_being_served(local):
    store, root, clock, _loads = local
    _write_local_event(root, photos=1, mtime_ns=1_000_000_000)
    store.load_event("e1")
    (root / "e1" / EMB_SUBDIR / MANIFEST).unlink()
    clock.t += 61
    with pytest.raises(FileNotFoundError, match="not indexed"):
        store.load_event("e1")


def test_a_reload_that_fails_keeps_the_last_good_copy(local):
    # The indexer writes both .npy files and THEN the manifest, but a reload can
    # still catch a mismatched set (or a transient read error). Serve the old
    # store and retry next interval rather than failing the search.
    store, root, clock, loads = local
    _write_local_event(root, photos=1, mtime_ns=1_000_000_000)
    first = store.load_event("e1")
    emb = root / "e1" / EMB_SUBDIR
    (emb / MANIFEST).write_text(json.dumps(_manifest(3)), encoding="utf-8")  # vectors still 1 row
    os.utime(emb / MANIFEST, ns=(2_000_000_000, 2_000_000_000))
    clock.t += 61
    assert store.load_event("e1") is first

    _write_local_event(root, photos=3, mtime_ns=3_000_000_000)  # the write completes
    clock.t += 61
    assert len(store.load_event("e1").meta["face"]) == 3


def _write_half_written_event(root, mtime_ns: int) -> None:
    """New 3-row vectors, old 1-row manifest: the indexer between its writes."""
    emb = root / "e1" / EMB_SUBDIR
    emb.mkdir(parents=True, exist_ok=True)
    (emb / FILES["face"]).write_bytes(_npy(3))
    (emb / FILES["person"]).write_bytes(_npy(3))
    (emb / MANIFEST).write_text(json.dumps(_manifest(1)), encoding="utf-8")
    os.utime(emb / MANIFEST, ns=(mtime_ns, mtime_ns))


def test_a_first_load_mid_write_waits_for_the_write_to_finish(tmp_path):
    # No cached copy to serve, so a first load used to 500 on this
    # (matcher-00035, 2026-11-02). It now waits and retries.
    _write_half_written_event(tmp_path, mtime_ns=1_000_000_000)
    sleeps = []

    def sleep(sec):
        sleeps.append(sec)
        _write_local_event(tmp_path, photos=3, mtime_ns=2_000_000_000)  # the manifest lands

    store = EmbeddingStore(str(tmp_path), check_sec=60, clock=Clock(), sleep=sleep)
    assert len(store.load_event("e1").meta["face"]) == 3
    assert len(sleeps) == 1
    # The cache recorded the version it actually loaded, so no extra reload.
    assert store._cache["e1"].version == store._version("e1")


def test_a_first_load_that_stays_broken_still_fails(tmp_path):
    _write_half_written_event(tmp_path, mtime_ns=1_000_000_000)
    sleeps = []
    store = EmbeddingStore(str(tmp_path), check_sec=60, clock=Clock(), sleep=sleeps.append)
    with pytest.raises(ValueError, match="length mismatch"):
        store.load_event("e1")
    assert len(sleeps) == store_mod.COLD_LOAD_RETRIES


def test_a_missing_event_is_not_retried(tmp_path):
    sleeps = []
    store = EmbeddingStore(str(tmp_path), check_sec=60, clock=Clock(), sleep=sleeps.append)
    with pytest.raises(FileNotFoundError):
        store.load_event("e1")
    assert sleeps == []


def test_a_failed_version_check_serves_the_cached_copy(local, monkeypatch):
    store, root, clock, _loads = local
    _write_local_event(root, photos=1, mtime_ns=1_000_000_000)
    first = store.load_event("e1")

    def boom(eid):
        raise OSError("metadata read failed")

    monkeypatch.setattr(store, "_version", boom)
    clock.t += 61
    assert store.load_event("e1") is first


def test_azure_reloads_on_a_new_etag_only(azure):
    store, blobs, container = azure
    store._clock = clock = Clock()
    _seed(blobs, f"e1/{EMB_SUBDIR}")
    store.load_event("e1")
    clock.t += 61
    store.load_event("e1")
    assert len(container.requested) == 5  # check + load, then one more check

    base = f"e1/{EMB_SUBDIR}"
    blobs[f"{base}/{FILES['face']}"] = _npy(2)
    blobs[f"{base}/{FILES['person']}"] = _npy(2)
    blobs[f"{base}/{MANIFEST}"] = json.dumps(_manifest(2)).encode("utf-8")
    clock.t += 61
    assert len(store.load_event("e1").meta["face"]) == 2
    assert len(container.requested) == 9  # check + a full reload


# ── GCS: the version is the manifest's generation ────────────────────────────

class FakeGcsBlob:
    def __init__(self, bucket: "FakeBucket", name: str):
        self._bucket, self.name = bucket, name

    @property
    def generation(self):
        return self._bucket.generations[self.name]

    def exists(self) -> bool:
        return self.name in self._bucket.objects

    def download_as_bytes(self) -> bytes:
        self._bucket.downloads.append(self.name)
        return self._bucket.objects[self.name]


class FakeBucket:
    def __init__(self, name: str):
        self.name = name
        self.objects: dict[str, bytes] = {}
        self.generations: dict[str, int] = {}
        self.downloads: list[str] = []

    def put(self, key: str, data: bytes) -> None:
        self.objects[key] = data
        self.generations[key] = self.generations.get(key, 0) + 1

    def blob(self, name: str) -> FakeGcsBlob:
        return FakeGcsBlob(self, name)

    def get_blob(self, name: str):
        return FakeGcsBlob(self, name) if name in self.objects else None


class FakeGcsClient:
    def __init__(self, bucket: FakeBucket):
        self._bucket = bucket

    def bucket(self, name: str) -> FakeBucket:
        assert name == self._bucket.name
        return self._bucket


def test_gcs_reloads_on_a_new_generation_only():
    bucket = FakeBucket("derivs")
    base = f"pre/e1/{EMB_SUBDIR}"

    def index(photos: int) -> None:
        bucket.put(f"{base}/{FILES['face']}", _npy(photos))
        bucket.put(f"{base}/{FILES['person']}", _npy(photos))
        bucket.put(f"{base}/{MANIFEST}", json.dumps(_manifest(photos)).encode("utf-8"))

    clock = Clock()
    store = EmbeddingStore("gs://derivs/pre", check_sec=60, clock=clock, spawn=_inline)
    store._gcs_client = FakeGcsClient(bucket)
    index(1)
    assert len(store.load_event("e1").meta["face"]) == 1
    clock.t += 61
    store.load_event("e1")
    assert len(bucket.downloads) == 3  # unchanged generation: no re-download

    index(4)  # an admin delete / volunteer upload re-ran the indexer
    clock.t += 61
    assert len(store.load_event("e1").meta["face"]) == 4
    assert len(bucket.downloads) == 6


# ── a changed store reloads in the background ────────────────────────────────
#
# 2026-11-03, NYC Marathon: the store is ~930 MiB and the indexer rewrote it
# every ~10 min, so the search that noticed each rewrite waited 25–51s for the
# reload (48 of 460 searches over 15s), close to the 60s Hosting cutoff.

class Deferred:
    """A spawn that holds reloads until the test runs them."""

    def __init__(self):
        self.jobs = []

    def __call__(self, fn) -> None:
        self.jobs.append(fn)

    def run(self) -> None:
        jobs, self.jobs = self.jobs, []
        for fn in jobs:
            fn()


@pytest.fixture()
def deferred(tmp_path):
    clock, spawn = Clock(), Deferred()
    store = EmbeddingStore(str(tmp_path), check_sec=60, clock=clock, spawn=spawn)
    return store, tmp_path, clock, spawn


def test_the_search_that_notices_a_new_store_is_answered_from_the_old_one(deferred):
    store, root, clock, spawn = deferred
    _write_local_event(root, photos=1, mtime_ns=1_000_000_000)
    first = store.load_event("e1")

    _write_local_event(root, photos=3, mtime_ns=2_000_000_000)
    clock.t += 61
    assert store.load_event("e1") is first  # not made to wait for the download
    assert len(spawn.jobs) == 1

    clock.t += 61
    assert store.load_event("e1") is first  # a reload is under way: no second one
    assert len(spawn.jobs) == 1

    spawn.run()
    assert len(store.load_event("e1").meta["face"]) == 3


def test_a_background_reload_that_fails_keeps_serving_and_frees_the_next_check(deferred):
    store, root, clock, spawn = deferred
    _write_local_event(root, photos=1, mtime_ns=1_000_000_000)
    first = store.load_event("e1")
    emb = root / "e1" / EMB_SUBDIR
    (emb / MANIFEST).write_text(json.dumps(_manifest(3)), encoding="utf-8")  # vectors still 1 row
    os.utime(emb / MANIFEST, ns=(2_000_000_000, 2_000_000_000))
    clock.t += 61
    store.load_event("e1")
    spawn.run()
    assert store.load_event("e1") is first

    _write_local_event(root, photos=3, mtime_ns=3_000_000_000)  # the write completes
    clock.t += 61
    store.load_event("e1")  # the lock came back, so this check can start a reload
    spawn.run()
    assert len(store.load_event("e1").meta["face"]) == 3


def test_a_reload_that_cannot_start_still_answers(deferred):
    store, root, clock, _spawn = deferred
    _write_local_event(root, photos=1, mtime_ns=1_000_000_000)
    first = store.load_event("e1")

    def no_threads(fn):
        raise RuntimeError("can't start new thread")

    store._spawn = no_threads
    _write_local_event(root, photos=3, mtime_ns=2_000_000_000)
    clock.t += 61
    assert store.load_event("e1") is first
    store._spawn = _inline
    clock.t += 61
    assert len(store.load_event("e1").meta["face"]) == 3  # the lock was released


def test_a_first_load_still_waits_for_the_store(deferred):
    store, root, _clock, spawn = deferred
    _write_local_event(root, photos=2, mtime_ns=1_000_000_000)
    assert len(store.load_event("e1").meta["face"]) == 2  # nothing cached to serve
    assert spawn.jobs == []


def test_the_default_spawn_reloads_on_a_thread(tmp_path):
    clock = Clock()
    store = EmbeddingStore(str(tmp_path), check_sec=60, clock=clock)
    _write_local_event(tmp_path, photos=1, mtime_ns=1_000_000_000)
    store.load_event("e1")
    _write_local_event(tmp_path, photos=3, mtime_ns=2_000_000_000)
    clock.t += 61
    store.load_event("e1")
    with store._lock:  # taken only once the reload thread has let go of it
        pass
    assert len(store.load_event("e1").meta["face"]) == 3

