#!/usr/bin/env python3
"""
monthly_calibration.py — the Find-Me monthly calibration report (quality plan Item 17).

Runs as the `findme-calibration` Cloud Run job on the 1st of each month
(`infra/scripts/deploy-calibration-job.sh`, `provision-calibration-scheduler.sh`)
and writes a report to `gs://<project>-derivatives/eval/calibration/<date>.{json,md}`.

It works from LOGS ONLY — `match_runs` (scores, near-miss band, cutoff) and
`match_feedback` (votes). No selfies, no models, no biometric processing, so it
is cheap and can run unattended. It covers:

  1. Engagement over the last WINDOW_DAYS: searches, vote participation,
     zero-result rate, "see more" rate (the recall proxy), keep reasons, and the
     share of votes on hard-to-call photos (how Item 16 is measured).
  2. Judged precision per event, with the evidence bar.
  3. The confidence badge re-fit (calibrate_display.py) against the knots in
     production, with a PROPOSED knot table when they have drifted.
  4. A cutoff re-score (rescore_logged_runs.py) around the live cutoff, with a
     PROPOSED change only when the evidence supports one.
  5. Events worth a full replay (the one thing logs cannot test: a new model,
     anchors, face quality) — listed with the command, never run from here.

**It changes nothing.** Every proposal is text for a person to review and apply
by hand (guardrails: fusion/threshold changes are human-approved, never
auto-tuned). The report holds only aggregates and event ids — no uids, emails
or selfies.

Usage:
    python eval/monthly_calibration.py --project mmr-data-pipeline [--report-gcs gs://…/2026-10-01]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from calibrate_display import isotonic_buckets, judged_points  # noqa: E402
from export_feedback_labels import (  # noqa: E402
    MIN_DISTINCT_USERS,
    MIN_JUDGED_PAIRS,
    build_label_rows,
    group_by_event,
    judged_precision,
    latest_votes,
)
from rescore_logged_runs import rescore  # noqa: E402

# The badge knots live in production in web/src/lib/results.ts (Z_CALIBRATION).
# This is a COPY — the job image has no web source — pinned to it by
# test_monthly_calibration.py, which parses results.ts. Change one, change both.
CURRENT_Z_CALIBRATION: list[tuple[float, float]] = [
    (4.12, 39), (4.36, 57), (4.77, 74), (5.13, 87), (5.38, 90),
    (5.63, 92), (6.14, 95), (6.75, 96), (7.38, 97), (8.87, 98),
]
# web LIKELY_PCT: below it the badge reads "Possible" — the hard-to-call band.
LIKELY_PCT = 85

WINDOW_DAYS = 30
# Selfies go 90 days after upload, so only recent voters can still be replayed.
REPLAY_WINDOW_DAYS = 60
# Where the badge is compared, and how far it may drift before a re-fit is proposed.
BADGE_PROBE_Z = [4.5, 5.0, 5.5, 6.0, 7.0]
BADGE_DRIFT_PTS = 5
# The guardrail's judged-precision target, applied to the precision of results
# at or above a cutoff.
TARGET_PRECISION = 0.85
# Pooled judged pairs a cutoff proposal needs — well above the per-event evidence
# bar, because this one number moves every event at once.
MIN_PAIRS_FOR_PROPOSAL = 100
CUTOFF_STEP = 0.5
DEFAULT_CUTOFF = 4.5
DEFAULT_WEIGHTS = (0.85, 0.15)


# ── small helpers ───────────────────────────────────────────────────────────


def interpolate(knots: list[tuple[float, float]], z: float) -> float:
    """Same rule as web `interpolate`: hold the ends, linear between knots."""
    if z <= knots[0][0]:
        return knots[0][1]
    if z >= knots[-1][0]:
        return knots[-1][1]
    for (x0, y0), (x1, y1) in zip(knots, knots[1:]):
        if z <= x1:
            return y0 + (y1 - y0) * (z - x0) / (x1 - x0)
    return knots[-1][1]


def _parse_ts(v: Any) -> datetime | None:
    if not isinstance(v, str) or not v:
        return None
    try:
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _since(runs_or_votes: Iterable[dict[str, Any]], since: datetime) -> list[dict[str, Any]]:
    out = []
    for d in runs_or_votes:
        ts = _parse_ts(d.get("createdAt"))
        if ts is not None and ts >= since:
            out.append(d)
    return out


def _mode(values: Iterable[Any], default: Any) -> Any:
    c = Counter(v for v in values if v is not None)
    return c.most_common(1)[0][0] if c else default


def is_hard(score: Any, tier: Any, knots: list[tuple[float, float]]) -> bool:
    """Mirror of web `isHardToCall` on the z scale: a "see more" result, or one
    whose calibrated badge is below LIKELY_PCT."""
    if tier == "expanded":
        return True
    return isinstance(score, (int, float)) and interpolate(knots, float(score)) < LIKELY_PCT


# ── report sections ─────────────────────────────────────────────────────────


def engagement(runs: list[dict[str, Any]], feedback: list[dict[str, Any]], knots) -> dict[str, Any]:
    """The live feedback signals for one window of runs and the votes on them."""
    run_ids = {str(r.get("id") or "") for r in runs}
    votes = [fb for fb in latest_votes(feedback) if str(fb.get("runId") or "") in run_ids]
    by_run: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for fb in votes:
        by_run[str(fb.get("runId"))].append(fb)

    shown = sum(len(r.get("resultPhotoIds") or []) + len(r.get("expandedPhotoIds") or []) for r in runs)
    offered = [r for r in runs if r.get("canExpand") is True]
    expanded = [r for r in offered if r.get("expandedAt")]
    zero = [r for r in runs if not (r.get("resultPhotoIds") or [])]

    scores_by_run = {str(r.get("id") or ""): r.get("scores") or {} for r in runs}
    tnorm_by_run = {str(r.get("id") or ""): bool((r.get("algo") or {}).get("tnorm")) for r in runs}
    hard_votes = 0
    tnorm_votes = 0
    for fb in votes:
        rid = str(fb.get("runId"))
        if not tnorm_by_run.get(rid):
            continue
        tnorm_votes += 1
        if is_hard(scores_by_run.get(rid, {}).get(fb.get("photoId")), fb.get("tier"), knots):
            hard_votes += 1

    def share(n: int, d: int) -> float | None:
        return round(n / d, 4) if d else None

    return {
        "searches": len(runs),
        "searchers": len({r.get("uid") for r in runs if r.get("uid")}),
        "searchesWithAVote": share(len(by_run), len(runs)),
        "resultsShown": shown,
        "votes": len(votes),
        "shareOfShownJudged": share(len(votes), shown),
        "zeroResultRate": share(len(zero), len(runs)),
        "seeMoreOffered": share(len(offered), len(runs)),
        "seeMoreUsedWhenOffered": share(len(expanded), len(offered)),
        "keepReasons": dict(Counter(str(fb.get("reason") or "me") for fb in votes if fb.get("verdict") == "confirmed")),
        # Item 16's measure: of the votes on T-normed searches, how many landed on
        # the hard-to-call photos rather than the obvious top matches.
        "hardToCallVoteShare": share(hard_votes, tnorm_votes),
    }


def current_generation(runs: list[dict[str, Any]]) -> str:
    """The generation of the NEWEST search: `algo.version` up to the `+`
    fingerprint (e.g. `2026.09-tnorm45-multiref-prf`). Newest, not most common —
    in the month after a bump most searches still carry the old tag, and the
    question is how the ranker running NOW is doing."""
    newest = max(runs, key=lambda r: str(r.get("createdAt") or ""), default=None)
    return str(((newest or {}).get("algo") or {}).get("version") or "").split("+")[0]


def per_event_precision(
    feedback: list[dict[str, Any]], runs_by_id: dict[str, dict[str, Any]], generation: str
) -> list[dict[str, Any]]:
    """Judged precision per event, counting only votes cast under `generation`.
    Older rankers surfaced weaker matches, so their votes carry a far higher
    "not me" rate that says nothing about today's quality."""
    rows = [r for r in build_label_rows(feedback, runs_by_id) if r["search_version"].startswith(generation)]
    out = []
    for event_id, ev_rows in sorted(group_by_event(rows).items()):
        jp = judged_precision(ev_rows)
        out.append({"eventId": event_id, **jp})
    return out


def badge_refit(runs: list[dict[str, Any]], feedback: list[dict[str, Any]], current, min_z=4.0, min_bucket=100):
    pts = [p for p in judged_points(runs, feedback) if p[0] >= min_z]
    table = isotonic_buckets(pts, min_bucket) if pts else []
    fitted = [(round(z, 2), round(rate * 100)) for z, rate, _ in table]
    drift = []
    if len(fitted) >= 2:
        for z in BADGE_PROBE_Z:
            now, new = interpolate(current, z), interpolate(fitted, z)
            drift.append({"z": z, "currentPct": round(now), "fittedPct": round(new), "diff": round(new - now)})
    worst = max((abs(d["diff"]) for d in drift), default=0)
    propose = len(fitted) >= 2 and worst >= BADGE_DRIFT_PTS
    return {
        "judgedPoints": len(pts),
        "fittedKnots": fitted,
        "drift": drift,
        "maxDriftPts": worst,
        "proposal": (
            {
                "file": "cloud-webapp/web/src/lib/results.ts (Z_CALIBRATION) + eval/monthly_calibration.py (CURRENT_Z_CALIBRATION)",
                "knots": "  " + ", ".join(f"[{z:.2f}, {p}]" for z, p in fitted),
                "why": f"the badge is off by up to {worst} points from what members' votes now say",
            }
            if propose
            else None
        ),
    }


def cutoff_review(runs: list[dict[str, Any]], feedback: list[dict[str, Any]], window_runs: list[dict[str, Any]]):
    """Re-score the logged candidates around the live cutoff at the live weights.

    Raising the cutoff is scored exactly: every photo it drops was shown and some
    were judged. Lowering is NOT — the photos it would admit were mostly never
    shown — so the only below-cutoff evidence is the "see more" band's own votes,
    and a lowering is flagged for a replay, never proposed outright."""
    cutoff = float(_mode(((r.get("algo") or {}).get("cutoff") for r in window_runs), DEFAULT_CUTOFF))
    cfgs = [(r.get("algo") or {}).get("config") or {} for r in window_runs]
    wf = float(_mode((c.get("wFace") for c in cfgs), DEFAULT_WEIGHTS[0]))
    wp = float(_mode((c.get("wPerson") for c in cfgs), DEFAULT_WEIGHTS[1]))
    cutoffs = [round(cutoff + CUTOFF_STEP * k, 2) for k in (-2, -1, 0, 1, 2)]
    rep = rescore(runs, feedback, cutoffs, [(wf, wp)])
    table = rep["table"]
    at = {row["cutoff"]: row for row in table}
    cur = at[round(cutoff, 2)]
    below = at[round(cutoff - CUTOFF_STEP, 2)]
    # Votes on photos scoring one step below the cutoff. They come from "see
    # more", and from searches that ran at an older, lower cutoff — either way
    # they are the only judged evidence below it.
    band_right = below["right"] - cur["right"]
    band_wrong = below["wrong"] - cur["wrong"]
    band_pairs = band_right + band_wrong

    proposal = None
    judged = cur["right"] + cur["wrong"]
    if judged >= MIN_PAIRS_FOR_PROPOSAL and cur["precision"] is not None and cur["precision"] < TARGET_PRECISION:
        for row in table:
            if row["cutoff"] > cutoff and row["precision"] is not None and row["precision"] >= TARGET_PRECISION:
                lost = cur["right"] - row["right"]
                proposal = {
                    "change": f"raise MATCHER_NORM_THRESHOLD {cutoff} → {row['cutoff']}",
                    "why": (
                        f"judged precision at {cutoff} is {cur['precision']:.3f} (< {TARGET_PRECISION}); "
                        f"at {row['cutoff']} it is {row['precision']:.3f}, dropping {cur['wrong'] - row['wrong']} "
                        f"wrong matches for {lost} right ones"
                    ),
                    "howToApply": "change the default in matcher/main.py (NORM_THRESHOLD) and deploy — an env override does not survive a redeploy",
                }
                break
    note = None
    if band_pairs >= MIN_JUDGED_PAIRS and band_right / band_pairs >= TARGET_PRECISION:
        note = (
            f"photos scoring just below {cutoff} were judged {band_right} right / {band_wrong} wrong "
            f"({band_right / band_pairs:.2f}) — a LOWER cutoff may be worth it; confirm with a replay first"
        )
    return {
        "liveCutoff": cutoff,
        "liveWeights": {"wFace": wf, "wPerson": wp},
        "runsUsed": rep["runs_used"],
        "table": table,
        "judgedJustBelow": {"right": band_right, "wrong": band_wrong},
        "proposal": proposal,
        "note": note,
    }


def replay_candidates(feedback: list[dict[str, Any]], since: datetime, top: int = 3) -> list[dict[str, Any]]:
    """Events with the most distinct recent voters — the ones whose selfies are
    most likely still inside the 90-day window."""
    voters: dict[str, set[str]] = defaultdict(set)
    for fb in _since(feedback, since):
        if fb.get("eventId") and fb.get("uid"):
            voters[str(fb["eventId"])].add(str(fb["uid"]))
    ranked = sorted(voters.items(), key=lambda kv: (-len(kv[1]), kv[0]))[:top]
    return [{"eventId": e, "recentVoters": len(u)} for e, u in ranked if len(u) >= MIN_DISTINCT_USERS]


def build_report(runs: list[dict[str, Any]], feedback: list[dict[str, Any]], now: datetime) -> dict[str, Any]:
    since = now - timedelta(days=WINDOW_DAYS)
    window = _since(runs, since)
    runs_by_id = {str(r.get("id") or ""): r for r in runs}
    generation = current_generation(runs)
    badge = badge_refit(runs, feedback, CURRENT_Z_CALIBRATION)
    cut = cutoff_review(runs, feedback, window)
    replay = replay_candidates(feedback, now - timedelta(days=REPLAY_WINDOW_DAYS))
    return {
        "generatedAt": now.isoformat(),
        "windowDays": WINDOW_DAYS,
        "engagement": engagement(window, feedback, CURRENT_Z_CALIBRATION),
        "generation": generation,
        "perEventPrecision": per_event_precision(feedback, runs_by_id, generation),
        "badge": badge,
        "cutoff": cut,
        "replayCandidates": replay,
        "proposals": [p for p in (badge["proposal"], cut["proposal"]) if p],
    }


def _pct(v: float | None) -> str:
    return "n/a" if v is None else f"{v * 100:.1f}%"


def to_markdown(rep: dict[str, Any], project: str) -> str:
    e, b, c = rep["engagement"], rep["badge"], rep["cutoff"]
    lines = [
        f"# Find-Me calibration — {rep['generatedAt'][:10]}",
        "",
        "Logs only (no selfies, no models). **Nothing here has been applied** — each proposal needs a person.",
        "",
        f"## Last {rep['windowDays']} days",
        "",
        f"- Searches: {e['searches']} by {e['searchers']} members; {_pct(e['searchesWithAVote'])} got at least one vote",
        f"- Shown results judged: {_pct(e['shareOfShownJudged'])} ({e['votes']} of {e['resultsShown']})",
        f"- Zero-result searches: {_pct(e['zeroResultRate'])}",
        f"- \"See more\" offered on {_pct(e['seeMoreOffered'])} of searches, used on {_pct(e['seeMoreUsedWhenOffered'])} of those",
        f"- Votes on hard-to-call photos (Item 16): {_pct(e['hardToCallVoteShare'])}",
        f"- Keep reasons: {', '.join(f'{k} {v}' for k, v in sorted(e['keepReasons'].items())) or 'none'}",
        "",
        "## Proposals",
        "",
    ]
    if not rep["proposals"]:
        lines.append("None this month.")
    for p in rep["proposals"]:
        if "knots" in p:
            lines += [f"- **Re-fit the badge** — {p['why']}. New knots for {p['file']}:", "", "  ```", p["knots"], "  ```"]
        else:
            lines.append(f"- **{p['change']}** — {p['why']}. {p['howToApply']}.")
    if c["note"]:
        lines += ["", f"Note: {c['note']}."]
    lines += [
        "",
        f"## Cutoff re-score (live cutoff {c['liveCutoff']}, weights {c['liveWeights']['wFace']}/{c['liveWeights']['wPerson']})",
        "",
        "| cutoff | right | wrong | precision | admitted, unjudged |",
        "|---|---|---|---|---|",
    ]
    for row in c["table"]:
        p = "n/a" if row["precision"] is None else f"{row['precision']:.3f}"
        lines.append(f"| {row['cutoff']} | {row['right']} | {row['wrong']} | {p} | {row['admitted_unjudged']} |")
    lines += [
        "",
        "A lower cutoff's admitted photos were never shown, so they are unjudged — not wrong.",
        "",
        f"## Badge (from {b['judgedPoints']} judged T-normed results)",
        "",
        "| z | badge now | votes say |",
        "|---|---|---|",
    ]
    lines += [f"| {d['z']} | {d['currentPct']}% | {d['fittedPct']}% |" for d in b["drift"]]
    lines += [
        "",
        f"## Judged precision per event (votes under `{rep['generation'] or 'any'}`)",
        "",
        "| event | right | wrong | P | meets evidence bar |",
        "|---|---|---|---|---|",
    ]
    for ev in rep["perEventPrecision"]:
        p = "n/a" if ev.get("precision") is None else f"{ev['precision']:.3f}"
        lines.append(f"| {ev['eventId'][:8]} | {ev['confirmed']} | {ev['wrong']} | {p} | {'yes' if ev.get('meaningful') else 'no'} |")
    if rep["replayCandidates"]:
        ids = ",".join(r["eventId"] for r in rep["replayCandidates"])
        lines += [
            "",
            "## Worth a full replay",
            "",
            "Logs can't test a new model, anchors or face quality. These events have the most recent voters, so their selfies are likeliest to still exist:",
            "",
            *[f"- {r['eventId']} — {r['recentVoters']} recent voters" for r in rep["replayCandidates"]],
            "",
            "```bash",
            f"REPORT_GCS=gs://{project}-derivatives/eval/replay-{rep['generatedAt'][:10]}.json ./cloud-webapp/infra/scripts/run-replay-job.sh {project} {ids}",
            "```",
        ]
    return "\n".join(lines) + "\n"


# ── I/O ─────────────────────────────────────────────────────────────────────


def _load(project: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    from google.cloud import firestore  # type: ignore

    db = firestore.Client(project=project)
    runs = [d.to_dict() | {"id": d.id} for d in db.collection("match_runs").stream()]
    feedback = [d.to_dict() for d in db.collection("match_feedback").stream()]
    return runs, feedback


def _upload(uri_prefix: str, rep: dict[str, Any], md: str, project: str) -> None:
    from google.cloud import storage  # type: ignore

    bucket_name, _, prefix = uri_prefix.removeprefix("gs://").partition("/")
    bucket = storage.Client(project=project).bucket(bucket_name)
    bucket.blob(f"{prefix}.json").upload_from_string(json.dumps(rep, indent=2), content_type="application/json")
    bucket.blob(f"{prefix}.md").upload_from_string(md, content_type="text/markdown; charset=utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", default=os.environ.get("PROJECT", ""))
    ap.add_argument(
        "--report-gcs",
        default=os.environ.get("REPORT_GCS", ""),
        help="gs:// prefix; .json and .md are appended (default: <project>-derivatives/eval/calibration/<date>)",
    )
    ap.add_argument("--no-upload", action="store_true", help="print the report only (local runs)")
    ap.add_argument("--runs-json", default="", help="offline: JSON array of match_runs docs (each with its id)")
    ap.add_argument("--feedback-json", default="", help="offline: JSON array of match_feedback docs")
    args = ap.parse_args()
    if not args.project:
        raise SystemExit("ERROR: --project (or PROJECT) is required")

    now = datetime.now(timezone.utc)
    if args.runs_json and args.feedback_json:
        with open(args.runs_json, encoding="utf-8") as f:
            runs = json.load(f)
        with open(args.feedback_json, encoding="utf-8") as f:
            feedback = json.load(f)
    else:
        runs, feedback = _load(args.project)
    rep = build_report(runs, feedback, now)
    md = to_markdown(rep, args.project)
    print(md)
    if args.no_upload:
        return 0
    target = args.report_gcs or f"gs://{args.project}-derivatives/eval/calibration/{now:%Y-%m-%d}"
    _upload(target, rep, md, args.project)
    print(f"report written to {target}.json / .md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
