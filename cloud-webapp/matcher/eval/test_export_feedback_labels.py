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


def test_search_version_from_feedback_then_run_then_empty():
    """search_version prefers the vote's own denormalized field, then the run's
    algo.version, and is '' for pre-versioning votes (treated as old pipeline)."""
    feedback = [
        # denormalized straight onto the vote (current api path)
        {"uid": "u1", "eventId": "ev1", "photoId": "p1", "verdict": "confirmed",
         "runId": "r1", "searchVersion": "2026.07-tnorm-multiref-prf"},
        # older vote with no searchVersion → fall back to the run's algo.version
        {"uid": "u2", "eventId": "ev1", "photoId": "p2", "verdict": "not_me", "runId": "r2"},
        # no runId and no algo anywhere → '' (old pipeline)
        {"uid": "u3", "eventId": "ev1", "photoId": "p3", "verdict": "confirmed"},
    ]
    runs = {"r2": {"algo": {"version": "2026.07-tnorm-multiref-prf"}}}
    rows = build_label_rows(feedback, runs)
    by_person = {r["person"]: r for r in rows}
    assert by_person["u1"]["search_version"] == "2026.07-tnorm-multiref-prf"
    assert by_person["u2"]["search_version"] == "2026.07-tnorm-multiref-prf"
    assert by_person["u3"]["search_version"] == ""


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


def test_latest_vote_per_photo_wins():
    from export_feedback_labels import build_label_rows

    fb = [
        {"uid": "u1", "eventId": "e", "photoId": "p1", "verdict": "confirmed", "createdAt": "2026-09-01T10:00"},
        {"uid": "u1", "eventId": "e", "photoId": "p1", "verdict": "not_me", "createdAt": "2026-09-01T10:05"},
        {"uid": "u1", "eventId": "e", "photoId": "p2", "verdict": "confirmed", "createdAt": "2026-09-01T10:00"},
        {"uid": "u1", "eventId": "e", "photoId": "p2", "verdict": "confirmed", "reason": "friend", "createdAt": "2026-09-01T10:06"},
        {"uid": "u2", "eventId": "e", "photoId": "p1", "verdict": "confirmed", "createdAt": "2026-09-01T09:00"},
    ]
    rows = build_label_rows(fb)
    got = sorted((r["uid"], r["photoId"], r["label"]) for r in rows)
    # u1/p1 corrected to not_me; u1/p2 re-tagged as a friend → excluded; u2 is its own vote.
    assert got == [("u1", "p1", "wrong"), ("u2", "p1", "confirmed")]


def test_tier_comes_through_from_the_vote():
    from export_feedback_labels import build_label_rows

    rows = build_label_rows(
        [{"uid": "u1", "eventId": "e", "photoId": "p1", "verdict": "confirmed", "reason": "me", "tier": "expanded"}]
    )
    assert rows[0]["tier"] == "expanded"


def test_calibration_is_monotone_and_merges_thin_buckets():
    from calibrate_display import isotonic_buckets, judged_points

    runs = [{"id": "r", "algo": {"tnorm": True}, "scores": {"a": 4.6, "b": 4.7, "c": 6.2, "d": 6.3, "e": 9.0}}]
    fb = [
        {"uid": "u", "eventId": "e", "runId": "r", "photoId": "a", "verdict": "not_me"},
        {"uid": "u", "eventId": "e", "runId": "r", "photoId": "b", "verdict": "confirmed"},
        {"uid": "u", "eventId": "e", "runId": "r", "photoId": "c", "verdict": "confirmed"},
        {"uid": "u", "eventId": "e", "runId": "r", "photoId": "d", "verdict": "confirmed", "reason": "friend"},
        {"uid": "u", "eventId": "e", "runId": "r", "photoId": "e", "verdict": "not_me"},
    ]
    pts = judged_points(runs, fb)
    assert sorted(pts) == [(4.6, 0), (4.7, 1), (6.2, 1), (9.0, 0)]  # friend tag excluded
    table = isotonic_buckets(pts, min_bucket=1)
    rates = [r for _, r, _ in table]
    assert rates == sorted(rates)  # never falls as z rises
    assert sum(n for _, _, n in table) == 4
