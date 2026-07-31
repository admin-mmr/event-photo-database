"""
test_face_size_retrieval.py — tests for the face-size retrieval experiment.

The parts worth pinning are the ones a silent bug would make the experiment lie
about: re-finding a face after downscaling (must be by POSITION, never by
embedding — matching by embedding would beg the question), and the match floor
derived from the matcher's own fusion constants.
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

pytest.importorskip("cv2")

import face_size_retrieval as fsr  # noqa: E402


def _face(box, px=None):
    x1, y1, x2, y2 = box
    return {"box": list(box), "score": 0.9,
            "face_px": px if px is not None else int(min(x2 - x1, y2 - y1)),
            "embedding": np.ones(512, dtype=np.float32)}


def test_face_cos_floor_tracks_the_matcher_constants():
    """If fusion's threshold or face weight ever move, this experiment's verdict
    must move with them rather than keeping a stale hardcoded number."""
    from fusion import DEFAULT_FACE_WEIGHT, DEFAULT_THRESHOLD
    assert fsr.FACE_COS_FLOOR == pytest.approx(DEFAULT_THRESHOLD / DEFAULT_FACE_WEIGHT)
    assert 0.2 < fsr.FACE_COS_FLOOR < 0.4


def test_match_scaled_finds_the_same_face_at_the_scaled_position():
    ref_box = [400, 600, 500, 700]          # 100px face centred (450, 650)
    scale = 0.3                             # → expected centre (135, 195), 30px
    scaled = [_face([120, 180, 150, 210]),  # the same face, scaled
              _face([20, 20, 50, 50])]      # somebody else
    got = fsr.match_scaled(scaled, ref_box, scale)
    assert got is scaled[0]


def test_match_scaled_returns_none_when_the_face_vanished():
    """A detector that loses the face must be reported as a detection failure,
    not silently matched to whoever else is nearby."""
    ref_box = [400, 600, 500, 700]
    scaled = [_face([0, 0, 30, 30])]        # far from the expected centre
    assert fsr.match_scaled(scaled, ref_box, 0.3) is None


def test_match_scaled_tolerance_scales_with_face_size():
    ref_box = [400, 600, 500, 700]
    scale = 0.3       # expected centre (135, 195), 30px face → tolerance 18px
    near = [_face([127, 187, 157, 217])]     # centre (142, 202): 9.9px off — inside
    assert fsr.match_scaled(near, ref_box, scale) is not None
    far = [_face([145, 205, 175, 235])]      # centre (160, 220): 35px off — outside
    assert fsr.match_scaled(far, ref_box, scale) is None


def test_match_scaled_keeps_a_floor_tolerance_for_tiny_faces():
    """At single-digit face sizes, resize rounding alone moves the centre a few
    px; a purely proportional tolerance (0.6 × 8px = 4.8) would report phantom
    detection failures, so the tolerance has a 6px floor."""
    ref_box = [1000, 1000, 1100, 1100]
    scale = 0.08     # expected centre (84, 84), 8px face → 0.6× would be 4.8px
    got = fsr.match_scaled([_face([84, 79, 94, 89], px=8)], ref_box, scale)
    assert got is not None, "the 6px floor must absorb rounding at tiny sizes"


def test_cos_and_face_px_helpers():
    assert fsr._cos(np.ones(4), np.ones(4)) == pytest.approx(1.0)
    assert fsr._cos(np.zeros(4), np.ones(4)) == 0.0
    assert fsr._face_px([10, 20, 60, 100]) == 50   # min side, not max
    assert fsr._center([0, 0, 10, 20]) == (5.0, 10.0)


def test_pct_handles_an_empty_sample():
    assert np.isnan(fsr.pct([], 95))
    assert fsr.pct([1.0, 2.0, 3.0], 50) == pytest.approx(2.0)


def test_resize_to_never_produces_a_degenerate_image():
    img = np.zeros((100, 50, 3), dtype=np.uint8)
    out = fsr.resize_to(img, 0.001)
    assert out.shape[0] >= 2 and out.shape[1] >= 2


def test_find_images_filters_by_extension(tmp_path):
    (tmp_path / "a.jpg").write_bytes(b"x")
    (tmp_path / "b.txt").write_bytes(b"x")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "c.png").write_bytes(b"x")
    found = [os.path.basename(p) for p in fsr.find_images([str(tmp_path)])]
    assert sorted(found) == ["a.jpg", "c.png"]
