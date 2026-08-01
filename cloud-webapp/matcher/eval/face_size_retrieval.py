#!/usr/bin/env python3
"""
face_size_retrieval.py — can the matcher actually retrieve a runner whose face is
only 25–40 px?

This settles the open decision in VIDEO_FRAME_EXTRACTION_PHASE0.md §5. The 40 px
publish gate is defensible ONLY if a sub-40 px face is unmatchable — if a 30 px
face still retrieves its owner, the argument for throwing those stills away
collapses.

    python eval/face_size_retrieval.py --images ~/event-photos-mini10k \\
        --targets 40,35,30,25,20 --out /tmp/face-size.json

What it measures, per target face size:

  detection recall  did SCRFD still find the face at all? (if not, the photo is
                    unretrievable no matter what the embedding would have said)
  genuine cosine    cos(embedding at native size, embedding at target size) —
                    the SAME face, so identity is ground truth by construction
  impostor cosine   cos(face A at native size, face B at target size) where A and
                    B are two different faces IN THE SAME IMAGE — two people in
                    one frame are certainly different people, which is why
                    impostors are drawn within an image and never across images
                    (the same runner recurs across frames of an event)
  retrievable       genuine cosine ≥ the matcher's reported-match floor:
                    fusion reports a photo at fused ≥ 0.25 and face carries 0.85
                    of the fused score, so face-only needs ≈ 0.294
  separable         genuine cosine > the impostor 95th percentile at that size —
                    the stronger question, since clearing the floor is worthless
                    if strangers clear it too

**This is an optimistic upper bound and must be read as one.** Shrinking a
close-up face is not the same as a face that was genuinely far from the camera:
the downscale keeps the crisp focus, even lighting and frontal pose of a nearby
subject, and adds none of the atmospheric haze, focus falloff or subject motion
blur that a distant runner really has. Use `--native-pairs` for the un-simulated
version of the same question.
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fusion import DEFAULT_FACE_WEIGHT, DEFAULT_THRESHOLD  # noqa: E402
from models import load_bundle  # noqa: E402
from pipeline import decode_image  # noqa: E402

# Face-only cosine that just clears the matcher's reporting floor.
FACE_COS_FLOOR = DEFAULT_THRESHOLD / DEFAULT_FACE_WEIGHT

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}


def _cos(a, b) -> float:
    a = np.asarray(a, dtype=np.float64).ravel()
    b = np.asarray(b, dtype=np.float64).ravel()
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    return 0.0 if na < 1e-9 or nb < 1e-9 else float(a @ b / (na * nb))


def _face_px(box) -> int:
    return int(min(box[2] - box[0], box[3] - box[1]))


def _center(box) -> tuple[float, float]:
    return ((box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0)


def find_images(paths: list[str]) -> list[str]:
    out = []
    for p in paths:
        p = os.path.expanduser(p)
        if os.path.isdir(p):
            for root, _dirs, files in os.walk(p):
                for name in sorted(files):
                    if os.path.splitext(name)[1].lower() in IMAGE_EXTS:
                        out.append(os.path.join(root, name))
        elif os.path.isfile(p):
            out.append(p)
    return sorted(out)


def detect_and_embed(bundle, img_rgb) -> list[dict]:
    faces = []
    for det in bundle.face_det.detect(img_rgb):
        faces.append({
            "box": list(det["box"]), "score": float(det["score"]),
            "face_px": _face_px(det["box"]),
            "embedding": bundle.face_emb.embed(img_rgb, det["kps"]),
        })
    return faces


def resize_to(img_rgb, scale: float):
    import cv2
    h, w = img_rgb.shape[:2]
    nh, nw = max(2, int(round(h * scale))), max(2, int(round(w * scale)))
    return cv2.resize(img_rgb, (nw, nh), interpolation=cv2.INTER_AREA)


def match_scaled(scaled_faces: list[dict], ref_box, scale: float, tol_frac: float = 0.6):
    """Re-find a reference face after downscaling, by position.

    Matching by position (not by embedding) is essential: matching by embedding
    would beg the very question being asked.
    """
    ecx, ecy = _center(ref_box)
    ecx, ecy = ecx * scale, ecy * scale
    expected_px = _face_px(ref_box) * scale
    best, best_d = None, None
    for f in scaled_faces:
        cx, cy = _center(f["box"])
        d = float(np.hypot(cx - ecx, cy - ecy))
        if best_d is None or d < best_d:
            best, best_d = f, d
    if best is None or best_d > max(tol_frac * expected_px, 6.0):
        return None
    return best


def sweep(images: list[str], targets: list[int], ref_px: int, bundle,
          max_images: int = 0) -> dict:
    rows: list[dict] = []
    impostor_rows: list[dict] = []
    n_ref = 0
    used = 0

    for i, path in enumerate(images, start=1):
        if max_images and used >= max_images:
            break
        # Detection on full-resolution event photos is slow (seconds each), so
        # say something — a silent 20-minute run is indistinguishable from a hang.
        print(f"  [{i}/{len(images)}] {os.path.basename(path)[:52]:52s} "
              f"refs={n_ref} pairs={len(rows)}", flush=True)
        try:
            with open(path, "rb") as fh:
                img = decode_image(fh.read())
        except Exception as e:  # noqa: BLE001
            print(f"  ! {os.path.basename(path)}: {e}", file=sys.stderr)
            continue
        native = detect_and_embed(bundle, img)
        refs = [f for f in native if f["face_px"] >= ref_px]
        if not refs:
            continue
        used += 1
        n_ref += len(refs)

        # Cache the downscaled detections once per (image, target).
        per_target: dict[int, list[dict]] = {}
        for ref in refs:
            for t in targets:
                scale = t / ref["face_px"]
                if scale >= 1.0:
                    continue
                key = (t, ref["face_px"])
                if key not in per_target:
                    per_target[key] = detect_and_embed(bundle, resize_to(img, scale))
                got = match_scaled(per_target[key], ref["box"], scale)
                row = {
                    "image": os.path.basename(path), "target_px": t,
                    "ref_px": ref["face_px"], "detected": got is not None,
                }
                if got is not None:
                    row["actual_px"] = got["face_px"]
                    row["det_score"] = round(got["score"], 3)
                    row["cos"] = round(_cos(ref["embedding"], got["embedding"]), 4)
                    row["_emb"] = got["embedding"]
                    row["_ref_emb"] = ref["embedding"]
                    row["_ref_box"] = ref["box"]
                rows.append(row)

        # Impostors: different faces in the SAME image → guaranteed different
        # people. Compare a native reference against ANOTHER face's downscaled
        # embedding, which is the same comparison a search actually makes.
        for t in targets:
            got_rows = [r for r in rows
                        if r["image"] == os.path.basename(path)
                        and r["target_px"] == t and r.get("detected")]
            for a, b in itertools.permutations(got_rows, 2):
                if np.array_equal(a["_ref_box"], b["_ref_box"]):
                    continue
                impostor_rows.append({
                    "image": os.path.basename(path), "target_px": t,
                    "cos": round(_cos(a["_ref_emb"], b["_emb"]), 4),
                })

    for r in rows:
        r.pop("_emb", None)
        r.pop("_ref_emb", None)
        r.pop("_ref_box", None)
    return {"rows": rows, "impostors": impostor_rows, "images_used": used, "refs": n_ref}


def pct(vals: list[float], q: float) -> float:
    return float(np.percentile(vals, q)) if vals else float("nan")


def report(result: dict, targets: list[int]) -> dict:
    rows, imps = result["rows"], result["impostors"]
    print(f"\n{result['refs']} reference face(s) in {result['images_used']} image(s)")
    print(f"match floor: face cosine ≥ {FACE_COS_FLOOR:.3f} "
          f"(fused {DEFAULT_THRESHOLD} at face weight {DEFAULT_FACE_WEIGHT})\n")
    print(f"{'target':>7s} {'n':>4s} {'det':>6s} {'cos p50':>8s} {'cos p10':>8s} "
          f"{'imp p95':>8s} {'imp max':>8s} {'≥floor':>7s} {'>imp p95':>9s}")
    print("-" * 78)
    out = {}
    for t in targets:
        tr = [r for r in rows if r["target_px"] == t]
        if not tr:
            continue
        det = [r for r in tr if r["detected"]]
        cos = [r["cos"] for r in det]
        ti = [r["cos"] for r in imps if r["target_px"] == t]
        imp95 = pct(ti, 95)
        # Fractions are over every ATTEMPT, not just the ones that redetected —
        # a face the detector loses is a photo the runner never sees, so
        # counting only redetections would flatter the small sizes.
        n_ok_floor = sum(1 for c in cos if c >= FACE_COS_FLOOR)
        n_ok_sep = sum(1 for c in cos if ti and c > imp95)
        print(f"{t:6d}px {len(tr):4d} {len(det) / len(tr):6.0%} "
              f"{pct(cos, 50):8.3f} {pct(cos, 10):8.3f} "
              f"{imp95:8.3f} {max(ti) if ti else float('nan'):8.3f} "
              f"{n_ok_floor / len(tr):7.0%} {n_ok_sep / len(tr):9.0%}")
        out[t] = {
            "attempts": len(tr), "detected": len(det),
            "detection_rate": round(len(det) / len(tr), 4),
            "cos_p50": round(pct(cos, 50), 4), "cos_p10": round(pct(cos, 10), 4),
            "cos_min": round(min(cos), 4) if cos else None,
            "impostor_p95": round(imp95, 4) if ti else None,
            "impostor_max": round(max(ti), 4) if ti else None,
            "impostor_n": len(ti),
            "frac_above_floor": round(n_ok_floor / len(tr), 4),
            "frac_above_impostor_p95": round(n_ok_sep / len(tr), 4),
        }
    return out


def native_pairs(spec: str, bundle) -> None:
    """Un-simulated check: the SAME runner in two real frames at two distances.

    `--native-pairs small.jpg:x,y=big.jpg:x,y;…` where each `x,y` picks the face
    nearest that pixel. Identity here is established by a human looking at the
    two frames, which is why it takes coordinates instead of guessing.
    """
    print("\nnative pairs (same runner, two real frames — no downscaling)")
    print(f"{'small':>28s} {'px':>4s} {'big':>28s} {'px':>5s} {'cos':>7s}  verdict")
    for pair in spec.split(";"):
        if not pair.strip():
            continue
        try:
            small_spec, big_spec = pair.split("=")
            out = []
            for s in (small_spec, big_spec):
                p, xy = s.rsplit(":", 1)
                x, y = (float(v) for v in xy.split(","))
                with open(os.path.expanduser(p), "rb") as fh:
                    img = decode_image(fh.read())
                faces = detect_and_embed(bundle, img)
                if not faces:
                    raise ValueError(f"no face detected in {p}")
                f = min(faces, key=lambda f: np.hypot(*(np.subtract(_center(f["box"]), (x, y)))))
                out.append((os.path.basename(p), f))
        except Exception as e:  # noqa: BLE001
            print(f"  ! {pair}: {e}", file=sys.stderr)
            continue
        (sn, sf), (bn, bf) = out
        c = _cos(sf["embedding"], bf["embedding"])
        verdict = ("RETRIEVED" if c >= FACE_COS_FLOOR else "missed")
        print(f"{sn[-28:]:>28s} {sf['face_px']:4d} {bn[-28:]:>28s} {bf['face_px']:5d} "
              f"{c:7.3f}  {verdict}")


def track_clip(clip: str, bundle, fps: float, min_len: int, min_ratio: float,
               max_move_frac: float, crops_dir: str | None,
               outfit_cos: float = 0.5) -> list[dict]:
    """Native small-vs-large pairs, with identity from motion continuity.

    A runner approaching the camera IS the experiment: the same face, same
    lighting, same day, at 30 px and then at 90 px — with none of the downscale
    arm's optimism, because the small face really was far away.

    **Position alone is not enough, and assuming it was produced a wrong answer
    once.** A 21 s clip of a race pack yielded 318 tracks and only 5 of 34 "same
    person" pairs matched — but the crops showed the tracker had swapped runners
    (one track ran from a young man's 18 px face to an elderly man's 175 px one).
    Near-zero cosines were correct; the *identities* were wrong.

    So a link now needs three things to agree: the centre moved less than
    `max_move_frac` × face size, the face size changed by less than ~1.45×, and
    the **outfit** embedding agrees (`outfit_cos`). Outfit is OSNet — a different
    model from the ArcFace embeddings being measured — so gating on it does not
    beg the question the way gating on face similarity would.

    Even so: `--track-crops` writes every surviving track's endpoint crops out,
    and an unverified track is a lead, not a result. Eyeball them.
    """
    import cv2

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import video_frames as vf
    from pipeline import expand_face_to_person

    info = vf.probe(clip)
    n = max(1, int(round(info.duration_s * fps)))
    tracks: list[dict] = []   # each: {faces, last_center, last_ts, last_px, outfit}

    def _outfit(img, box):
        h, w = img.shape[:2]
        x1, y1, x2, y2 = (int(round(v)) for v in expand_face_to_person(box, w, h))
        crop = img[max(0, y1):max(1, y2), max(0, x1):max(1, x2)]
        if crop.shape[0] < 8 or crop.shape[1] < 8:
            return None
        return bundle.person_emb.embed(crop)

    for i in range(n):
        ts = i / fps
        jpeg = vf.extract_still(clip, ts, info, vf.Config())
        if not jpeg:
            continue
        img = decode_image(jpeg)
        for f in detect_and_embed(bundle, img):
            cx, cy = _center(f["box"])
            f = {**f, "ts": ts, "center": (cx, cy), "outfit": _outfit(img, f["box"])}
            budget = max(max_move_frac * f["face_px"], 10.0)
            best, best_d = None, None
            for tr in tracks:
                if tr["last_ts"] == ts:
                    continue          # one face per track per frame
                if ts - tr["last_ts"] > 1.5 / fps + 1e-6:
                    continue          # track went stale
                d = float(np.hypot(cx - tr["last_center"][0], cy - tr["last_center"][1]))
                if d > budget:
                    continue
                ratio = f["face_px"] / max(tr["last_px"], 1)
                if not (0.69 <= ratio <= 1.45):
                    continue          # a face does not double in size in 1/15 s
                if (outfit_cos > 0 and f["outfit"] is not None
                        and tr["outfit"] is not None
                        and _cos(f["outfit"], tr["outfit"]) < outfit_cos):
                    continue          # different runner wearing something else
                if best_d is None or d < best_d:
                    best, best_d = tr, d
            if best is None:
                tracks.append({"faces": [f], "last_center": (cx, cy), "last_ts": ts,
                               "last_px": f["face_px"], "outfit": f["outfit"]})
            else:
                best["faces"].append(f)
                best["last_center"] = (cx, cy)
                best["last_ts"] = ts
                best["last_px"] = f["face_px"]
                if f["outfit"] is not None:
                    best["outfit"] = f["outfit"]

    out = []
    for idx, tr in enumerate(tracks):
        faces = tr["faces"]
        if len(faces) < min_len:
            continue
        small = min(faces, key=lambda f: f["face_px"])
        large = max(faces, key=lambda f: f["face_px"])
        if large["face_px"] < min_ratio * max(small["face_px"], 1):
            continue
        cos = _cos(small["embedding"], large["embedding"])
        out.append({
            "track": idx, "frames": len(faces),
            "small_px": small["face_px"], "large_px": large["face_px"],
            "small_ts": round(small["ts"], 2), "large_ts": round(large["ts"], 2),
            "cos": round(cos, 4), "retrieved": cos >= FACE_COS_FLOOR,
        })
        if crops_dir:
            os.makedirs(crops_dir, exist_ok=True)
            for tag, f in (("small", small), ("large", large)):
                jpeg = vf.extract_still(clip, f["ts"], info, vf.Config())
                if not jpeg:
                    continue
                im = decode_image(jpeg)
                x1, y1, x2, y2 = (int(round(v)) for v in f["box"])
                pad = int(0.6 * f["face_px"])
                crop = im[max(0, y1 - pad):y2 + pad, max(0, x1 - pad):x2 + pad]
                if crop.size:
                    cv2.imwrite(os.path.join(
                        crops_dir, f"track{idx:02d}_{tag}_{f['face_px']}px.jpg"),
                        cv2.cvtColor(crop, cv2.COLOR_RGB2BGR))

    print(f"\nnative tracks in {os.path.basename(clip)} "
          f"({len(tracks)} track(s), {len(out)} spanning ≥{min_ratio:g}× size range)")
    if out:
        print(f"{'track':>6s} {'frames':>7s} {'small':>7s} {'large':>7s} {'cos':>7s}  verdict")
        for r in sorted(out, key=lambda r: -r["large_px"]):
            print(f"{r['track']:6d} {r['frames']:7d} {r['small_px']:5d}px "
                  f"{r['large_px']:5d}px {r['cos']:7.3f}  "
                  f"{'RETRIEVED' if r['retrieved'] else 'missed'}")
        got = sum(1 for r in out if r["retrieved"])
        print(f"\n{got}/{len(out)} tracks would be retrieved at the "
              f"{FACE_COS_FLOOR:.3f} face-cosine floor")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--images", nargs="*", default=[],
                    help="folders/files holding photos with large, clear faces")
    ap.add_argument("--targets", default="40,35,30,25,20")
    ap.add_argument("--ref-px", type=int, default=120,
                    help="a face must be at least this big to serve as a reference")
    ap.add_argument("--max-images", type=int, default=0)
    ap.add_argument("--native-pairs", help="small.jpg:x,y=big.jpg:x,y;… (see docstring)")
    ap.add_argument("--track-clip", nargs="*", default=[],
                    help="clip(s) to track faces through: native small-vs-large pairs")
    ap.add_argument("--track-fps", type=float, default=10.0)
    ap.add_argument("--track-min-frames", type=int, default=4)
    ap.add_argument("--track-min-ratio", type=float, default=1.8,
                    help="keep tracks whose largest face is this × the smallest")
    ap.add_argument("--track-max-move", type=float, default=0.6,
                    help="max centre movement between frames, as a fraction of face size")
    ap.add_argument("--track-outfit-cos", type=float, default=0.5,
                    help="min OSNet outfit cosine to link two detections (0 disables); "
                         "position alone swaps runners in a pack")
    ap.add_argument("--track-crops", help="write endpoint crops here for eyeballing")
    ap.add_argument("--out", help="write the full per-face rows as JSON")
    a = ap.parse_args()

    targets = sorted((int(t) for t in a.targets.split(",") if t.strip()), reverse=True)
    try:
        bundle = load_bundle()
    except FileNotFoundError as e:
        print(f"{e}\nSet MODEL_DIR.", file=sys.stderr)
        return 2

    summary = {}
    if a.images:
        images = find_images(a.images)
        if not images:
            print("no images found", file=sys.stderr)
            return 2
        print(f"scanning {len(images)} image(s) for faces ≥ {a.ref_px}px…")
        result = sweep(images, targets, a.ref_px, bundle, a.max_images)
        if not result["refs"]:
            print(f"no face ≥ {a.ref_px}px found — lower --ref-px", file=sys.stderr)
            return 1
        summary = report(result, targets)
        if a.out:
            with open(os.path.expanduser(a.out), "w") as fh:
                json.dump({"face_cos_floor": FACE_COS_FLOOR, "ref_px": a.ref_px,
                           "summary": summary, "rows": result["rows"],
                           "impostors": result["impostors"]}, fh, indent=2)
            print(f"\nwrote {a.out}")
        print("\nReminder: downscaling a close-up is an OPTIMISTIC stand-in for a "
              "genuinely distant face — treat these as an upper bound.")

    if a.native_pairs:
        native_pairs(a.native_pairs, bundle)

    track_rows = []
    for clip in a.track_clip:
        track_rows += [{**r, "clip": os.path.basename(clip)} for r in track_clip(
            os.path.expanduser(clip), bundle, a.track_fps, a.track_min_frames,
            a.track_min_ratio, a.track_max_move, a.track_crops, a.track_outfit_cos)]
    if track_rows:
        got = sum(1 for r in track_rows if r["retrieved"])
        print(f"\nacross all clips: {got}/{len(track_rows)} native tracks retrieved")
        if a.out:
            path = os.path.expanduser(a.out)
            existing = {}
            if os.path.exists(path):
                with open(path) as fh:
                    existing = json.load(fh)
            existing["native_tracks"] = track_rows
            with open(path, "w") as fh:
                json.dump(existing, fh, indent=2)
            print(f"appended native_tracks to {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
