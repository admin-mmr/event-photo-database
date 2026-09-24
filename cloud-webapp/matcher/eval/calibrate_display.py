#!/usr/bin/env python3
"""
calibrate_display.py — fit the Find-Me confidence badge to members' votes.

Since T-norm went live (2026-07-22) a result's score is a z-value (how many
standard deviations above the event's crowd it sits), and every shown result is
at least the cutoff (4.5). The old badge mapped RAW cosine through a fixed curve,
so every z result read "Strong · 99%". This fits the badge to evidence instead:
for T-normed results members voted on, the share they said "that's me" to, as a
monotone function of the fused z (isotonic regression by pool-adjacent-violators).

It prints the knot table for `web/src/lib/results.ts` (Z_CALIBRATION) plus the
band split it implies. Re-run it as votes accumulate — the monthly calibration
job (quality plan Item 17) is where this belongs.

Caveat, stated on the badge's own docstring too: votes come from results members
chose to judge, mostly near the top of a page, so this is judged precision, not a
true probability over everything shown.

Usage:
    python eval/calibrate_display.py --project mmr-data-pipeline [--min-z 4.0] [--min-bucket 100]

`--min-z` keeps the fit to what members can see today (results start at the
cutoff; "see more" reaches one 0.5 step below it). Older searches ran at lower
cutoffs, and letting them in lumps a wide low range into one misleading knot.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import defaultdict
from typing import Any, Iterable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from export_feedback_labels import latest_votes  # noqa: E402

BUCKET_Z = 0.25


def judged_points(runs: Iterable[dict[str, Any]], feedback: Iterable[dict[str, Any]]) -> list[tuple[float, int]]:
    """(fused z, 1 if "me" else 0) for every judged T-normed result, latest vote
    per (member, photo); friend/group tags are not a judgement of the searcher."""
    label: dict[tuple[str, str], int] = {}
    for fb in latest_votes(feedback):
        v, reason = fb.get("verdict"), fb.get("reason") or "me"
        key = (str(fb.get("runId") or ""), str(fb.get("photoId") or ""))
        if v == "not_me":
            label[key] = 0
        elif v == "confirmed" and reason == "me":
            label[key] = 1
    out = []
    for run in runs:
        if not (run.get("algo") or {}).get("tnorm"):
            continue
        rid = str(run.get("id") or "")
        for pid, score in (run.get("scores") or {}).items():
            y = label.get((rid, pid))
            if y is not None and isinstance(score, (int, float)):
                out.append((float(score), y))
    return out


def isotonic_buckets(points: list[tuple[float, int]], min_bucket: int) -> list[tuple[float, float, int]]:
    """Bucket by z, merge thin buckets upward, then pool adjacent violators so the
    rate never falls as z rises. Returns [(mean z of the block's votes, rate, n)] —
    the MEAN z, not a bucket midpoint, because a merged block can span several
    buckets and its votes are rarely spread evenly across them."""
    by: dict[float, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])  # z_sum, yes, n
    for z, y in points:
        b = int(z / BUCKET_Z) * BUCKET_Z
        by[b][0] += z
        by[b][1] += y
        by[b][2] += 1
    blocks: list[list[float]] = []
    for _, (zs, s, n) in sorted(by.items()):  # merge a bucket into the next until it has min_bucket votes
        if blocks and blocks[-1][2] < min_bucket:
            blocks[-1][0] += zs
            blocks[-1][1] += s
            blocks[-1][2] += n
        else:
            blocks.append([zs, s, n])
    if len(blocks) > 1 and blocks[-1][2] < min_bucket:
        tail = blocks.pop()
        for k in range(3):
            blocks[-1][k] += tail[k]
    i = 0
    while i < len(blocks) - 1:  # pool adjacent violators
        if blocks[i][1] / blocks[i][2] > blocks[i + 1][1] / blocks[i + 1][2]:
            for k in range(3):
                blocks[i][k] += blocks[i + 1][k]
            del blocks[i + 1]
            i = max(i - 1, 0)
        else:
            i += 1
    return [(zs / n, s / n, int(n)) for zs, s, n in blocks]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", required=True)
    ap.add_argument("--min-bucket", type=int, default=100)
    ap.add_argument("--min-z", type=float, default=4.0)
    args = ap.parse_args()

    from google.cloud import firestore  # type: ignore

    db = firestore.Client(project=args.project)
    runs = [d.to_dict() | {"id": d.id} for d in db.collection("match_runs").stream()]
    feedback = [d.to_dict() for d in db.collection("match_feedback").stream()]
    pts = [p for p in judged_points(runs, feedback) if p[0] >= args.min_z]
    print(f"{len(pts)} judged T-normed results")
    table = isotonic_buckets(pts, args.min_bucket)
    print("  z      me-rate    n")
    for z, rate, n in table:
        print(f"  {z:5.2f}  {rate:6.3f}  {n:5d}")
    print("\nZ_CALIBRATION knots for web/src/lib/results.ts:")
    print("  " + ", ".join(f"[{z:.2f}, {round(rate * 100)}]" for z, rate, _ in table))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
