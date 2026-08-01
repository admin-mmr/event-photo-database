#!/usr/bin/env python3
"""
frame_retrieval_probe.py — would a real runner's search actually return a
video-derived still?

This is the decisive test for VIDEO_FRAME_EXTRACTION_PHASE0.md §5: the face-size
sweep showed a 25 px face is *embeddable*, but not that these stills get *found*.

    python eval/frame_retrieval_probe.py \\
        --store ~/replay-store --event-id ecd530b9-… \\
        --frames ~/video-spike-px25/ours --feedback ~/replay-store/feedback.json

**No selfies are involved, by design.** PRD §8 keeps biometric reference photos
off laptops, which is why the T-norm replay runs in-cloud. This probe doesn't
need them: the event's own vector store already holds an embedding for every
photo, and `match_feedback` says which photos each searcher confirmed as
themselves. So a searcher's identity can be reconstructed from *gallery photos*
they already vouched for — ordinary event photos, not biometrics.

How a query is built (`--min-photos`, `--link-cos`):
  1. take every face in the photos that searcher confirmed;
  2. find the face that recurs across the most of those photos — in a race photo
     most faces are strangers, but the searcher is the one person present in all
     of their own confirmed photos;
  3. average that face across the photos it appears in (L2-normalised), the same
     multi-reference folding the matcher does for multiple selfies.

Then every frame-derived still is scored against that query and placed against
two calibration bands measured for the same searcher: their **confirmed photos**
(known true positives) and a random sample of other photos (assumed negatives).

Read the output honestly: a still scoring above the floor is a *candidate* hit,
not a confirmed one — nobody has yet voted on whether that runner is in that
still. The probe tells you whether frames CAN surface and where they rank; a
human still has to confirm the ones that do. `--dump-hits` writes those pairs out
for exactly that check.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fusion import DEFAULT_FACE_WEIGHT, DEFAULT_THRESHOLD  # noqa: E402

FACE_COS_FLOOR = DEFAULT_THRESHOLD / DEFAULT_FACE_WEIGHT
IMAGE_EXTS = {".jpg", ".jpeg", ".png"}


def _l2(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v)
    return v if n < 1e-9 else v / n


def load_store(store_dir: str) -> tuple[np.ndarray, list[dict], dict]:
    emb = store_dir
    if not os.path.exists(os.path.join(emb, "manifest.json")):
        emb = os.path.join(store_dir, "embeddings")
    with open(os.path.join(emb, "manifest.json"), encoding="utf-8") as fh:
        manifest = json.load(fh)
    faces = np.load(os.path.join(emb, "faces.npy"))
    if len(manifest["faces"]) != faces.shape[0]:
        raise SystemExit(f"manifest/faces mismatch: {len(manifest['faces'])} vs {faces.shape[0]}")
    return faces, manifest["faces"], manifest


def read_feedback(path: str) -> dict[str, dict[str, set]]:
    """Firestore REST runQuery dump → {uid: {'confirmed': {photoId}, 'not_me': …}}."""
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    out: dict[str, dict[str, set]] = defaultdict(lambda: {"confirmed": set(), "not_me": set()})
    for row in raw:
        doc = row.get("document")
        if not doc:
            continue
        f = doc["fields"]
        uid = f.get("uid", {}).get("stringValue")
        photo = f.get("photoId", {}).get("stringValue")
        verdict = f.get("verdict", {}).get("stringValue")
        if uid and photo and verdict in ("confirmed", "not_me"):
            out[uid][verdict].add(photo)
    return out


def build_query(uid_photos: set[str], faces: np.ndarray, meta: list[dict],
                rows_by_photo: dict[str, list[int]], link_cos: float,
                min_photos: int) -> tuple[np.ndarray | None, int, int]:
    """The recurring face across a searcher's confirmed photos → their query."""
    cand_rows = [r for p in uid_photos for r in rows_by_photo.get(p, [])]
    if not cand_rows:
        return None, 0, 0
    best, best_support, best_rows = None, 0, []
    for r in cand_rows:
        v = _l2(faces[r].astype(np.float64))
        support_rows, seen = [], set()
        for p in uid_photos:
            rows = rows_by_photo.get(p, [])
            if not rows:
                continue
            sims = [(float(v @ _l2(faces[q].astype(np.float64))), q) for q in rows]
            s, q = max(sims)
            if s >= link_cos:
                support_rows.append(q)
                seen.add(p)
        if len(seen) > best_support:
            best, best_support, best_rows = v, len(seen), support_rows
    if best is None or best_support < min_photos:
        return None, best_support, len(uid_photos)
    folded = _l2(np.mean([_l2(faces[q].astype(np.float64)) for q in best_rows], axis=0))
    return folded, best_support, len(uid_photos)


def embed_frames(frames_dir: str, bundle) -> list[dict]:
    from pipeline import decode_image, embed_image

    out = []
    for root, _dirs, files in os.walk(frames_dir):
        if os.path.basename(root) == "rejected":
            continue
        for name in sorted(files):
            if os.path.splitext(name)[1].lower() not in IMAGE_EXTS:
                continue
            path = os.path.join(root, name)
            rel = os.path.relpath(path, frames_dir)
            with open(path, "rb") as fh:
                img = decode_image(fh.read())
            res = embed_image(img, bundle)
            for f in res["faces"]:
                q = f.get("quality") or {}
                out.append({
                    "frame": rel, "path": path,
                    "embedding": _l2(np.asarray(f["embedding"], dtype=np.float64)),
                    "face_px": int(q.get("face_px") or 0),
                })
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--store", required=True, help="event store dir (holds manifest.json/faces.npy)")
    ap.add_argument("--event-id", required=True)
    ap.add_argument("--frames", required=True, help="folder of extracted stills")
    ap.add_argument("--feedback", required=True, help="Firestore REST dump of match_feedback")
    ap.add_argument("--link-cos", type=float, default=0.40,
                    help="cosine at which two faces count as the same person when "
                         "reconstructing a searcher's identity")
    ap.add_argument("--min-photos", type=int, default=2,
                    help="a searcher needs their face in this many confirmed photos")
    ap.add_argument("--floor", type=float, default=FACE_COS_FLOOR)
    ap.add_argument("--dump-hits", help="write above-floor (searcher, frame) pairs here as JSON")
    ap.add_argument("--out", help="write the full result JSON here")
    a = ap.parse_args()

    faces, meta, manifest = load_store(os.path.expanduser(a.store))
    print(f"store: {faces.shape[0]} face vectors over "
          f"{len({m['photoId'] for m in meta})} photos "
          f"(model {manifest.get('modelVersion')})")

    rows_by_photo: dict[str, list[int]] = defaultdict(list)
    for i, m in enumerate(meta):
        rows_by_photo[m["photoId"]].append(i)

    fb = read_feedback(os.path.expanduser(a.feedback))
    print(f"feedback: {len(fb)} searcher(s)")

    from models import load_bundle
    try:
        bundle = load_bundle()
    except FileNotFoundError as e:
        print(f"{e}\nSet MODEL_DIR.", file=sys.stderr)
        return 2
    frame_faces = embed_frames(os.path.expanduser(a.frames), bundle)
    frame_names = sorted({f["frame"] for f in frame_faces})
    print(f"frames: {len(frame_names)} still(s), {len(frame_faces)} face(s) "
          f"(sizes {min((f['face_px'] for f in frame_faces), default=0)}–"
          f"{max((f['face_px'] for f in frame_faces), default=0)}px)")
    if not frame_faces:
        print("no faces in the frames — nothing to probe", file=sys.stderr)
        return 1

    F = np.stack([f["embedding"] for f in frame_faces])
    rng = np.random.default_rng(0)
    all_rows = np.arange(faces.shape[0])

    results, hits, skipped = [], [], 0
    for uid, verdicts in sorted(fb.items()):
        confirmed = verdicts["confirmed"]
        if len(confirmed) < a.min_photos:
            skipped += 1
            continue
        q, support, n_conf = build_query(confirmed, faces, meta, rows_by_photo,
                                         a.link_cos, a.min_photos)
        if q is None:
            skipped += 1
            continue

        # True-positive band: the searcher's own confirmed photos.
        conf_scores = []
        for p in confirmed:
            rows = rows_by_photo.get(p, [])
            if rows:
                conf_scores.append(max(float(q @ _l2(faces[r].astype(np.float64))) for r in rows))
        # Negative band: a random sample of other faces in the event.
        sample = rng.choice(all_rows, size=min(400, len(all_rows)), replace=False)
        neg = [float(q @ _l2(faces[r].astype(np.float64))) for r in sample
               if meta[r]["photoId"] not in confirmed]

        # Frames.
        fs = F @ q
        best_per_frame: dict[str, float] = {}
        for score, ff in zip(fs, frame_faces):
            if score > best_per_frame.get(ff["frame"], -1.0):
                best_per_frame[ff["frame"]] = float(score)
        top = sorted(best_per_frame.items(), key=lambda kv: -kv[1])

        above = [(n, s) for n, s in top if s >= a.floor]
        results.append({
            "uid": uid, "confirmed_photos": n_conf, "identity_support": support,
            "conf_p50": round(float(np.median(conf_scores)), 4) if conf_scores else None,
            "conf_min": round(min(conf_scores), 4) if conf_scores else None,
            "neg_p95": round(float(np.percentile(neg, 95)), 4) if neg else None,
            "best_frame": top[0][0] if top else None,
            "best_frame_score": round(top[0][1], 4) if top else None,
            "frames_above_floor": len(above),
        })
        for name, s in above:
            hits.append({"uid": uid, "frame": name, "score": round(s, 4),
                         "conf_min": round(min(conf_scores), 4) if conf_scores else None,
                         "confirmed_photos": sorted(confirmed)[:5]})

    if not results:
        print("no searcher had enough confirmed photos to reconstruct an identity",
              file=sys.stderr)
        return 1

    scored = [r for r in results]
    with_hit = [r for r in scored if r["frames_above_floor"] > 0]
    best_scores = [r["best_frame_score"] for r in scored if r["best_frame_score"] is not None]
    conf_p50s = [r["conf_p50"] for r in scored if r["conf_p50"] is not None]
    neg95s = [r["neg_p95"] for r in scored if r["neg_p95"] is not None]

    print(f"\nprobed {len(scored)} searcher(s) with a reconstructible identity "
          f"({skipped} skipped: too few confirmed photos)")
    print(f"match floor: {a.floor:.3f}\n")
    print(f"  confirmed-photo score (true positives)  median {np.median(conf_p50s):.3f}")
    print(f"  random other faces (negatives)          p95    {np.median(neg95s):.3f}")
    print(f"  best frame per searcher                 median {np.median(best_scores):.3f}, "
          f"max {max(best_scores):.3f}")
    print(f"\n  searchers with ≥1 frame above the floor: "
          f"{len(with_hit)}/{len(scored)} ({len(with_hit) / len(scored):.0%})")

    if with_hit:
        print("\n  candidate hits (NOT yet verified — nobody has voted on these):")
        for r in sorted(with_hit, key=lambda r: -r["best_frame_score"])[:15]:
            print(f"    {r['uid'][:12]:14s} {r['best_frame'][:44]:46s} "
                  f"{r['best_frame_score']:.3f}  (own photos ≥ {r['conf_min']:.3f})")

    if a.dump_hits and hits:
        with open(os.path.expanduser(a.dump_hits), "w") as fh:
            json.dump(hits, fh, indent=2)
        print(f"\nwrote {len(hits)} candidate hit(s) to {a.dump_hits}")
    if a.out:
        with open(os.path.expanduser(a.out), "w") as fh:
            json.dump({"floor": a.floor, "event": a.event_id, "results": results,
                       "hits": hits}, fh, indent=2)
        print(f"wrote {a.out}")

    print("\nA frame above the floor means it WOULD be returned to that searcher. "
          "Whether it SHOULD be needs a human to look — that is what the review "
          "loop is for.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
