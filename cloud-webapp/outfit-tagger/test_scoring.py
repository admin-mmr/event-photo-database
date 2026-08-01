"""Tests for prototype building, per-modality z-scoring, and fusion."""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import scoring  # noqa: E402
from store import OutfitIndex, build_index  # noqa: E402


def test_mean_unit_is_a_unit_vector():
    out = scoring.mean_unit([[1.0, 0.0], [0.0, 1.0]])
    assert np.linalg.norm(out) == pytest.approx(1.0)
    assert out.tolist() == pytest.approx([0.7071068, 0.7071068])


def test_mean_unit_of_nothing_is_none():
    assert scoring.mean_unit([]) is None
    assert scoring.mean_unit([np.zeros((0,), np.float32)]) is None


def test_mean_unit_of_cancelling_samples_is_none():
    """Antipodal samples average to the zero vector, which carries no direction.
    That must read as "no usable query", not as a garbage unit vector."""
    assert scoring.mean_unit([[1.0, 0.0], [-1.0, 0.0]]) is None


def test_zscore_uses_only_the_masked_cohort():
    sims = np.array([0.0, 10.0, 1.0, 2.0], dtype=np.float32)
    mask = np.array([False, False, True, True])
    z = scoring.zscore(sims, mask)
    # Cohort is [1, 2]: mean 1.5, std 0.5 → the masked-in rows become ∓1.
    assert z[2] == pytest.approx(-1.0)
    assert z[3] == pytest.approx(1.0)
    # Masked-out rows stay row-aligned, transformed by the same affine map.
    assert len(z) == 4
    assert z[1] > z[3]


def test_zscore_of_a_degenerate_cohort_passes_through():
    single = np.array([0.42], dtype=np.float32)
    assert scoring.zscore(single).tolist() == pytest.approx([0.42])
    flat = np.array([0.5, 0.5, 0.5], dtype=np.float32)
    assert scoring.zscore(flat).tolist() == pytest.approx([0.0, 0.0, 0.0])


def test_zscore_is_monotonic():
    """T-norm is affine, so it must never reorder a single modality's ranking."""
    sims = np.array([0.1, 0.9, 0.5, 0.3], dtype=np.float32)
    assert np.argsort(-scoring.zscore(sims)).tolist() == np.argsort(-sims).tolist()


def test_fuse_of_one_modality_is_that_modality_unscaled():
    only = np.array([1.0, 2.0], dtype=np.float32)
    np.testing.assert_allclose(scoring.fuse(only, None, 0.9), only)
    np.testing.assert_allclose(scoring.fuse(None, only, 0.1), only)


def test_fuse_blends_by_weight():
    sample = np.array([0.0, 4.0], dtype=np.float32)
    text = np.array([4.0, 0.0], dtype=np.float32)
    np.testing.assert_allclose(scoring.fuse(sample, text, 0.25), np.array([1.0, 3.0]))
    np.testing.assert_allclose(scoring.fuse(sample, text, 0.0), sample)
    np.testing.assert_allclose(scoring.fuse(sample, text, 1.0), text)


def test_fuse_clamps_the_weight():
    sample = np.array([0.0, 4.0], dtype=np.float32)
    text = np.array([4.0, 0.0], dtype=np.float32)
    np.testing.assert_allclose(scoring.fuse(sample, text, 2.0), text)
    np.testing.assert_allclose(scoring.fuse(sample, text, -1.0), sample)


def test_fuse_needs_a_modality():
    with pytest.raises(ValueError):
        scoring.fuse(None, None, 0.5)


def test_text_calibration_is_query_independent():
    """The calibration must depend only on the crops and the model — that is the
    property a cohort z-score lacks, and the reason text scoring was wrong."""
    vectors = np.eye(6, 4, dtype=np.float32)
    calls = []

    def embed(prompt):
        calls.append(prompt)
        v = np.zeros(4, dtype=np.float32)
        v[len(prompt) % 4] = 1.0
        return v

    mean, std = scoring.text_calibration(vectors, embed, prompts=("aa", "bbb", "cccc"))
    assert calls == ["aa", "bbb", "cccc"], "must embed exactly the background prompts"
    assert std > 0
    # Same crops + same prompts => same numbers, regardless of any later query.
    assert scoring.text_calibration(vectors, embed, prompts=("aa", "bbb", "cccc")) == (mean, std)


def test_text_calibration_degenerate_inputs():
    assert scoring.text_calibration(np.zeros((0, 4), np.float32), lambda p: np.ones(4, np.float32)) == (0.0, 1.0)
    assert scoring.text_calibration(np.eye(3, 4, dtype=np.float32), lambda p: np.ones(4, np.float32), prompts=()) == (0.0, 1.0)
    # Identical crops => zero spread => std falls back to 1.0, not to noise.
    same = np.tile(np.array([1.0, 0, 0, 0], np.float32), (5, 1))
    _, std = scoring.text_calibration(same, lambda p: np.array([1.0, 0, 0, 0], np.float32), prompts=("a", "b"))
    assert std == 1.0


def test_scale_is_fixed_affine():
    sims = np.array([0.0, 0.1, 0.2], dtype=np.float32)
    out = scoring.scale(sims, 0.05, 0.05)
    assert out.tolist() == pytest.approx([-1.0, 1.0, 3.0])
    # A zero std must not divide by noise.
    assert scoring.scale(sims, 0.0, 0.0).tolist() == pytest.approx(sims.tolist())
    assert scoring.scale(np.zeros((0,), np.float32), 1.0, 1.0).size == 0


def test_fixed_scaling_preserves_cross_query_separation():
    """The regression test for the shipped bug.

    Two queries over the SAME cohort: one relevant (broadly similar to every crop,
    with a strong best match) and one out-of-domain (uniformly dissimilar, tiny
    spread). Cohort z-scoring ranks the out-of-domain query HIGHER — which is what
    production did. Fixed calibration preserves the true ordering.
    """
    relevant = np.array([0.06, 0.07, 0.08, 0.09, 0.15], dtype=np.float32)
    out_of_domain = np.array([0.010, 0.011, 0.012, 0.013, 0.030], dtype=np.float32)

    # The old behaviour, asserted so nobody "simplifies" back to it.
    assert scoring.zscore(out_of_domain).max() > scoring.zscore(relevant).max()

    # Calibration from a background whose spread covers the whole population.
    mean, std = 0.05, 0.04
    assert scoring.scale(relevant, mean, std).max() > scoring.scale(out_of_domain, mean, std).max()
    # And the out-of-domain query stays near/below the background, as it should.
    assert scoring.scale(out_of_domain, mean, std).max() < 0.0


def test_zscoring_makes_the_weight_meaningful():
    """The reason both modalities are z-scored: raw image↔image cosines are an
    order of magnitude larger than image↔text ones, so a raw blend is the image
    term no matter what weight the caller asks for."""
    sample_raw = np.array([0.80, 0.70, 0.60], dtype=np.float32)
    text_raw = np.array([0.05, 0.14, 0.08], dtype=np.float32)
    # Raw: the text term cannot change the order set by the samples.
    raw = 0.5 * sample_raw + 0.5 * text_raw
    assert np.argsort(-raw).tolist() == np.argsort(-sample_raw).tolist()
    # Z-scored: text now genuinely competes and reorders the ranking.
    fused = scoring.fuse(scoring.zscore(sample_raw), scoring.zscore(text_raw), 0.5)
    assert np.argsort(-fused).tolist() != np.argsort(-sample_raw).tolist()


def _index(rows, vectors):
    return OutfitIndex(
        build_index("e1", "o1", "m1", rows, photos=len({r["photoId"] for r in rows})),
        np.asarray(vectors, dtype=np.float32),
    )


def test_rank_photos_keeps_the_best_crop_per_photo():
    index = _index(
        [
            {"photoId": "p1", "region": "person", "box": [0, 0, 1, 1]},
            {"photoId": "p1", "region": "head", "box": [0, 0, 2, 2]},
            {"photoId": "p2", "region": "person", "box": [0, 0, 3, 3]},
        ],
        np.eye(3, 4),
    )
    scores = np.array([1.0, 5.0, 3.0], dtype=np.float32)
    ranked = scoring.rank_photos(index, scores, np.ones(3, bool), None, None)
    assert [r["photoId"] for r in ranked] == ["p1", "p2"]
    assert ranked[0]["score"] == 5.0
    assert ranked[0]["region"] == "head"  # p1's winning crop, not its first


def test_rank_photos_applies_mask_min_score_and_top_k():
    index = _index(
        [
            {"photoId": "p1", "region": "person"},
            {"photoId": "p2", "region": "person"},
            {"photoId": "p3", "region": "person"},
        ],
        np.eye(3, 4),
    )
    scores = np.array([3.0, 2.0, 1.0], dtype=np.float32)
    masked = scoring.rank_photos(index, scores, np.array([False, True, True]), None, None)
    assert [r["photoId"] for r in masked] == ["p2", "p3"]
    gated = scoring.rank_photos(index, scores, np.ones(3, bool), None, 2.5)
    assert [r["photoId"] for r in gated] == ["p1"]
    capped = scoring.rank_photos(index, scores, np.ones(3, bool), 2, None)
    assert [r["photoId"] for r in capped] == ["p1", "p2"]


def test_rank_photos_reports_per_modality_components():
    index = _index([{"photoId": "p1", "region": "person"}], np.eye(1, 4))
    ranked = scoring.rank_photos(
        index,
        np.array([2.0], np.float32),
        np.ones(1, bool),
        None,
        None,
        components={
            "sampleScore": np.array([3.0], np.float32),
            "textScore": None,
        },
    )
    assert ranked[0]["sampleScore"] == 3.0
    assert ranked[0]["textScore"] is None


def test_rank_photos_of_an_empty_index():
    index = _index([], np.zeros((0, 4)))
    assert scoring.rank_photos(index, np.zeros((0,), np.float32), np.zeros(0, bool), 10, None) == []
