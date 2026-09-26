"""Tests for monthly_calibration.py — pure logic over hand-built run/vote docs.

What they pin, because each is how an unattended report goes wrong:
  - its copy of the badge knots matches production (web results.ts);
  - it proposes RAISING a cutoff when the evidence says so, and never proposes
    LOWERING one (a lower cutoff admits photos nobody judged);
  - it proposes a badge re-fit only on real drift;
  - the report carries no uid or email.
"""

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import monthly_calibration as mc  # noqa: E402

NOW = datetime(2026, 10, 1, tzinfo=timezone.utc)
RESULTS_TS = os.path.join(os.path.dirname(__file__), "..", "..", "web", "src", "lib", "results.ts")


def _iso(days_ago: float) -> str:
    return (NOW - timedelta(days=days_ago)).isoformat()


def _run(rid, faces, cutoff=4.5, days_ago=5, uid="u1", **kw):
    """A T-normed run whose results are the photos at or above `cutoff`."""
    shown = [p for p, z in faces.items() if z >= cutoff]
    base = {
        "id": rid,
        "uid": uid,
        "createdAt": _iso(days_ago),
        "algo": {"version": "2026.09-g+abcd1234", "tnorm": True, "cutoff": cutoff,
                 "config": {"wFace": 1.0, "wPerson": 0.0}},
        "resultPhotoIds": shown,
        "scores": {p: faces[p] for p in shown},
        "faceScores": dict(faces),
        "personScores": {p: 0.0 for p in faces},
        "nearMisses": [{"photoId": p, "score": z, "faceScore": z, "personScore": 0.0}
                       for p, z in faces.items() if z < cutoff],
    }
    base.update(kw)
    return base


def _vote(rid, pid, verdict, uid="u1", days_ago=4, **kw):
    return {"runId": rid, "photoId": pid, "verdict": verdict, "uid": uid, "eventId": "ev1",
            "createdAt": _iso(days_ago), "searchVersion": "2026.09-g+abcd1234", **kw}


def test_knot_copy_matches_production_badge():
    with open(RESULTS_TS, encoding="utf-8") as f:
        src = f.read()
    block = re.search(r"Z_CALIBRATION[^=]*=\s*\[(.*?)\];", src, re.S).group(1)
    web = [(float(z), float(p)) for z, p in re.findall(r"\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]", block)]
    assert web == [(float(z), float(p)) for z, p in mc.CURRENT_Z_CALIBRATION]
    assert int(re.search(r"LIKELY_PCT\s*=\s*(\d+)", src).group(1)) == mc.LIKELY_PCT


def test_is_hard_mirrors_the_web_rule():
    k = mc.CURRENT_Z_CALIBRATION
    assert mc.is_hard(4.6, None, k) is True        # Possible
    assert mc.is_hard(5.5, None, k) is False       # Likely
    assert mc.is_hard(9.0, "expanded", k) is True  # "see more", whatever its score


def test_engagement_counts_the_window_only():
    runs = [
        _run("r1", {"a": 7.0, "b": 4.6}, canExpand=True, expandedAt=_iso(4)),
        _run("r2", {"c": 3.0}),                   # zero results
        _run("r3", {"d": 8.0}, days_ago=60),      # outside the window
    ]
    window = [r for r in runs if r["id"] != "r3"]
    fb = [_vote("r1", "a", "confirmed", reason="me"), _vote("r1", "b", "not_me"),
          _vote("r3", "d", "confirmed")]
    e = mc.engagement(window, fb, mc.CURRENT_Z_CALIBRATION)
    assert e["searches"] == 2 and e["votes"] == 2
    assert e["zeroResultRate"] == 0.5
    assert e["seeMoreOffered"] == 0.5 and e["seeMoreUsedWhenOffered"] == 1.0
    assert e["hardToCallVoteShare"] == 0.5         # the vote on b (z 4.6)


def _cutoff_fixture(wrong_above: int, right_above: int, cutoff=4.5):
    """`right_above` right and `wrong_above` wrong photos at z 4.7 (just above the
    cutoff), plus 150 right photos at z 7 — enough judged pairs to propose."""
    runs, fb = [], []
    for i in range(150):
        runs.append(_run(f"s{i}", {f"s{i}": 7.0}, cutoff=cutoff))
        fb.append(_vote(f"s{i}", f"s{i}", "confirmed", uid=f"u{i}"))
    for i in range(right_above):
        runs.append(_run(f"r{i}", {f"r{i}": 4.7}, cutoff=cutoff))
        fb.append(_vote(f"r{i}", f"r{i}", "confirmed", uid=f"v{i}"))
    for i in range(wrong_above):
        runs.append(_run(f"w{i}", {f"w{i}": 4.7}, cutoff=cutoff))
        fb.append(_vote(f"w{i}", f"w{i}", "not_me", uid=f"x{i}"))
    return runs, fb


def test_proposes_raising_the_cutoff_when_precision_misses_the_target():
    runs, fb = _cutoff_fixture(wrong_above=60, right_above=10)
    rev = mc.cutoff_review(runs, fb, runs)
    assert rev["liveCutoff"] == 4.5
    assert rev["proposal"] is not None
    assert "4.5 → 5.0" in rev["proposal"]["change"]


def test_no_proposal_when_precision_is_fine():
    runs, fb = _cutoff_fixture(wrong_above=2, right_above=30)
    assert mc.cutoff_review(runs, fb, runs)["proposal"] is None


def test_never_proposes_lowering_only_notes_it():
    # Strong evidence below the cutoff (see-more votes all "me") must not become
    # a lowering PROPOSAL — only a note that sends a person to a replay.
    runs, fb = _cutoff_fixture(wrong_above=0, right_above=5)
    for i in range(30):
        runs.append(_run(f"b{i}", {f"b{i}": 4.2}))
        fb.append(_vote(f"b{i}", f"b{i}", "confirmed", uid=f"b{i}", tier="expanded"))
    rev = mc.cutoff_review(runs, fb, runs)
    assert rev["proposal"] is None
    assert rev["note"] and "replay" in rev["note"]


def test_badge_refit_proposes_only_on_drift():
    k = mc.CURRENT_Z_CALIBRATION
    # Votes that agree with the current badge → no proposal.
    runs, fb = [], []
    for i in range(400):
        z = 4.5 + (i % 40) * 0.1
        p_me = mc.interpolate(k, z) / 100
        runs.append(_run(f"a{i}", {f"a{i}": z}))
        fb.append(_vote(f"a{i}", f"a{i}", "confirmed" if (i * 37 % 100) < p_me * 100 else "not_me", uid=f"a{i}"))
    agree = mc.badge_refit(runs, fb, k, min_bucket=40)
    # Everything "me" → the badge now undersells the low end → proposal.
    fb_all_me = [dict(v, verdict="confirmed") for v in fb]
    drift = mc.badge_refit(runs, fb_all_me, k, min_bucket=40)
    assert drift["proposal"] is not None and drift["maxDriftPts"] >= mc.BADGE_DRIFT_PTS
    assert agree["maxDriftPts"] < drift["maxDriftPts"]


def test_report_holds_no_personal_data_and_renders():
    runs, fb = _cutoff_fixture(wrong_above=60, right_above=10)
    for v in fb:
        v["email"] = f"{v['uid']}@example.org"
    rep = mc.build_report(runs, fb, NOW)
    blob = json.dumps(rep)
    assert "@example.org" not in blob
    assert not any(f'"u{i}"' in blob for i in range(150))
    md = mc.to_markdown(rep, "proj")
    assert "raise MATCHER_NORM_THRESHOLD" in md
    assert "Nothing here has been applied" in md
