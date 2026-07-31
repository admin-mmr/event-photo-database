"""Tests for crop geometry and the MIME→extension parity with the indexer."""

from __future__ import annotations

import os
import re
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import crops  # noqa: E402


def test_orig_ext_matches_indexer():
    """We read the originals the indexer wrote, so our MIME→extension table must
    be the indexer's. Parsed out of indexer/job.py rather than imported: that
    module imports the whole matcher pipeline at module scope, which the test env
    does not have. Same convention as the api's origExtParity test."""
    job_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "indexer", "job.py"
    )
    with open(job_path, encoding="utf-8") as f:
        source = f.read()
    block = re.search(r"ORIG_EXT_BY_MIME\s*=\s*\{(.*?)\}", source, re.S)
    assert block, "could not find ORIG_EXT_BY_MIME in indexer/job.py"
    theirs = dict(re.findall(r'"([^"]+)":\s*"([^"]+)"', block.group(1)))
    assert theirs, "parsed an empty table — the parity check would be vacuous"
    assert theirs == crops.ORIG_EXT_BY_MIME


def test_orig_ext_falls_back_for_unknown_mime():
    assert crops.orig_ext("image/jpeg") == "jpg"
    assert crops.orig_ext("application/weird") == crops.DEFAULT_EXT
    assert crops.orig_ext(None) == crops.DEFAULT_EXT


def test_orig_path_shape():
    assert crops.orig_path("e1", "p1", "image/png") == "e1/photos/orig/p1.png"


def test_head_box_expands_around_the_face_and_biases_up():
    face = [100.0, 100.0, 200.0, 200.0]  # 100×100 face
    box = crops.head_box(face, 1000, 1000)
    width, height = box[2] - box[0], box[3] - box[1]
    assert width == pytest.approx(100 * crops.HEAD_W_SCALE)
    assert height == pytest.approx(100 * crops.HEAD_H_SCALE)
    # Centre shifted UP (smaller y) relative to the face centre, so headwear is
    # inside the frame.
    face_cy = 150.0
    box_cy = (box[1] + box[3]) / 2
    assert box_cy < face_cy
    assert box_cy == pytest.approx(face_cy - 100 * crops.HEAD_UP_BIAS)


def test_head_box_is_clamped_at_the_frame_edge():
    box = crops.head_box([0.0, 0.0, 50.0, 50.0], 200, 200)
    assert box[0] >= 0 and box[1] >= 0
    assert box[2] <= 200 and box[3] <= 200


def test_cut_returns_the_region():
    img = np.arange(100 * 80 * 3, dtype=np.uint8).reshape(100, 80, 3)
    out = crops.cut(img, [10, 20, 30, 50])
    assert out.shape == (30, 20, 3)
    np.testing.assert_array_equal(out, img[20:50, 10:30])


def test_cut_of_a_degenerate_box_is_empty_not_an_error():
    img = np.zeros((10, 10, 3), dtype=np.uint8)
    assert crops.cut(img, [5, 5, 5, 5]).size == 0
    assert crops.cut(img, [8, 8, 2, 2]).size == 0


def test_specs_are_person_rows_then_head_rows_in_manifest_order():
    manifest = {
        "persons": [
            {"photoId": "p1", "box": [0, 0, 10, 10]},
            {"photoId": "p2", "box": [1, 1, 11, 11]},
        ],
        "faces": [{"photoId": "p1", "box": [2, 2, 6, 6]}],
    }
    specs = crops.specs_for_event(manifest)
    assert [(s["photoId"], s["region"]) for s in specs] == [
        ("p1", "person"),
        ("p2", "person"),
        ("p1", "head"),
    ]
    assert [s["sourceRow"] for s in specs] == [0, 1, 0]


def test_specs_skip_rows_missing_a_photo_or_box():
    manifest = {
        "persons": [{"photoId": "p1"}, {"box": [0, 0, 1, 1]}, {"photoId": "p2", "box": [0, 0, 2, 2]}],
        "faces": [],
    }
    assert [s["photoId"] for s in crops.specs_for_event(manifest)] == ["p2"]


def test_specs_of_an_empty_manifest_is_empty():
    assert crops.specs_for_event({}) == []


def test_resolve_box_expands_only_head_specs():
    person = {"region": "person", "box": [10.0, 10.0, 50.0, 90.0]}
    head = {"region": "head", "box": [10.0, 10.0, 50.0, 50.0]}
    assert crops.resolve_box(person, 200, 200) == [10.0, 10.0, 50.0, 90.0]
    resolved = crops.resolve_box(head, 200, 200)
    assert resolved[2] - resolved[0] > 40  # expanded beyond the face width


def test_short_side():
    assert crops.short_side([0, 0, 30, 10]) == 10
    assert crops.short_side([0, 0, 10, 30]) == 10
