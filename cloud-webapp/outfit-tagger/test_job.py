"""Tests for the prepare job: crop selection, ordering, skips, and idempotence."""

from __future__ import annotations

import io
import json
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import job as job_mod  # noqa: E402
from store import BlobIO, INDEX_FILE, OutfitStore, manifest_path, outfit_path  # noqa: E402

DIM = 4


class CountingVision:
    """Records each crop it is handed, so the test can assert what got embedded."""

    dim = DIM

    def __init__(self):
        self.shapes: list[tuple[int, int]] = []

    def embed(self, crop):
        self.shapes.append(crop.shape[:2])
        vec = np.zeros(DIM, dtype=np.float32)
        vec[len(self.shapes) % DIM] = 1.0
        return vec


class FakeBundle:
    def __init__(self, version="siglip_test@o1"):
        self.vision = CountingVision()
        self.text = None
        self.version = version
        self.dim = DIM


def _jpeg(width=200, height=160, value=128) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (width, height), (value, value, value)).save(buf, format="JPEG")
    return buf.getvalue()


def _setup(tmp_path, manifest: dict, photos: dict[str, bytes]) -> BlobIO:
    blobs = BlobIO(str(tmp_path))
    blobs.write(manifest_path("e1"), json.dumps(manifest).encode("utf-8"), "application/json")
    for photo_id, data in photos.items():
        blobs.write(f"e1/photos/orig/{photo_id}.jpg", data, "image/jpeg")
    return blobs


BASE_MANIFEST = {
    "modelVersion": "m1",
    "persons": [{"photoId": "p1", "box": [10, 10, 90, 150]}],
    "faces": [{"photoId": "p1", "box": [30, 20, 70, 60]}],
    "photos": {"p1": {"mimeType": "image/jpeg"}},
}


def test_prepare_embeds_person_and_head_crops(tmp_path):
    blobs = _setup(tmp_path, BASE_MANIFEST, {"p1": _jpeg()})
    bundle = FakeBundle()
    summary = job_mod.run(blobs, bundle, "e1")

    assert summary["status"] == "done"
    assert summary["crops"] == 2
    assert summary["photos"] == 1
    assert summary["skipped"] == 0
    assert summary["sourceModelVersion"] == "m1"

    ev = OutfitStore(str(tmp_path)).load_event("e1")
    assert [r["region"] for r in ev.rows] == ["person", "head"]
    assert len(ev.vectors) == 2
    # The head crop is wider than the face box it came from (ears + headwear).
    head = next(r for r in ev.rows if r["region"] == "head")
    assert head["box"][2] - head["box"][0] > 40


def test_the_original_is_decoded_once_for_both_crops(tmp_path):
    """Both crops of a photo come from one read + one decode. If this regresses,
    a prepare run doubles its IO and decode cost for no benefit."""
    blobs = _setup(tmp_path, BASE_MANIFEST, {"p1": _jpeg()})
    reads: list[str] = []
    original_read = blobs.read

    def counting_read(rel):
        reads.append(rel)
        return original_read(rel)

    blobs.read = counting_read  # type: ignore[method-assign]
    job_mod.run(blobs, FakeBundle(), "e1")
    assert reads.count("e1/photos/orig/p1.jpg") == 1


def test_rows_are_deterministic_across_runs(tmp_path):
    manifest = {
        "modelVersion": "m1",
        "persons": [
            {"photoId": "p1", "box": [0, 0, 50, 100]},
            {"photoId": "p2", "box": [0, 0, 50, 100]},
            {"photoId": "p3", "box": [0, 0, 50, 100]},
        ],
        "faces": [{"photoId": "p2", "box": [10, 10, 40, 40]}],
        "photos": {p: {"mimeType": "image/jpeg"} for p in ("p1", "p2", "p3")},
    }
    photos = {p: _jpeg(value=i * 20) for i, p in enumerate(("p1", "p2", "p3"))}
    blobs = _setup(tmp_path, manifest, photos)

    job_mod.run(blobs, FakeBundle(), "e1")
    first = [
        (r["photoId"], r["region"]) for r in OutfitStore(str(tmp_path)).load_event("e1").rows
    ]
    job_mod.run(blobs, FakeBundle(), "e1", force=True)
    second = [
        (r["photoId"], r["region"]) for r in OutfitStore(str(tmp_path)).load_event("e1").rows
    ]

    assert first == second
    assert first == [("p1", "person"), ("p2", "person"), ("p3", "person"), ("p2", "head")]


def test_missing_original_is_skipped_not_fatal(tmp_path):
    """Boxes are in original-image coordinates and the manifest records no
    original dimensions, so with no mirrored original there is no sound way to
    place them on another copy. Skipping is correct; guessing would crop the
    wrong region."""
    blobs = _setup(tmp_path, BASE_MANIFEST, {})
    summary = job_mod.run(blobs, FakeBundle(), "e1")
    assert summary["crops"] == 0
    assert summary["skipped"] == 1
    index = json.loads(blobs.read(outfit_path("e1", INDEX_FILE)).decode("utf-8"))
    assert index["skipped"][0]["reason"] == "orig_missing"


def test_undecodable_original_is_skipped_not_fatal(tmp_path):
    blobs = _setup(tmp_path, BASE_MANIFEST, {"p1": b"not a jpeg"})
    summary = job_mod.run(blobs, FakeBundle(), "e1")
    assert summary["crops"] == 0
    assert summary["skipped"] == 1
    index = json.loads(blobs.read(outfit_path("e1", INDEX_FILE)).decode("utf-8"))
    assert index["skipped"][0]["reason"] == "decode_failed"


def test_one_bad_photo_does_not_lose_the_good_ones(tmp_path):
    manifest = {
        "modelVersion": "m1",
        "persons": [
            {"photoId": "good", "box": [0, 0, 50, 100]},
            {"photoId": "bad", "box": [0, 0, 50, 100]},
        ],
        "faces": [],
        "photos": {"good": {"mimeType": "image/jpeg"}, "bad": {"mimeType": "image/jpeg"}},
    }
    blobs = _setup(tmp_path, manifest, {"good": _jpeg(), "bad": b"junk"})
    summary = job_mod.run(blobs, FakeBundle(), "e1")
    assert summary["crops"] == 1
    assert summary["skipped"] == 1
    rows = OutfitStore(str(tmp_path)).load_event("e1").rows
    assert [r["photoId"] for r in rows] == ["good"]


def test_tiny_crops_are_flagged_small_but_still_embedded(tmp_path):
    manifest = {
        "modelVersion": "m1",
        "persons": [{"photoId": "p1", "box": [0, 0, 8, 8]}],
        "faces": [],
        "photos": {"p1": {"mimeType": "image/jpeg"}},
    }
    blobs = _setup(tmp_path, manifest, {"p1": _jpeg()})
    job_mod.run(blobs, FakeBundle(), "e1")
    rows = OutfitStore(str(tmp_path)).load_event("e1").rows
    assert rows[0]["small"] is True
    assert len(OutfitStore(str(tmp_path)).load_event("e1").vectors) == 1


def test_degenerate_box_is_skipped(tmp_path):
    manifest = {
        "modelVersion": "m1",
        "persons": [{"photoId": "p1", "box": [10, 10, 10, 10]}],
        "faces": [],
        "photos": {"p1": {"mimeType": "image/jpeg"}},
    }
    blobs = _setup(tmp_path, manifest, {"p1": _jpeg()})
    summary = job_mod.run(blobs, FakeBundle(), "e1")
    assert summary["crops"] == 0
    assert summary["skipped"] == 1


def test_rerun_skips_an_already_prepared_event(tmp_path):
    blobs = _setup(tmp_path, BASE_MANIFEST, {"p1": _jpeg()})
    job_mod.run(blobs, FakeBundle(), "e1")
    bundle = FakeBundle()
    summary = job_mod.run(blobs, bundle, "e1")
    assert summary["status"] == "skipped"
    assert summary["reason"] == "already_prepared"
    assert bundle.vision.shapes == [], "no crop should be re-embedded"


def test_force_redoes_a_prepared_event(tmp_path):
    blobs = _setup(tmp_path, BASE_MANIFEST, {"p1": _jpeg()})
    job_mod.run(blobs, FakeBundle(), "e1")
    bundle = FakeBundle()
    summary = job_mod.run(blobs, bundle, "e1", force=True)
    assert summary["status"] == "done"
    assert len(bundle.vision.shapes) == 2


def test_a_new_model_version_re_embeds_without_force(tmp_path):
    """The stored vectors are not comparable to a different model's, so a version
    change must re-embed rather than being treated as already prepared."""
    blobs = _setup(tmp_path, BASE_MANIFEST, {"p1": _jpeg()})
    job_mod.run(blobs, FakeBundle(version="o1"), "e1")
    bundle = FakeBundle(version="o2")
    summary = job_mod.run(blobs, bundle, "e1")
    assert summary["status"] == "done"
    assert len(bundle.vision.shapes) == 2


def test_a_reindex_under_a_new_source_version_re_embeds(tmp_path):
    blobs = _setup(tmp_path, BASE_MANIFEST, {"p1": _jpeg()})
    job_mod.run(blobs, FakeBundle(), "e1")
    reindexed = {**BASE_MANIFEST, "modelVersion": "m2"}
    blobs.write(manifest_path("e1"), json.dumps(reindexed).encode("utf-8"), "application/json")
    bundle = FakeBundle()
    summary = job_mod.run(blobs, bundle, "e1")
    assert summary["status"] == "done"
    assert summary["sourceModelVersion"] == "m2"


def test_limit_caps_the_photo_count(tmp_path):
    manifest = {
        "modelVersion": "m1",
        "persons": [{"photoId": p, "box": [0, 0, 50, 100]} for p in ("p1", "p2", "p3")],
        "faces": [],
        "photos": {p: {"mimeType": "image/jpeg"} for p in ("p1", "p2", "p3")},
    }
    blobs = _setup(tmp_path, manifest, {p: _jpeg() for p in ("p1", "p2", "p3")})
    summary = job_mod.run(blobs, FakeBundle(), "e1", limit=2)
    assert summary["photos"] == 2


def test_manifest_with_no_boxes_writes_an_empty_index(tmp_path):
    blobs = _setup(tmp_path, {"modelVersion": "m1", "persons": [], "faces": [], "photos": {}}, {})
    summary = job_mod.run(blobs, FakeBundle(), "e1")
    assert summary["crops"] == 0
    ev = OutfitStore(str(tmp_path)).load_event("e1")
    assert len(ev) == 0
    assert ev.vectors.shape == (0, DIM)


def test_unindexed_event_raises(tmp_path):
    with pytest.raises(FileNotFoundError, match="index the event first"):
        job_mod.run(BlobIO(str(tmp_path)), FakeBundle(), "ghost")


def test_non_jpeg_mime_reads_the_right_extension(tmp_path):
    from PIL import Image

    manifest = {
        "modelVersion": "m1",
        "persons": [{"photoId": "p1", "box": [0, 0, 50, 100]}],
        "faces": [],
        "photos": {"p1": {"mimeType": "image/png"}},
    }
    blobs = BlobIO(str(tmp_path))
    blobs.write(manifest_path("e1"), json.dumps(manifest).encode("utf-8"), "application/json")
    buf = io.BytesIO()
    Image.new("RGB", (200, 160), (90, 90, 90)).save(buf, format="PNG")
    blobs.write("e1/photos/orig/p1.png", buf.getvalue(), "image/png")

    summary = job_mod.run(blobs, FakeBundle(), "e1")
    assert summary["crops"] == 1
