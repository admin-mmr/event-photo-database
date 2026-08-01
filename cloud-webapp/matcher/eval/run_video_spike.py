#!/usr/bin/env python3
"""
run_video_spike.py — Phase 0 harness: run every selector over a folder of real
clips, write the stills out, and measure what each one cost.

    python eval/run_video_spike.py --clips ~/event-clips --out /tmp/video-spike

Then judge the output and score it:

    python eval/make_frame_review_page.py --report /tmp/video-spike/report.json \
        --out /tmp/video-spike/review.html
    open /tmp/video-spike/review.html          # tick keep/reject, save judgments.csv
    python eval/score_video_frames.py --report /tmp/video-spike/report.json \
        --judgments /tmp/video-spike/judgments.csv

Output layout (one folder per selector so a contact sheet can put the arms side
by side on the same clip):

    <out>/<selector>/<clip-stem>/f01_t01234.jpg     accepted stills
    <out>/<selector>/<clip-stem>/rejected/…         everything dropped, for triage
    <out>/report.json                                metrics for every frame

CPU time counts the ffmpeg subprocesses (getrusage RUSAGE_CHILDREN), not just
this process — decode is most of the cheap stage's cost and all of it happens in
a child. The reported vCPU-seconds is what the plan §2.4 estimate must be
replaced with.
"""

from __future__ import annotations

import argparse
import json
import os
import resource
import sys
import time
from dataclasses import asdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import video_frames as vf  # noqa: E402

VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".3gp", ".mts", ".hevc"}
SELECTORS = ("ours", "sharpness_only", "katna_like")


def find_clips(paths: list[str]) -> list[str]:
    out: list[str] = []
    for p in paths:
        p = os.path.expanduser(p)
        if os.path.isdir(p):
            for name in sorted(os.listdir(p)):
                if os.path.splitext(name)[1].lower() in VIDEO_EXTS:
                    out.append(os.path.join(p, name))
        elif os.path.isfile(p):
            out.append(p)
    return out


def _cpu_seconds() -> float:
    """Self + children CPU seconds (user + sys)."""
    me = resource.getrusage(resource.RUSAGE_SELF)
    kids = resource.getrusage(resource.RUSAGE_CHILDREN)
    return (me.ru_utime + me.ru_stime + kids.ru_utime + kids.ru_stime)


def frame_name(idx: int, ts: float) -> str:
    return f"f{idx:02d}_t{int(round(ts * 1000)):06d}.jpg"


def cand_row(c: vf.FrameCandidate) -> dict:
    near = c.near_miss
    return {
        "ts": round(c.ts, 3),
        "score": round(c.score, 4),
        "accepted": c.accepted,
        "reasons": c.reasons,
        "dup_of": c.dup_of,
        "is_iframe": c.is_iframe,
        "width": c.width,
        "height": c.height,
        "frame_blur": round(c.frame_blur, 2),
        "scan_blur": round(c.scan_blur, 2),
        "faces": [
            {"face_px": f["face_px"], "blur": round(f["blur"], 2),
             "det_score": round(f["det_score"], 3), "warnings": f["warnings"]}
            for f in c.faces
        ],
        "persons": len(c.persons),
        "jpeg_bytes": len(c.jpeg),
        "detections": len(c.detections),
        # What the gates threw away, so a `no_publishable_face` rejection can be
        # explained and the gate re-tuned without re-running the whole spike.
        "near_miss": None if near is None else {
            "face_px": near["face_px"], "blur": round(near["blur"], 2),
            "det_score": round(near["det_score"], 3), "dropped": near["dropped"],
        },
    }


def run_clip(path: str, selector: str, cfg: vf.Config, out_root: str,
             info: vf.VideoInfo, embed) -> dict:
    stem = os.path.splitext(os.path.basename(path))[0]
    out_dir = os.path.join(out_root, selector, stem)
    rej_dir = os.path.join(out_dir, "rejected")
    os.makedirs(out_dir, exist_ok=True)

    t0, c0 = time.monotonic(), _cpu_seconds()
    result = vf.select(path, cfg, selector=selector, embed=embed, info=info)
    wall, cpu = time.monotonic() - t0, _cpu_seconds() - c0

    accepted_files = []
    for i, c in enumerate(result.accepted, start=1):
        name = frame_name(i, c.ts)
        with open(os.path.join(out_dir, name), "wb") as fh:
            fh.write(c.jpeg)
        accepted_files.append(name)

    rejected_rows = []
    for c in result.candidates:
        if c.accepted:
            continue
        rel = None
        if c.jpeg:
            os.makedirs(rej_dir, exist_ok=True)
            rel = os.path.join("rejected", f"t{int(round(c.ts * 1000)):06d}.jpg")
            with open(os.path.join(out_dir, rel), "wb") as fh:
                fh.write(c.jpeg)
        rejected_rows.append({**cand_row(c), "file": rel})

    dur = max(result.info.duration_s, 1e-6)
    return {
        "clip": os.path.basename(path),
        "stem": stem,
        "selector": selector,
        "dir": os.path.relpath(out_dir, out_root),
        "video": {**asdict(result.info)},
        "budget": result.budget,
        "scanned": result.scanned,
        "gated": result.gated,
        "shortlisted": result.shortlisted,
        "accepted_count": len(result.accepted),
        "notes": result.notes,
        "cost": {
            "wall_s": round(wall, 2),
            "cpu_s": round(cpu, 2),
            "cpu_s_per_video_s": round(cpu / dur, 3),
        },
        "accepted": [{**cand_row(c), "file": name}
                     for c, name in zip(result.accepted, accepted_files)],
        "rejected": rejected_rows,
        "scan": [{"ts": round(m.ts, 3), "blur": round(m.blur, 2),
                  "brightness": round(m.brightness, 1), "diff": round(m.diff, 2),
                  "rejected": m.rejected} for m in result.scan_metrics],
    }


def gate_sensitivity(rows: list[dict], cfg: vf.Config) -> None:
    """Where the face gate is costing yield.

    `min_face_px` / `min_face_blur` are imported from the *reference-selfie*
    quality path, where the photo is a query and 40px is generous. Whether they
    are the right thresholds for "publish this still" is a Phase 0 question, and
    it can only be answered by seeing the frames that just missed.
    """
    ours = [r for r in rows if r["selector"] == "ours"]
    if not ours:
        return
    misses = [c["near_miss"] for r in ours for c in r["rejected"]
              if "no_publishable_face" in c["reasons"] and c.get("near_miss")]
    faceless = sum(1 for r in ours for c in r["rejected"]
                   if "no_publishable_face" in c["reasons"] and not c.get("near_miss"))
    if not misses and not faceless:
        return

    print(f"\nface gate sensitivity (min_face_px={cfg.min_face_px}, "
          f"min_face_blur={cfg.min_face_blur:g})")
    print(f"  {faceless} frame(s) had NO face detected at all — no threshold recovers those")
    by_reason: dict[str, int] = {}
    for m in misses:
        by_reason[m["dropped"]] = by_reason.get(m["dropped"], 0) + 1
    for reason, n in sorted(by_reason.items(), key=lambda kv: -kv[1]):
        print(f"  {n:3d} frame(s) lost their best face to {reason}")
    bands = [(0, 20), (20, 30), (30, 40), (40, 80), (80, 10_000)]
    print("  biggest dropped face, by size:")
    for lo, hi in bands:
        n = sum(1 for m in misses if lo <= m["face_px"] < hi)
        if n:
            recoverable = sum(1 for m in misses if lo <= m["face_px"] < hi
                              and m["dropped"] == "face_too_small")
            note = f"  ({recoverable} would pass at min_face_px={lo})" if recoverable else ""
            print(f"    {lo:3d}–{hi if hi < 10_000 else '∞'}px: {n:3d} frame(s){note}")


def build_config(a: argparse.Namespace) -> vf.Config:
    cfg = vf.Config()
    for name in vars(cfg):
        val = getattr(a, name, None)
        if val is not None:
            setattr(cfg, name, val)
    return cfg


def add_config_flags(ap: argparse.ArgumentParser) -> None:
    """Every threshold is a flag (plan §2.3 Phase 0.2). Defaults come from
    Config, so `None` here means "leave the default alone"."""
    defaults = vf.Config()
    for name, value in vars(defaults).items():
        flag = "--" + name.replace("_", "-")
        if isinstance(value, bool):
            ap.add_argument(flag, dest=name, action=argparse.BooleanOptionalAction,
                            default=None, help=f"(default {value})")
        else:
            ap.add_argument(flag, dest=name, type=type(value), default=None,
                            help=f"(default {value})")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--clips", nargs="+", required=True,
                    help="clip files, or folders containing them")
    ap.add_argument("--out", required=True, help="output folder for stills + report")
    ap.add_argument("--selectors", default=",".join(SELECTORS),
                    help=f"comma list of {SELECTORS}")
    ap.add_argument("--limit", type=int, default=0, help="only the first N clips")
    add_config_flags(ap)
    a = ap.parse_args()

    if not vf.have_ffmpeg():
        print("ffmpeg/ffprobe not found on PATH (brew install ffmpeg)", file=sys.stderr)
        return 2

    selectors = [s.strip() for s in a.selectors.split(",") if s.strip()]
    for s in selectors:
        if s not in SELECTORS:
            print(f"unknown selector {s!r}; choose from {SELECTORS}", file=sys.stderr)
            return 2

    clips = find_clips(a.clips)
    if a.limit:
        clips = clips[: a.limit]
    if not clips:
        print("no clips found", file=sys.stderr)
        return 2

    cfg = build_config(a)
    out_root = os.path.expanduser(a.out)
    os.makedirs(out_root, exist_ok=True)

    embed = None
    if "ours" in selectors:
        # Load the bundle ONCE for the whole run — a per-clip load would swamp
        # the per-clip cost measurement (cold start is paid once per instance in
        # production too).
        from models import load_bundle
        from pipeline import embed_image
        try:
            bundle = load_bundle()
        except FileNotFoundError as e:
            print(f"{e}\nSet MODEL_DIR, or drop 'ours' from --selectors.", file=sys.stderr)
            return 2
        if bundle.person_det is None:
            print("NOTE: yolov8n.onnx absent — person boxes come from face expansion, "
                  "so the w_persons term and the geometry test are degraded.",
                  file=sys.stderr)
        embed = lambda img: embed_image(img, bundle)  # noqa: E731

    rows, failures = [], []
    for path in clips:
        try:
            info = vf.probe(path)
        except Exception as e:  # noqa: BLE001 — one bad clip must not end the run
            print(f"! {os.path.basename(path)}: probe failed: {e}", file=sys.stderr)
            failures.append({"clip": os.path.basename(path), "error": f"probe: {e}"})
            continue
        print(f"\n{os.path.basename(path)}  {info.display_width}x{info.display_height} "
              f"{info.duration_s:.1f}s {info.fps:.0f}fps {info.codec}"
              f"{' HDR:' + info.transfer if info.is_hdr else ''}"
              f"{' rot:' + str(info.rotation) if info.rotation else ''}")
        for selector in selectors:
            try:
                row = run_clip(path, selector, cfg, out_root, info, embed)
            except Exception as e:  # noqa: BLE001
                print(f"  {selector:16s} FAILED: {e}", file=sys.stderr)
                failures.append({"clip": os.path.basename(path), "selector": selector,
                                 "error": str(e)})
                continue
            rows.append(row)
            print(f"  {selector:16s} kept {row['accepted_count']:2d}/{row['budget']:2d} "
                  f"(scan {row['scanned']} → gate {row['gated']} → short {row['shortlisted']}) "
                  f"{row['cost']['wall_s']:.1f}s wall, {row['cost']['cpu_s']:.1f}s cpu "
                  f"({row['cost']['cpu_s_per_video_s']:.2f} cpu-s per video-s)")

    report = {
        "config": vars(cfg),
        "selectors": selectors,
        "clips": [os.path.basename(c) for c in clips],
        "failures": failures,
        "results": rows,
    }
    report_path = os.path.join(out_root, "report.json")
    with open(report_path, "w") as fh:
        json.dump(report, fh, indent=2, default=str)

    print(f"\nreport: {report_path}")
    gate_sensitivity(rows, cfg)
    for selector in selectors:
        srows = [r for r in rows if r["selector"] == selector]
        if not srows:
            continue
        kept = sum(r["accepted_count"] for r in srows)
        cpu = sum(r["cost"]["cpu_s"] for r in srows)
        vid = sum(max(r["video"]["duration_s"], 0.0) for r in srows)
        empty = sum(1 for r in srows if r["accepted_count"] == 0)
        print(f"  {selector:16s} {kept:3d} stills from {len(srows)} clips, "
              f"{empty} clip(s) produced nothing, {cpu:.0f} cpu-s total "
              f"({cpu / max(vid, 1e-6):.2f} cpu-s per video-s)")
    print("\nNext: make_frame_review_page.py → judge → score_video_frames.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
