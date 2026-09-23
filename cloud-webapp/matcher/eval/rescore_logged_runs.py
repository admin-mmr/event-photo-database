#!/usr/bin/env python3
"""
rescore_logged_runs.py — re-tune the cutoff and fusion weights from LOGGED
searches, with no selfies and no models.

Every T-normed search stores, per candidate, its face and outfit z-scores: the
results above the cutoff, and (since the near-miss band) the candidates just
below it. Re-fusing those with other weights and gating them at another cutoff
answers "what would members have seen?" for every past search, including ones
whose selfie has since been deleted (90 days after upload) — the thing that made
a full replay of the July baseline event impossible.

What it can and cannot say:
  - Raising the cutoff: exact. Every photo that drops out was shown, so its
    votes say what was lost.
  - Lowering the cutoff: only as far as the logged band reaches, and the photos
    it admits were mostly never shown, so they are mostly UNJUDGED. They are
    counted separately ("admitted"), never scored as right or wrong. Votes from
    "see more" are the exception — those photos were shown and judged.
  - Only the latest vote per (member, photo) counts (export_feedback_labels).

Usage:
    python eval/rescore_logged_runs.py --project mmr-data-pipeline [--event-id <id>] \\
        [--cutoffs '4.0;4.5;5.0'] [--weights '0.85:0.15;1.0:0.0'] [--report out.json]
    python eval/rescore_logged_runs.py --runs-json runs.json --feedback-json fb.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from typing import Any, Iterable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from export_feedback_labels import latest_votes  # noqa: E402

DEFAULT_CUTOFFS = "4.0;4.25;4.5;4.75;5.0"
DEFAULT_WEIGHTS = "0.85:0.15;0.9:0.1;1.0:0.0"


def candidates_of(run: dict[str, Any]) -> list[tuple[str, float | None, float | None]]:
    """(photoId, faceScore, personScore) for every logged candidate of a run:
    its results plus its near-miss band. A run without per-modality scores
    (logged before 2026-07-29) contributes nothing — its fused score can't be
    re-weighted."""
    out: list[tuple[str, float | None, float | None]] = []
    faces = run.get("faceScores") or {}
    persons = run.get("personScores") or {}
    if not faces and not persons:
        return out
    for pid in run.get("resultPhotoIds") or []:
        out.append((pid, faces.get(pid), persons.get(pid)))
    for h in run.get("nearMisses") or []:
        if isinstance(h, dict) and isinstance(h.get("photoId"), str):
            out.append((h["photoId"], h.get("faceScore"), h.get("personScore")))
    return out


def rescore(
    runs: Iterable[dict[str, Any]],
    feedback: Iterable[dict[str, Any]],
    cutoffs: list[float],
    weights: list[tuple[float, float]],
) -> dict[str, Any]:
    """Judged right/wrong kept, and unjudged photos admitted, per (weights, cutoff).

    Only T-normed runs are used: raw-cosine runs live on another scale, and mixing
    the two would make one cutoff mean two things."""
    label: dict[tuple[str, str], str] = {}
    for fb in latest_votes(feedback):
        v = str(fb.get("verdict", ""))
        reason = str(fb.get("reason") or "me")
        run_id = str(fb.get("runId") or "")
        if v == "not_me":
            label[(run_id, str(fb.get("photoId", "")))] = "wrong"
        elif v == "confirmed" and reason == "me":
            label[(run_id, str(fb.get("photoId", "")))] = "right"

    used = 0
    shown_at_run: dict[str, set[str]] = {}
    per_run: list[tuple[str, list[tuple[str, float | None, float | None]]]] = []
    for run in runs:
        if not (run.get("algo") or {}).get("tnorm"):
            continue
        cands = candidates_of(run)
        if not cands:
            continue
        rid = str(run.get("id") or run.get("runId") or "")
        per_run.append((rid, cands))
        shown_at_run[rid] = set(run.get("resultPhotoIds") or []) | set(run.get("expandedPhotoIds") or [])
        used += 1

    table = []
    for wf, wp in weights:
        for t in cutoffs:
            right = wrong = admitted = 0
            for rid, cands in per_run:
                for pid, f, p in cands:
                    score = wf * (f or 0.0) + wp * (p or 0.0)
                    if score < t:
                        continue
                    lab = label.get((rid, pid))
                    if lab == "right":
                        right += 1
                    elif lab == "wrong":
                        wrong += 1
                    elif pid not in shown_at_run[rid]:
                        admitted += 1
            judged = right + wrong
            table.append(
                {
                    "w_face": wf,
                    "w_person": wp,
                    "cutoff": t,
                    "right": right,
                    "wrong": wrong,
                    "precision": (right / judged) if judged else None,
                    "admitted_unjudged": admitted,
                }
            )
    return {"runs_used": used, "judged_pairs": len(label), "table": table}


def _parse_weights(spec: str) -> list[tuple[float, float]]:
    out = []
    for part in spec.split(";"):
        if part.strip():
            wf, _, wp = part.partition(":")
            out.append((float(wf), float(wp)))
    return out


def _load_firestore(project: str, event_id: str) -> tuple[list[dict], list[dict]]:
    from google.cloud import firestore  # type: ignore

    db = firestore.Client(project=project)
    runs_q = db.collection("match_runs")
    fb_q = db.collection("match_feedback")
    if event_id:
        runs_q = runs_q.where(filter=firestore.FieldFilter("eventId", "==", event_id))
        fb_q = fb_q.where(filter=firestore.FieldFilter("eventId", "==", event_id))
    runs = [d.to_dict() | {"id": d.id} for d in runs_q.stream()]
    feedback = [d.to_dict() for d in fb_q.stream()]
    return runs, feedback


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", default="")
    ap.add_argument("--event-id", default="")
    ap.add_argument("--runs-json", default="")
    ap.add_argument("--feedback-json", default="")
    ap.add_argument("--cutoffs", default=DEFAULT_CUTOFFS)
    ap.add_argument("--weights", default=DEFAULT_WEIGHTS)
    ap.add_argument("--report", default="")
    args = ap.parse_args()

    if args.project:
        runs, feedback = _load_firestore(args.project, args.event_id)
    elif args.runs_json and args.feedback_json:
        with open(args.runs_json, encoding="utf-8") as f:
            runs = json.load(f)
        with open(args.feedback_json, encoding="utf-8") as f:
            feedback = json.load(f)
    else:
        raise SystemExit("ERROR: provide --project OR (--runs-json AND --feedback-json)")

    cutoffs = [float(x) for x in args.cutoffs.split(";") if x.strip()]
    rep = rescore(runs, feedback, cutoffs, _parse_weights(args.weights))
    print(f"{rep['runs_used']} T-normed runs with per-modality scores; {rep['judged_pairs']} judged pairs")
    print(f"  {'wF':>5} {'wP':>5} {'cutoff':>6}   {'right':>6} {'wrong':>6}  {'P':>6}   admitted-unjudged")
    for r in rep["table"]:
        p = f"{r['precision']:.3f}" if r["precision"] is not None else "   n/a"
        print(
            f"  {r['w_face']:>5.2f} {r['w_person']:>5.2f} {r['cutoff']:>6.2f}   "
            f"{r['right']:>6} {r['wrong']:>6}  {p}   {r['admitted_unjudged']}"
        )
    print("  → a lower cutoff's 'admitted' photos were never shown, so they are unjudged, not wrong.")
    if args.report:
        with open(args.report, "w", encoding="utf-8") as f:
            json.dump(rep, f, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
