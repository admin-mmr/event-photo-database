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
    _fused_candidates,
    _mean_unit,
    _time_weight_fn,
    fused_precision_at_k,
    parse_windows,
    prf_evaluate,
    threshold_sweep,
    time_conditional_sweep,
)
from store import EventEmbeddings, _iso_to_epoch_ms, build_manifest  # noqa: E402

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


# ── capture-time-conditional fusion (Item 1) ─────────────────────────────────────

def _timed_event(taken):
    """rel + far share the same outfit (basis 2); only their faces & capture
    times differ. `taken` maps photoId → ISO capture time."""
    event = make_event(
        face_rows=[("rel", basis(0)), ("far", basis(1))],
        person_rows=[("rel", basis(2)), ("far", basis(2))],
    )
    event.photos = {pid: {"takenAt": iso} for pid, iso in taken.items()}
    return event


def test_parse_windows_parses_triples():
    assert parse_windows("30:120:0;45:180:0.1") == [(30.0, 120.0, 0.0), (45.0, 180.0, 0.1)]
    assert parse_windows("") == []
    with pytest.raises(SystemExit):
        parse_windows("45:180")  # missing floor


def test_time_weight_fn_none_without_anchor():
    event = make_event([("p", basis(0))])
    # No query capture time → None → caller keeps the flat production weight.
    assert _time_weight_fn(event, None, 0.15, 45 * 60_000, 180 * 60_000, 0.0) is None


def test_time_weight_fn_decays_by_capture_gap():
    event = _timed_event({"rel": "2026-06-20T10:00:00", "far": "2026-06-20T22:00:00"})  # 12 h apart
    anchor = _iso_to_epoch_ms("2026-06-20T10:00:00")
    fn = _time_weight_fn(event, anchor, 0.15, 45 * 60_000, 180 * 60_000, 0.0)
    assert fn("rel") == pytest.approx(0.15)   # same time → full person weight
    assert fn("far") == pytest.approx(0.0)    # 12 h gap ≥ zero window → floor
    assert fn("unknown") == pytest.approx(0.15)  # candidate w/o takenAt → static (time_decay(None)=1)


def test_time_conditional_downweights_far_outfit_score():
    # far matches ONLY on outfit (same basis-2 person vector), shot 12 h later.
    # Time-conditioning must strip its outfit boost while leaving the near
    # same-outfit relevant photo untouched.
    event = _timed_event({"rel": "2026-06-20T10:00:00", "far": "2026-06-20T22:00:00"})
    anchor = _iso_to_epoch_ms("2026-06-20T10:00:00")
    q = {"face": basis(0), "person": basis(2), "anchor_ms": anchor}

    static = {h["photoId"]: h["score"] for h in _fused_candidates(event, q, 0.5, 0.5, tnorm=False)}
    wfn = _time_weight_fn(event, anchor, 0.5, 45 * 60_000, 180 * 60_000, 0.0)
    timed = {h["photoId"]: h["score"] for h in _fused_candidates(event, q, 0.5, 0.5, tnorm=False, person_weight_fn=wfn)}

    assert timed["far"] < static["far"]              # outfit boost removed by the time gap
    assert timed["far"] == pytest.approx(0.0)        # floor=0 → outfit contributes nothing
    assert timed["rel"] == pytest.approx(static["rel"])  # near candidate unaffected


def test_time_conditional_sweep_structure_and_baseline():
    event = _timed_event({"rel": "2026-06-20T10:00:00", "far": "2026-06-20T22:00:00"})
    anchor = _iso_to_epoch_ms("2026-06-20T10:00:00")
    queries = {"alice": {"face": basis(0), "person": basis(2), "anchor_ms": anchor}}
    truth = {"alice": {"rel"}}
    negatives = {"alice": {"far"}}

    tc = time_conditional_sweep(
        event, truth, queries, k=5, w_face=0.5, w_person=0.5,
        windows=[(45, 180, 0.0)], negatives=negatives, judged=True,
    )
    assert tc["anchored_people"] == 1
    assert [v["label"] for v in tc["variants"]] == ["static", "full45m_zero180m_floor0"]
    assert all("threshold_sweep" in v and "fused_precision_at_k" in v for v in tc["variants"])

    # A person with no anchor must fall back to static (no crash, inert).
    tc_none = time_conditional_sweep(
        event, {"bob": {"rel"}}, {"bob": {"face": basis(0), "person": basis(2)}},
        k=5, w_face=0.5, w_person=0.5, windows=[(45, 180, 0.0)],
    )
    assert tc_none["anchored_people"] == 0
