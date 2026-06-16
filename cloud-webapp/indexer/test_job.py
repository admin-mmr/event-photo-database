"""
test_job.py — indexer unit tests (mocked Drive/Firestore; real local BlobStore).

Run from indexer/:  python -m pytest -v
No model files or GCP credentials needed.
"""

from __future__ import annotations

import io
import json

import numpy as np
import pytest

from blobs import BlobStore
from job import EMB_DIR, FILES, MANIFEST, Config, run

MODEL_V = "test-model@1"
DIM = 8


def _png(color=(200, 50, 50), size=(64, 48)) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


class FakeDrive:
    def __init__(self, files: dict[str, dict]):
        """files: id → {name, relPath, mimeType, md5Checksum, data}"""
        self.files = files
        self.downloads: list[str] = []

    def list_images(self, folder_id: str) -> list[dict]:
        return [{k: v for k, v in f.items() if k != "data"} | {"id": fid}
                for fid, f in self.files.items()]

    def download(self, file_id: str) -> bytes:
        self.downloads.append(file_id)
        return self.files[file_id]["data"]

    def get_folder_name(self, folder_id: str) -> str:
        return self.folder_names.get(folder_id, "")

    folder_names: dict[str, str] = {}


class FakeFS:
    def __init__(self, events: dict | None = None):
        self.events = events or {}
        self.photos: dict[str, dict] = {}
        self.states: list[dict] = []

    def get_event(self, event_id):
        return self.events.get(event_id)

    def set_index_state(self, event_id, state):
        self.states.append(state)

    def set_event_name_if_empty(self, event_id, name):
        ev = self.events.setdefault(event_id, {})
        if not name or str(ev.get("name", "") or "").strip():
            return False
        ev["name"] = name
        return True

    def upsert_photo(self, photo_id, doc):
        self.photos[photo_id] = {**self.photos.get(photo_id, {}), **doc}

    def delete_photo(self, photo_id):
        self.photos.pop(photo_id, None)


def fake_embed(data: bytes) -> dict:
    """Deterministic 1-face + 1-person result keyed on content hash."""
    seed = sum(data[:64]) % 251
    rng = np.random.default_rng(seed)
    return {
        "faces": [{"box": [0, 0, 10, 10], "score": 0.9,
                   "embedding": rng.standard_normal(DIM).astype(np.float32)}],
        "persons": [{"box": [0, 0, 20, 40], "score": 0.8, "source": "detector",
                     "embedding": rng.standard_normal(DIM).astype(np.float32)}],
    }


def drive_file(name: str, md5: str, data: bytes) -> dict:
    return {"name": name, "relPath": name, "mimeType": "image/png",
            "md5Checksum": md5, "modifiedTime": "2026-06-01T00:00:00Z", "data": data}


@pytest.fixture
def env(tmp_path):
    drive = FakeDrive({
        "f1": drive_file("a.png", "md5-a", _png((200, 50, 50))),
        "f2": drive_file("b.png", "md5-b", _png((50, 200, 50))),
    })
    fs = FakeFS(events={"ev1": {"driveFolderId": "folder123"}})
    blobs = BlobStore(str(tmp_path))
    return drive, fs, blobs


def _run(drive, fs, blobs, **kw):
    cfg = Config(event_id="ev1", **{k: v for k, v in kw.items() if k in ("force", "limit", "drive_folder_id")})
    return run(cfg, drive, blobs, fs, fake_embed, model_version=MODEL_V,
               face_dim=DIM, person_dim=DIM)


def test_fresh_index_writes_store_and_derivatives(env):
    drive, fs, blobs = env
    summary = _run(drive, fs, blobs)

    assert summary["photoCount"] == 2 and summary["embedded"] == 2
    manifest = json.loads(blobs.read(f"ev1/{EMB_DIR}/{MANIFEST}"))
    assert manifest["modelVersion"] == MODEL_V
    assert {m["photoId"] for m in manifest["faces"]} == {"f1", "f2"}
    faces = np.load(io.BytesIO(blobs.read(f"ev1/{EMB_DIR}/{FILES['face']}")))
    assert faces.shape == (2, DIM)
    for pid in ("f1", "f2"):
        assert blobs.exists(f"ev1/photos/orig/{pid}.png")
        assert blobs.exists(f"ev1/photos/web/{pid}.jpg")
        assert blobs.exists(f"ev1/photos/thumb/{pid}.jpg")
    assert fs.photos["f1"]["eventId"] == "ev1"
    assert fs.states[-1]["status"] == "done"


def test_rerun_is_idempotent_no_redownload(env):
    drive, fs, blobs = env
    _run(drive, fs, blobs)
    first_faces = blobs.read(f"ev1/{EMB_DIR}/{FILES['face']}")
    drive.downloads.clear()

    summary = _run(drive, fs, blobs)
    assert summary["reused"] == 2 and summary["embedded"] == 0
    assert drive.downloads == []  # nothing re-downloaded
    assert blobs.read(f"ev1/{EMB_DIR}/{FILES['face']}") == first_faces


def test_changed_photo_reembedded_others_reused(env):
    drive, fs, blobs = env
    _run(drive, fs, blobs)
    drive.files["f2"] = drive_file("b.png", "md5-b2", _png((10, 10, 240)))
    drive.downloads.clear()

    summary = _run(drive, fs, blobs)
    assert summary["embedded"] == 1 and summary["reused"] == 1
    assert drive.downloads == ["f2"]


def test_deleted_photo_rows_and_doc_removed(env):
    drive, fs, blobs = env
    _run(drive, fs, blobs)
    del drive.files["f2"]

    summary = _run(drive, fs, blobs)
    assert summary["removed"] == 1 and summary["photoCount"] == 1
    manifest = json.loads(blobs.read(f"ev1/{EMB_DIR}/{MANIFEST}"))
    assert {m["photoId"] for m in manifest["faces"]} == {"f1"}
    assert "f2" not in fs.photos
    faces = np.load(io.BytesIO(blobs.read(f"ev1/{EMB_DIR}/{FILES['face']}")))
    assert faces.shape == (1, DIM)


def test_model_version_bump_full_reembed(env):
    drive, fs, blobs = env
    _run(drive, fs, blobs)
    drive.downloads.clear()

    cfg = Config(event_id="ev1")
    summary = run(cfg, drive, blobs, fs, fake_embed, model_version="test-model@2",
                  face_dim=DIM, person_dim=DIM)
    assert summary["embedded"] == 2 and summary["reused"] == 0
    assert json.loads(blobs.read(f"ev1/{EMB_DIR}/{MANIFEST}"))["modelVersion"] == "test-model@2"


def test_force_reindex(env):
    drive, fs, blobs = env
    _run(drive, fs, blobs)
    drive.downloads.clear()
    summary = _run(drive, fs, blobs, force=True)
    assert summary["embedded"] == 2 and summary["reused"] == 0


def test_undecodable_photo_skipped_not_fatal(env):
    drive, fs, blobs = env
    drive.files["bad"] = drive_file("bad.png", "md5-bad", b"not an image")
    summary = _run(drive, fs, blobs)
    assert summary["skipped"] == 1 and summary["photoCount"] == 2
    assert "bad" not in fs.photos


def test_folder_id_from_firestore_event_doc(env):
    drive, fs, blobs = env
    summary = _run(drive, fs, blobs)  # cfg has no drive_folder_id → from FakeFS
    assert summary["photoCount"] == 2


def test_missing_folder_id_exits(env):
    drive, fs, blobs = env
    fs.events = {}
    with pytest.raises(SystemExit):
        _run(drive, fs, blobs)


def test_matcher_store_can_load_indexer_output(env, monkeypatch, tmp_path):
    """Cross-check: the matcher's EmbeddingStore reads what the indexer wrote."""
    import os
    import sys

    drive, fs, blobs = env
    _run(drive, fs, blobs)

    matcher_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "matcher")
    monkeypatch.syspath_prepend(matcher_dir)
    sys.modules.pop("store", None)  # indexer has no store.py, but be safe
    from store import EmbeddingStore

    ev = EmbeddingStore(blobs.root).load_event("ev1")
    hits = ev.top_k("face", np.ones(DIM, np.float32), k=2)
    assert len(hits) == 2 and {h["photoId"] for h in hits} == {"f1", "f2"}


def test_event_name_backfilled_from_drive_folder_when_empty(env):
    """B5: a nameless event gets named from its Drive folder during indexing."""
    drive, fs, blobs = env
    drive.folder_names = {"folder123": "Spring Run 2026"}
    _run(drive, fs, blobs)
    assert fs.events["ev1"]["name"] == "Spring Run 2026"


def test_event_name_not_clobbered_when_already_set(env):
    """B5: an admin/Sheet-provided name is preserved, not overwritten."""
    drive, fs, blobs = env
    fs.events["ev1"]["name"] = "Custom Admin Name"
    drive.folder_names = {"folder123": "Spring Run 2026"}
    _run(drive, fs, blobs)
    assert fs.events["ev1"]["name"] == "Custom Admin Name"


def test_byte_identical_duplicates_collapse_to_one_photo(tmp_path):
    """B6: two files with the same content hash → one indexed photo + audit."""
    dup_bytes = _png((123, 222, 11))
    drive = FakeDrive({
        # f1 and f3 are byte-identical (same md5) — f3 should be dropped.
        "f1": drive_file("a.png", "md5-dup", dup_bytes),
        "f2": drive_file("b.png", "md5-b", _png((10, 10, 240))),
        "f3": drive_file("c.png", "md5-dup", dup_bytes),
    })
    fs = FakeFS(events={"ev1": {"driveFolderId": "folder123"}})
    blobs = BlobStore(str(tmp_path))

    summary = _run(drive, fs, blobs)

    # Canonical = first in relPath order ("a.png" → f1); f3 collapsed into it.
    assert summary["photoCount"] == 2
    assert summary["duplicates"] == 1
    assert set(fs.photos.keys()) == {"f1", "f2"}
    assert "f3" not in fs.photos
    assert fs.photos["f1"]["duplicateCount"] == 1
    assert fs.photos["f1"]["contentHash"] == "md5-dup"
    # The duplicate's bytes were never downloaded twice.
    assert drive.downloads.count("f3") == 0

    manifest = json.loads(blobs.read(f"ev1/{EMB_DIR}/{MANIFEST}"))
    assert manifest["duplicates"] == {"f1": ["f3"]}
