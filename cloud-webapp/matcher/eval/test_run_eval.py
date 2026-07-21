"""Tests for the T-norm and PRF eval extensions in run_eval.py.

Synthetic stores only (no ONNX models) — same approach as test_main.py: build
an EventEmbeddings by hand and feed query embeddings directly, bypassing
embed_queries (which needs the models).
"""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from run_eval import (  # noqa: E402
    _mean_unit,
    fused_precision_at_k,
    prf_evaluate,
    threshold_sweep,
)
from store import EventEmbeddings, build_manifest  # noqa: E402

DIM = 16


def basis(i):
    v = np.zeros(DIM, dtype=np.float32)
    v[i] = 1.0
    return v


def unit(v):
    v = np.asarray(v, dtype=np.float32)
    return v / np.linalg.norm(v)


def make_event(face_rows, person_rows=None):
    """face_rows / person_rows: list of (photoId, vector)."""
    person_rows = person_rows or []
    faces = np.stack([unit(v) for _, v in face_rows]) if face_rows else np.zeros((0, DIM), np.float32)
    persons = np.stack([unit(v) for _, v in person_rows]) if person_rows else np.zeros((0, DIM), np.float32)
    fmeta = [{"photoId": pid, "box": [0, 0, 1, 1], "score": 0.9} for pid, _ in face_rows]
    pmeta = [{"photoId": pid, "box": [0, 0, 1, 1], "score": 0.9} for pid, _ in person_rows]
    return EventEmbeddings(build_manifest("ev", "test@v0", fmeta, pmeta), faces, persons)


# ── _mean_unit ────────────────────────────────────────────────────────────────

def test_mean_unit_matches_matcher_semantics():
    assert _mean_unit([]) is None
    assert np.allclose(_mean_unit([basis(0) * 3.0]), basis(0))
    c = _mean_unit([basis(0), basis(1)])
    assert float(np.linalg.norm(c)) == pytest.approx(1.0)
    assert c[0] == c[1]


# ── threshold_sweep ─────────────────────────────────────────────────────────────

def _pr_event():
    # 2 relevant photos score high vs basis(0); 6 distractors score ~0.
    rows = [("r1.jpg", basis(0)), ("r2.jpg", unit(basis(0) * 0.9 + basis(1) * 0.1))]
    rows += [(f"d{i}.jpg", basis(1)) for i in range(6)]
    return make_event(rows)


def test_threshold_sweep_trades_precision_for_recall():
    event = _pr_event()
    truth = {"alice": {"r1.jpg", "r2.jpg"}}
    queries = {"alice": {"face": basis(0), "person": None}}
    sweep = threshold_sweep(event, truth, queries, w_face=1.0, w_person=0.0, tnorm=False)
    pts = sweep["points"]
    assert len(pts) == 11
    # Lowest threshold returns everything → full recall; highest → full precision.
    assert pts[0]["recall"] == 1.0
    assert pts[-1]["precision"] == 1.0
    # Recall is non-increasing and precision non-decreasing as the threshold rises.
    recalls = [p["recall"] for p in pts]
    precisions = [p["precision"] for p in pts if p["precision"] is not None]
    assert recalls == sorted(recalls, reverse=True)
    assert precisions == sorted(precisions)


def test_threshold_sweep_tnorm_runs_on_its_own_scale():
    event = _pr_event()
    truth = {"alice": {"r1.jpg", "r2.jpg"}}
    queries = {"alice": {"face": basis(0), "person": None}}
    raw = threshold_sweep(event, truth, queries, 1.0, 0.0, tnorm=False)
    tn = threshold_sweep(event, truth, queries, 1.0, 0.0, tnorm=True)
    assert tn["tnorm"] is True and tn["points"]
    # z-scored thresholds live on a different (cohort-relative) scale than raw cosines.
    assert tn["points"][-1]["threshold"] != raw["points"][-1]["threshold"]


def test_threshold_sweep_judged_omits_recall():
    event = _pr_event()
    truth = {"alice": {"r1.jpg"}}          # confirmed
    negatives = {"alice": {"d0.jpg"}}      # explicit wrong
    queries = {"alice": {"face": basis(0), "person": None}}
    sweep = threshold_sweep(event, truth, queries, 1.0, 0.0, False, negatives=negatives, judged=True)
    assert all(p["recall"] is None for p in sweep["points"])
    # At the top threshold only the confirmed photo survives → precision 1.0, no FP.
    assert sweep["points"][-1]["precision"] == 1.0


# ── fused_precision_at_k ────────────────────────────────────────────────────────

def test_fused_precision_at_k_returns_values_for_both_variants():
    event = _pr_event()
    truth = {"alice": {"r1.jpg", "r2.jpg"}}
    queries = {"alice": {"face": basis(0), "person": None}}
    assert fused_precision_at_k(event, truth, queries, 2, 1.0, 0.0, False) == 1.0
    assert fused_precision_at_k(event, truth, queries, 2, 1.0, 0.0, True) == 1.0


# ── prf_evaluate ────────────────────────────────────────────────────────────────

def test_prf_lifts_recall_on_held_out_photo():
    # a_fold bridges the query (basis0) and the held-out photo (basis5); folding
    # it in pulls the centroid toward basis5 so b_held clears the distractors.
    bridge = unit(basis(0) * 0.6 + basis(5) * 0.6)
    rows = [("a_fold.jpg", bridge), ("b_held.jpg", basis(5))]
    rows += [(f"d{i}.jpg", unit(basis(0) * 0.1 + basis(9))) for i in range(6)]
    event = make_event(rows)
    truth = {"alice": {"a_fold.jpg", "b_held.jpg"}}
    queries = {"alice": {"face": basis(0), "person": None}}

    prf = prf_evaluate(event, truth, queries, k=5, fold=1)
    assert prf["queries"] == 1
    assert prf["mean"]["base_recall"] == 0.0   # b_held buried under distractors
    assert prf["mean"]["prf_recall"] == 1.0    # surfaced after folding a_fold
    assert prf["mean"]["lift"] == 1.0


def test_prf_skips_people_without_enough_photos():
    event = make_event([("only.jpg", basis(0))])
    truth = {"alice": {"only.jpg"}}
    queries = {"alice": {"face": basis(0), "person": None}}
    prf = prf_evaluate(event, truth, queries, k=5, fold=1)
    assert prf["queries"] == 0
    assert prf["mean"]["lift"] is None
