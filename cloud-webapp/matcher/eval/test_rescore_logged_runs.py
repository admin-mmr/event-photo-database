"""Tests for rescore_logged_runs.py — pure logic over hand-built run/vote docs."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rescore_logged_runs import candidates_of, rescore  # noqa: E402

TNORM = {"version": "t", "tnorm": True}


def _run(**kw):
    base = {
        "id": "r1",
        "algo": TNORM,
        "resultPhotoIds": ["a", "b"],
        "faceScores": {"a": 6.0, "b": 4.8},
        "personScores": {"a": 2.0, "b": 1.0},
        "nearMisses": [{"photoId": "c", "score": 4.2, "faceScore": 4.6, "personScore": 1.0}],
    }
    base.update(kw)
    return base


def test_candidates_include_the_near_miss_band():
    assert [c[0] for c in candidates_of(_run())] == ["a", "b", "c"]


def test_a_run_without_per_modality_scores_contributes_nothing():
    assert candidates_of(_run(faceScores={}, personScores={})) == []


def test_raising_the_cutoff_drops_judged_photos_exactly():
    fb = [
        {"uid": "u", "eventId": "e", "runId": "r1", "photoId": "a", "verdict": "confirmed"},
        {"uid": "u", "eventId": "e", "runId": "r1", "photoId": "b", "verdict": "not_me"},
    ]
    rep = rescore([_run()], fb, cutoffs=[4.5, 5.0], weights=[(0.85, 0.15)])
    # a: 0.85*6 + 0.15*2 = 5.4; b: 0.85*4.8 + 0.15*1 = 4.23 → below both cutoffs
    rows = {r["cutoff"]: r for r in rep["table"]}
    assert (rows[4.5]["right"], rows[4.5]["wrong"]) == (1, 0)
    assert rows[5.0]["precision"] == 1.0


def test_lowering_the_cutoff_counts_unshown_photos_as_unjudged_not_wrong():
    rep = rescore([_run()], [], cutoffs=[4.0], weights=[(1.0, 0.0)])
    row = rep["table"][0]
    # c (face 4.6) was never shown: admitted, and neither right nor wrong.
    assert row["admitted_unjudged"] == 1
    assert row["right"] == row["wrong"] == 0 and row["precision"] is None


def test_only_the_latest_vote_and_only_me_tags_count():
    fb = [
        {"uid": "u", "eventId": "e", "runId": "r1", "photoId": "a", "verdict": "not_me", "createdAt": "1"},
        {"uid": "u", "eventId": "e", "runId": "r1", "photoId": "a", "verdict": "confirmed", "createdAt": "2"},
        {"uid": "u", "eventId": "e", "runId": "r1", "photoId": "b", "verdict": "confirmed", "reason": "friend"},
    ]
    row = rescore([_run()], fb, cutoffs=[4.0], weights=[(1.0, 0.0)])["table"][0]
    assert (row["right"], row["wrong"]) == (1, 0)  # a corrected to me; b is a friend — unjudged


def test_raw_cosine_runs_are_left_out():
    rep = rescore([_run(algo={"version": "t", "tnorm": False})], [], cutoffs=[4.0], weights=[(1.0, 0.0)])
    assert rep["runs_used"] == 0
