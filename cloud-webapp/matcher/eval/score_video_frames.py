#!/usr/bin/env python3
"""
score_video_frames.py — turn the judgments into the Phase 0 gate decision.

    python eval/score_video_frames.py --report /tmp/video-spike/report.json \
        --judgments /tmp/video-spike/judgments.csv

The evidence bar (VIDEO_FRAME_EXTRACTION_DEV_PLAN.md §2.3 Phase 0.4) — all three
must hold, per selector:

  precision   ≥ 0.80   of the stills it published, judged "a volunteer would
                       have published this"
  near-dups   ≤ 0.10   of published stills judged essentially the same moment as
                       an earlier keep
  coverage    = 1.00   every clip that clearly shows a runner yielded ≥1 keep

A selector that fails does NOT proceed to Phase 1 — re-tune and re-judge. A
baseline that passes is a win: adopt it and delete the machinery it beats
(plan §2.3 Phase 0.3).

Precision counts near-dups as keeps when they were judged keep — a redundant
still is still a publishable photo, and double-penalising it would hide which of
the two problems a selector actually has.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import defaultdict

BAR_PRECISION = 0.80
BAR_NEAR_DUP = 0.10
BAR_COVERAGE = 1.00


def read_judgments(path: str) -> tuple[dict, dict]:
    """Returns ({(selector, stem, file): {verdict, dup}}, {stem: has_runner})."""
    frames: dict[tuple[str, str, str], dict] = {}
    clips: dict[str, bool] = {}
    with open(path, newline="") as fh:
        for row in csv.DictReader(fh):
            kind = (row.get("kind") or "").strip()
            if kind == "clip":
                clips[row["stem"].strip()] = (row["verdict"].strip() == "runner")
            elif kind == "frame":
                key = (row["selector"].strip(), row["stem"].strip(), row["file"].strip())
                frames[key] = {"verdict": row["verdict"].strip(),
                               "dup": (row.get("near_dup") or "0").strip() == "1"}
    return frames, clips


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--report", required=True)
    ap.add_argument("--judgments", required=True)
    ap.add_argument("--out", help="write the scorecard as JSON here")
    ap.add_argument("--bar-precision", type=float, default=BAR_PRECISION)
    ap.add_argument("--bar-near-dup", type=float, default=BAR_NEAR_DUP)
    ap.add_argument("--bar-coverage", type=float, default=BAR_COVERAGE)
    a = ap.parse_args()

    with open(os.path.expanduser(a.report)) as fh:
        report = json.load(fh)
    frames, clip_has_runner = read_judgments(os.path.expanduser(a.judgments))

    if not frames:
        print("judgments.csv has no frame rows — judge the review page first", file=sys.stderr)
        return 2

    per_selector: dict[str, dict] = defaultdict(lambda: {
        "published": 0, "judged": 0, "keep": 0, "reject": 0, "dup": 0,
        "clips_with_runner": 0, "clips_covered": 0, "uncovered": [],
        "cpu_s": 0.0, "video_s": 0.0, "unjudged": [],
    })

    for r in report.get("results", []):
        sel, stem = r["selector"], r["stem"]
        s = per_selector[sel]
        s["cpu_s"] += r["cost"]["cpu_s"]
        s["video_s"] += float(r["video"]["duration_s"] or 0.0)

        keeps_here = 0
        for row in r.get("accepted", []):
            s["published"] += 1
            j = frames.get((sel, stem, row["file"]))
            if not j:
                s["unjudged"].append(f"{stem}/{row['file']}")
                continue
            s["judged"] += 1
            if j["verdict"] == "keep":
                s["keep"] += 1
                keeps_here += 1
                if j["dup"]:
                    s["dup"] += 1
            else:
                s["reject"] += 1

        if clip_has_runner.get(stem):
            s["clips_with_runner"] += 1
            if keeps_here:
                s["clips_covered"] += 1
            else:
                s["uncovered"].append(stem)

    unmarked = [r["stem"] for r in report.get("results", [])
                if r["stem"] not in clip_has_runner]
    if unmarked:
        print(f"NOTE: {len(sorted(set(unmarked)))} clip(s) not marked runner/no-runner — "
              f"excluded from coverage: {', '.join(sorted(set(unmarked)))}\n", file=sys.stderr)

    scorecard = {}
    print(f"{'selector':16s} {'prec':>6s} {'ndup':>6s} {'cover':>7s} "
          f"{'kept':>5s} {'cpu-s/vid-s':>12s}  verdict")
    print("-" * 76)
    for sel, s in sorted(per_selector.items()):
        precision = s["keep"] / s["judged"] if s["judged"] else 0.0
        ndup = s["dup"] / s["published"] if s["published"] else 0.0
        coverage = (s["clips_covered"] / s["clips_with_runner"]
                    if s["clips_with_runner"] else float("nan"))
        cost = s["cpu_s"] / s["video_s"] if s["video_s"] else 0.0
        fails = []
        if precision < a.bar_precision:
            fails.append(f"precision {precision:.2f} < {a.bar_precision:.2f}")
        if ndup > a.bar_near_dup:
            fails.append(f"near-dups {ndup:.2f} > {a.bar_near_dup:.2f}")
        if s["clips_with_runner"] and coverage < a.bar_coverage:
            fails.append(f"coverage {coverage:.2f} < {a.bar_coverage:.2f} "
                         f"(missed {', '.join(s['uncovered'])})")
        verdict = "PASS" if not fails else "FAIL"
        cov_txt = "n/a" if s["clips_with_runner"] == 0 else f"{coverage:.2f}"
        print(f"{sel:16s} {precision:6.2f} {ndup:6.2f} {cov_txt:>7s} "
              f"{s['published']:5d} {cost:12.2f}  {verdict}")
        for f in fails:
            print(f"{'':16s}   ✗ {f}")
        if s["unjudged"]:
            print(f"{'':16s}   ! {len(s['unjudged'])} published still(s) unjudged "
                  f"(excluded from precision)")
        scorecard[sel] = {
            "precision": round(precision, 4), "near_dup_rate": round(ndup, 4),
            "coverage": None if s["clips_with_runner"] == 0 else round(coverage, 4),
            "published": s["published"], "judged": s["judged"], "keep": s["keep"],
            "reject": s["reject"], "near_dups": s["dup"],
            "clips_with_runner": s["clips_with_runner"], "uncovered": s["uncovered"],
            "cpu_s": round(s["cpu_s"], 1),
            "cpu_s_per_video_s": round(cost, 3),
            "unjudged": len(s["unjudged"]), "verdict": verdict, "fails": fails,
        }

    passing = [s for s, v in scorecard.items() if v["verdict"] == "PASS"]
    print()
    if not passing:
        print("No selector clears the bar → do NOT start Phase 1. Re-tune thresholds "
              "(every Config field is a flag) and re-judge.")
    elif "ours" in passing and len(passing) > 1:
        cheaper = [s for s in passing if s != "ours"
                   and scorecard[s]["cpu_s_per_video_s"] < scorecard["ours"]["cpu_s_per_video_s"]]
        if cheaper:
            print(f"A cheaper selector also passes ({', '.join(cheaper)}) — per plan §2.3, "
                  f"adopt it and delete the machinery it beats.")
        else:
            print("'ours' passes; the cheaper arms do not beat it on cost. Promote it to "
                  "indexer/video_frames.py (Phase 1).")
    elif "ours" in passing:
        print("'ours' passes and the baselines do not — Phase 1 as planned.")
    else:
        print(f"Only {', '.join(passing)} passes. That is a win, not a failure: adopt the "
              f"simpler selector and drop stage B (plan §2.3 Phase 0.3).")

    if a.out:
        with open(os.path.expanduser(a.out), "w") as fh:
            json.dump({"bar": {"precision": a.bar_precision, "near_dup": a.bar_near_dup,
                               "coverage": a.bar_coverage},
                       "selectors": scorecard}, fh, indent=2)
        print(f"\nscorecard: {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
