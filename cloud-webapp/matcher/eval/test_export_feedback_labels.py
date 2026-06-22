"""Tests for the feedback→labels export helpers (EVAL_FEEDBACK_LOOP.md)."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from export_feedback_labels import (  # noqa: E402
    build_label_rows,
    judged_precision,
    verdict_to_label,
)


def test_verdict_to_label_mapping():
    assert verdict_to_label("confirmed", None) == "confirmed"
    assert verdict_to_label("confirmed", "me") == "confirmed"
    assert verdict_to_label("not_me", None) == "wrong"
    # friend/group positives are excluded from judged precision (§4b)
    assert verdict_to_label("confirmed", "friend") is None
    assert verdict_to_label("confirmed", "group") is None
    # a "not_me" with any reason is still a hard negative
    assert verdict_to_label("not_me", "friend") == "wrong"
    assert verdict_to_label("bogus", None) is None


def test_build_label_rows_joins_run_model_version_and_excludes():
    feedback = [
        {"uid": "u1", "eventId": "ev1", "photoId": "p1", "verdict": "confirmed", "runId": "r1"},
        {"uid": "u2", "eventId": "ev1", "photoId": "p2", "verdict": "not_me", "runId": "r1"},
        {"uid": "u3", "eventId": "ev1", "photoId": "p3", "verdict": "confirmed", "reason": "friend", "runId": "r1"},
    ]
    runs = {"r1": {"modelVersion": "m-2026-06"}}
    rows = build_label_rows(feedback, runs)
    assert len(rows) == 2  # friend row excluded
    assert rows[0]["model_version"] == "m-2026-06"
    assert {r["label"] for r in rows} == {"confirmed", "wrong"}
    assert rows[0]["person"] == "u1"
    assert rows[0]["_eventId"] == "ev1"


def test_judged_precision_and_evidence_bar():
    # 1 confirmed + 1 wrong, 2 users → precision 0.5 but below the evidence bar
    small = [
        {"label": "confirmed", "person": "u1"},
        {"label": "wrong", "person": "u2"},
    ]
    jp = judged_precision(small)
    assert jp["precision"] == 0.5
    assert jp["judged_pairs"] == 2
    assert jp["distinct_users"] == 2
    assert jp["meaningful"] is False

    # 18 confirmed + 2 wrong across 5 users → precision 0.9, meaningful
    big = [{"label": "confirmed", "person": f"u{i % 5}"} for i in range(18)]
    big += [{"label": "wrong", "person": "u0"}, {"label": "wrong", "person": "u1"}]
    jp2 = judged_precision(big)
    assert abs(jp2["precision"] - 0.9) < 1e-9
    assert jp2["judged_pairs"] == 20
    assert jp2["distinct_users"] == 5
    assert jp2["meaningful"] is True


def test_judged_precision_empty():
    jp = judged_precision([])
    assert jp["precision"] is None
    assert jp["meaningful"] is False
