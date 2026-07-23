#!/usr/bin/env python3
"""
run_eval.py — M0.3 matching-quality harness (dev plan §6.4).

Measures Precision@K, Recall@K and false-positive rate for face-only,
person-only ("outfit"), and fused scoring, with a fusion-weight sweep.
The M0 go/no-go gate is Precision@20 ≥ 0.8 (dev plan M0 DoD).

Inputs:
  --store    local store root written by scripts/embed_folder.py
  --event-id event to evaluate
  --labels   labels.csv with header `photoId,person` — one row per
             (photo, person-in-photo) pair. photoId matches the manifest's
             photoId (relative path from embed_folder.py). Label EVERY photo
             a person appears in; unlabeled (photo, person) pairs count as
             negatives, so partial labeling inflates the FP rate.
  --queries  queries/<person>/*.jpg — 1+ reference photos per labeled person
             (e.g. a selfie). <person> dirnames must match the `person`
             column in labels.csv.

Usage:
    python eval/run_eval.py --store ./local_store --event-id ev_test \
        --labels eval/labels.csv --queries eval/queries \
        [--k 20] [--report eval/report.json]

Analysis add-ons (map to PEOPLE_RECOGNITION_QUALITY_PLAN.md items, all opt-in):
    --time-conditional [--time-windows ... --anchors ...]  Item 1 (capture-time fusion)
    --tnorm                                                Item 2 (T-norm)
    --prf [--prf-fold N]                                   Item 3 (pseudo-relevance feedback)
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fusion as fusion_mod  # noqa: E402

WEIGHT_SWEEP = [(1.0, 0.0), (0.9, 0.1), (0.8, 0.2), (0.7, 0.3), (0.6, 0.4), (0.5, 0.5), (0.0, 1.0)]

# Default candidate windows for the capture-time-conditional sweep (Item 1):
# (w_full_min, w_zero_min, floor). Bracket the plan's 45 min / 3 h default with a
# tighter and a looser pair so the sweep shows how sharply to trust outfit.
DEFAULT_TIME_WINDOWS = "30:120:0;45:180:0;60:240:0.1"


def parse_windows(spec: str) -> list[tuple[float, float, float]]:
    """Parse '--time-windows' — ';'-separated 'w_full_min:w_zero_min:floor'
    tuples (minutes; floor in [0,1]) — into a list of float triples."""
    windows: list[tuple[float, float, float]] = []
    for part in spec.split(";"):
        part = part.strip()
        if not part:
            continue
        try:
            full_s, zero_s, floor_s = part.split(":")
            windows.append((float(full_s), float(zero_s), float(floor_s)))
        except ValueError as exc:
            raise SystemExit(f"bad --time-windows entry '{part}': expected w_full_min:w_zero_min:floor") from exc
    return windows


def load_anchors(path: str) -> dict[str, int]:
    """Load an '--anchors' JSON {person: epoch_ms | ISO-8601} overriding the
    reference-selfie EXIF anchor — e.g. real Find-Me upload capture times pulled
    from `match_runs`, which are the correct anchor for a judged-label sweep."""
    from store import _iso_to_epoch_ms

    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    anchors: dict[str, int] = {}
    for person, val in raw.items():
        ms = int(val) if isinstance(val, (int, float)) else _iso_to_epoch_ms(str(val))
        if ms is not None:
            anchors[person] = ms
    return anchors


def load_labels(path: str) -> dict[str, set[str]]:
    """person → set of photoIds the person appears in."""
    truth: dict[str, set[str]] = defaultdict(set)
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            truth[row["person"].strip()].add(row["photoId"].strip())
    return dict(truth)


def metrics_at_k(ranked_photo_ids: list[str], relevant: set[str], k: int) -> dict:
    top = ranked_photo_ids[:k]
    hits = sum(1 for pid in top if pid in relevant)
    return {
        "precision": hits / len(top) if top else 0.0,
        "recall": hits / len(relevant) if relevant else 0.0,
        "fp_rate": (len(top) - hits) / len(top) if top else 0.0,
        "returned": len(top),
        "relevant": len(relevant),
    }


def load_judged_labels(path: str) -> tuple[dict[str, set[str]], dict[str, set[str]]]:
    """For --judged-only: read photoId,person,label (label=confirmed|wrong) into
    (positives, negatives) per person. Feedback labels are PARTIAL — only judged
    pairs are scored (EVAL_FEEDBACK_LOOP.md §3)."""
    positives: dict[str, set[str]] = defaultdict(set)
    negatives: dict[str, set[str]] = defaultdict(set)
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            person = row["person"].strip()
            pid = row["photoId"].strip()
            label = row["label"].strip().lower()
            if label == "confirmed":
                positives[person].add(pid)
            elif label == "wrong":
                negatives[person].add(pid)
    return dict(positives), dict(negatives)


def judged_metrics_at_k(
    ranked_photo_ids: list[str], positives: set[str], negatives: set[str], k: int
) -> dict:
    """Judged P@K: among the top-K results that received a verdict, confirmed /
    (confirmed + wrong). Unjudged results are EXCLUDED, not counted as negatives.
    Recall is unmeasurable from partial feedback, so it is reported as None."""
    top = ranked_photo_ids[:k]
    confirmed = sum(1 for pid in top if pid in positives)
    wrong = sum(1 for pid in top if pid in negatives)
    judged = confirmed + wrong
    return {
        "precision": (confirmed / judged) if judged else None,
        "recall": None,
        "fp_rate": (wrong / judged) if judged else None,
        "returned": len(top),
        "judged": judged,
        "confirmed": confirmed,
        "wrong": wrong,
    }


def _mean_unit(vectors: list) -> "object | None":
    """Unit centroid of L2-normalized vectors (mirrors matcher.main._mean_unit —
    kept local so the eval imports only numpy/fusion/store, no flask/onnx)."""
    import numpy as np

    if not len(vectors):
        return None
    mat = np.stack([np.asarray(v, dtype=np.float32).reshape(-1) for v in vectors])
    mat = mat / np.maximum(np.linalg.norm(mat, axis=1, keepdims=True), 1e-12)
    centroid = mat.mean(axis=0)
    norm = float(np.linalg.norm(centroid))
    return (centroid / norm).astype(np.float32) if norm >= 1e-12 else None


def _fold_prf(event, kind: str, prf_ids, refs: list, centroid):
    """Fold confirmed photos' own crops into the query centroid (mirrors
    matcher.main._fold_prf): for each photo take the crop closest to the current
    centroid, append it to `refs`, and recompute. Returns the updated centroid."""
    import numpy as np

    if centroid is None:
        return centroid
    for pid in prf_ids:
        crops = event.embeddings_for_photo(kind, pid)
        if crops.shape[0] == 0:
            continue
        refs.append(crops[int(np.argmax(crops @ centroid))])
    return _mean_unit(refs)


def _fused_candidates(event, q: dict, w_face: float, w_person: float, tnorm: bool, person_weight_fn=None) -> list:
    """Every candidate photo with its fused score (no threshold, no cap), so a
    caller can sweep the score threshold itself. `tnorm` z-scores each modality
    against the event cohort before fusing — the same transform normalize=1 does
    in production. `person_weight_fn(photoId) -> float` (Item 1) overrides the
    scalar person weight per candidate — used for the capture-time-conditional
    sweep; None keeps the flat `w_person` (production default)."""
    face_hits = (
        event.top_photos("face", q["face"], k=None, tnorm=tnorm) if q.get("face") is not None else []
    )
    person_hits = (
        event.top_photos("person", q["person"], k=None, tnorm=tnorm) if q.get("person") is not None else []
    )
    return fusion_mod.fuse(
        face_hits, person_hits, w_face=w_face, w_person=w_person, threshold=-1e9, top_k=None,
        person_weight_fn=person_weight_fn,
    )


def _time_weight_fn(event, anchor_ms, w_person: float, w_full_ms: float, w_zero_ms: float, floor: float):
    """Build the per-candidate person-weight closure the matcher uses for
    capture-time-conditional outfit fusion (PEOPLE_RECOGNITION_QUALITY_PLAN.md
    Item 1) — a faithful mirror of matcher.main.search().

    Returns None when `anchor_ms` is None (the query selfie carried no parseable
    capture time), so the caller falls back to the flat `w_person` for every
    candidate — the production no-regression path. A candidate whose own
    `takenAt` is unknown decays to 1.0 inside `time_decay`, i.e. also the static
    weight, so only candidates with a known capture time are ever re-weighted."""
    if anchor_ms is None:
        return None

    def person_weight_fn(pid, _w=w_person):  # closure over anchor/config, mirrors main.py
        t = event.taken_at_ms(pid)
        return _w * fusion_mod.time_decay(
            None if t is None else (t - anchor_ms),
            w_full_ms,
            w_zero_ms,
            floor,
        )

    return person_weight_fn


def threshold_sweep(
    event,
    truth: dict[str, set[str]],
    query_embeddings: dict,
    w_face: float,
    w_person: float,
    tnorm: bool,
    negatives: dict[str, set[str]] | None = None,
    judged: bool = False,
    n_points: int = 11,
    weight_fn_for=None,
) -> dict:
    """Precision/recall of the FUSED result *set* as the score threshold varies.

    This is the operating-point view P@K can't give: the product returns every
    photo above a fixed cutoff, so the question T-norm answers (§1.3) is "at a
    given precision, does normalizing let me lower the threshold and recover more
    recall?" Thresholds are drawn between the min/max observed fused score for
    THIS variant, so the raw and tnorm curves are each sampled across their own
    achievable range and compared shape-to-shape. In judged mode only confirmed
    (`truth`) / wrong (`negatives`) pairs count and recall is omitted (partial
    labels, EVAL_FEEDBACK_LOOP.md)."""
    negatives = negatives or {}
    per_query: dict[str, list] = {}
    all_scores: list[float] = []
    for person in truth:
        q = query_embeddings.get(person)
        if q is None:
            continue
        pwf = weight_fn_for(person) if weight_fn_for is not None else None
        fused = _fused_candidates(event, q, w_face, w_person, tnorm, person_weight_fn=pwf)
        per_query[person] = fused
        all_scores.extend(h["score"] for h in fused)

    if not all_scores:
        return {"weights": [w_face, w_person], "tnorm": tnorm, "points": []}

    lo, hi = min(all_scores), max(all_scores)
    thresholds = [lo] if hi == lo else [lo + (hi - lo) * i / (n_points - 1) for i in range(n_points)]

    points = []
    for t in thresholds:
        tp = fp = fn = 0
        for person, relevant in truth.items():
            fused = per_query.get(person)
            if fused is None:
                continue
            returned = {h["photoId"] for h in fused if h["score"] >= t}
            if judged:
                tp += len(returned & relevant)
                fp += len(returned & negatives.get(person, set()))
            else:
                tp += len(returned & relevant)
                fp += len(returned - relevant)
                fn += len(relevant - returned)
        precision = tp / (tp + fp) if (tp + fp) else None
        recall = None if judged else (tp / (tp + fn) if (tp + fn) else None)
        points.append(
            {"threshold": round(float(t), 4), "precision": precision, "recall": recall, "tp": tp, "fp": fp}
        )
    return {"weights": [w_face, w_person], "tnorm": tnorm, "points": points}


def prf_evaluate(
    event,
    truth: dict[str, set[str]],
    query_embeddings: dict,
    k: int,
    fold: int = 1,
    tnorm: bool = False,
) -> dict:
    """Recall lift from pseudo-relevance feedback (§1.2), face modality.

    For each person we simulate a confirmation: fold the first `fold` of their
    relevant photos into the query (using those photos' OWN stored embeddings,
    exactly as the matcher does), then measure recall@k on the *remaining* (held
    out) relevant photos. The folded-in photos are excluded from both the ranking
    results and the relevant denominator on BOTH the baseline and PRF runs, so
    the comparison is apples-to-apples — the only difference is whether the query
    was expanded. A person needs > `fold` relevant photos to contribute."""
    per_person: dict[str, dict] = {}
    base_sum = prf_sum = 0.0
    n = 0
    for person, relevant in truth.items():
        q = query_embeddings.get(person)
        if q is None or q.get("face") is None:
            continue
        rel_sorted = sorted(relevant)
        if len(rel_sorted) <= fold:
            continue
        fold_ids = set(rel_sorted[:fold])
        held = set(rel_sorted[fold:])

        def recall_excluding(query_vec) -> float:
            ranked = [
                h["photoId"]
                for h in event.top_photos("face", query_vec, k=None, tnorm=tnorm)
                if h["photoId"] not in fold_ids
            ]
            hits = sum(1 for pid in ranked[:k] if pid in held)
            return hits / len(held) if held else 0.0

        base_recall = recall_excluding(q["face"])
        centroid = _fold_prf(event, "face", fold_ids, [q["face"]], _mean_unit([q["face"]]))
        prf_recall = recall_excluding(centroid) if centroid is not None else base_recall

        per_person[person] = {
            "held": len(held),
            "folded": len(fold_ids),
            "base_recall": base_recall,
            "prf_recall": prf_recall,
        }
        base_sum += base_recall
        prf_sum += prf_recall
        n += 1

    mean = {
        "base_recall": base_sum / n if n else None,
        "prf_recall": prf_sum / n if n else None,
        "lift": (prf_sum - base_sum) / n if n else None,
    }
    return {"k": k, "fold": fold, "tnorm": tnorm, "queries": n, "mean": mean, "per_person": per_person}


def time_conditional_sweep(
    event,
    truth: dict[str, set[str]],
    query_embeddings: dict,
    k: int,
    w_face: float,
    w_person: float,
    windows: list[tuple[float, float, float]],
    tnorm: bool = False,
    negatives: dict[str, set[str]] | None = None,
    judged: bool = False,
) -> dict:
    """Capture-time-conditional outfit fusion sweep (Item 1).

    Compares the static baseline (flat `w_person`) against each candidate
    (w_full_min, w_zero_min, floor) window, where the outfit/person weight for a
    candidate is scaled by `time_decay(|t_cand - anchor|)`. The query anchor is
    `query_embeddings[person]["anchor_ms"]` — the reference selfie's EXIF capture
    time, or an `--anchors` override (e.g. the real Find-Me upload time). People
    (or candidate photos) without a capture time fall back to the static weight,
    so a variant can only differ from the baseline where times exist on BOTH
    sides. For each variant we report fused P@K and the precision/recall-vs-
    threshold operating curve, so a human can pick the window that recovers the
    most recall at the target precision (guardrails: human-approved, never
    auto-tuned).

    NOTE: run with the best fusion weights from the main sweep. If that best
    `w_person` is 0 (face-only), every variant is identical to the baseline —
    time-conditioning only moves scores when outfit carries weight."""
    negatives = negatives or {}

    def make_weight_fn_for(w_full_ms, w_zero_ms, floor):
        def weight_fn_for(person):
            anchor = (query_embeddings.get(person) or {}).get("anchor_ms")
            return _time_weight_fn(event, anchor, w_person, w_full_ms, w_zero_ms, floor)

        return weight_fn_for

    variants = [{"label": "static", "window": None, "weight_fn_for": None}]
    for full_min, zero_min, floor in windows:
        variants.append(
            {
                "label": f"full{full_min:g}m_zero{zero_min:g}m_floor{floor:g}",
                "window": {"w_full_min": full_min, "w_zero_min": zero_min, "floor": floor},
                "weight_fn_for": make_weight_fn_for(full_min * 60_000, zero_min * 60_000, floor),
            }
        )

    anchored = sum(1 for p in truth if (query_embeddings.get(p) or {}).get("anchor_ms") is not None)
    out = []
    for v in variants:
        pk = fused_precision_at_k(
            event, truth, query_embeddings, k, w_face, w_person, tnorm, negatives, judged, weight_fn_for=v["weight_fn_for"]
        )
        sweep = threshold_sweep(
            event, truth, query_embeddings, w_face, w_person, tnorm, negatives, judged, weight_fn_for=v["weight_fn_for"]
        )
        out.append(
            {"label": v["label"], "window": v["window"], "fused_precision_at_k": pk, "threshold_sweep": sweep["points"]}
        )
    return {"weights": [w_face, w_person], "tnorm": tnorm, "k": k, "anchored_people": anchored, "variants": out}


def fused_precision_at_k(
    event, truth, query_embeddings, k, w_face, w_person, tnorm, negatives=None, judged=False, weight_fn_for=None
) -> float | None:
    """Mean fused P@K at fixed weights, with or without T-norm. Unlike per-modality
    P@K (unchanged by the monotonic T-norm), fusion P@K CAN move because tnorm
    rescales the two modalities relative to each other before the weighted sum."""
    negatives = negatives or {}
    total = 0.0
    n = 0
    for person, relevant in truth.items():
        q = query_embeddings.get(person)
        if q is None:
            continue
        pwf = weight_fn_for(person) if weight_fn_for is not None else None
        ranked = [h["photoId"] for h in _fused_candidates(event, q, w_face, w_person, tnorm, person_weight_fn=pwf)[: k * 3]]
        if not ranked:
            continue
        m = (
            judged_metrics_at_k(ranked, relevant, negatives.get(person, set()), k)
            if judged
            else metrics_at_k(ranked, relevant, k)
        )
        if m["precision"] is not None:
            total += m["precision"]
            n += 1
    return total / n if n else None


def evaluate(
    event,
    truth: dict[str, set[str]],
    query_embeddings: dict,
    k: int,
    negatives: dict[str, set[str]] | None = None,
    judged: bool = False,
) -> dict:
    """query_embeddings: person → {"face": vec|None, "person": vec|None}.

    When `judged` (EVAL_FEEDBACK_LOOP.md §3), score only labeled pairs from
    partial user feedback: `truth` is the confirmed-positive set and `negatives`
    the explicit "wrong" set; unjudged results are excluded, recall is None, and
    the gate target rises to 0.85."""
    negatives = negatives or {}
    report: dict = {"k": k, "judged": judged, "per_mode": {}}

    def run_mode(name: str, ranked_fn, keep_retrieved: bool = False) -> dict:
        per_person = {}
        # Mean only over queries that produced a (non-None) value for each key.
        agg: dict[str, float] = defaultdict(float)
        cnt: dict[str, int] = defaultdict(int)
        n = 0
        judged_pairs = 0
        for person, relevant in truth.items():
            q = query_embeddings.get(person)
            if q is None:
                continue
            ranked = ranked_fn(q)
            if ranked is None:
                continue
            ranked_ids = [h["photoId"] for h in ranked]
            if judged:
                m = judged_metrics_at_k(ranked_ids, relevant, negatives.get(person, set()), k)
                judged_pairs += m["judged"]
            else:
                m = metrics_at_k(ranked_ids, relevant, k)
            if keep_retrieved:
                m["retrieved"] = [
                    {"photoId": h["photoId"], "labeled": h["photoId"] in relevant}
                    for h in ranked[:k]
                ]
            per_person[person] = m
            for key in ("precision", "recall", "fp_rate"):
                if m[key] is not None:
                    agg[key] += m[key]
                    cnt[key] += 1
            n += 1
        means = {key: (agg[key] / cnt[key] if cnt[key] else None) for key in ("precision", "recall", "fp_rate")}
        out = {"mean": means, "queries": n, "per_person": per_person}
        if judged:
            out["judged_pairs"] = judged_pairs
        return out

    report["per_mode"]["face"] = run_mode(
        "face",
        lambda q: event.top_photos("face", q["face"], k=k) if q["face"] is not None else None,
        keep_retrieved=True,
    )
    report["per_mode"]["person"] = run_mode(
        "person",
        lambda q: event.top_photos("person", q["person"], k=k) if q["person"] is not None else None,
        keep_retrieved=True,
    )

    report["fusion_sweep"] = []
    for w_face, w_person in WEIGHT_SWEEP:
        def fused(q, wf=w_face, wp=w_person):
            face_hits = event.top_photos("face", q["face"], k=k * 3) if q["face"] is not None else []
            person_hits = event.top_photos("person", q["person"], k=k * 3) if q["person"] is not None else []
            if not face_hits and not person_hits:
                return None
            return fusion_mod.fuse(face_hits, person_hits, w_face=wf, w_person=wp, top_k=k)

        entry = run_mode(f"fused_{w_face}_{w_person}", fused)
        report["fusion_sweep"].append({"w_face": w_face, "w_person": w_person, **entry})

    def prec_or_neg(e: dict) -> float:
        p = e["mean"]["precision"]
        return p if p is not None else -1.0

    best = max(report["fusion_sweep"], key=prec_or_neg)
    target = 0.85 if judged else 0.8
    best_p = best["mean"]["precision"]
    report["best_fusion"] = {"w_face": best["w_face"], "w_person": best["w_person"], "mean": best["mean"]}
    report["gate"] = {
        "target_precision_at_k": target,
        "passed": best_p is not None and best_p >= target,
    }
    return report


def embed_queries(queries_dir: str) -> dict:
    """Embed reference photos; average multiple references per person. Also
    reads each person's capture-time anchor (Item 1) from the FIRST reference
    selfie with a parseable EXIF DateTimeOriginal — mirroring production, where
    the anchor is the first uploaded selfie's time. `anchor_ms` is None when no
    reference carries EXIF time (→ static person weight, no regression)."""
    import numpy as np

    from pipeline import decode_image, embed_image, read_capture_time_ms

    out = {}
    for person in sorted(os.listdir(queries_dir)):
        pdir = os.path.join(queries_dir, person)
        if not os.path.isdir(pdir):
            continue
        face_vecs, person_vecs = [], []
        anchor_ms = None
        for name in sorted(os.listdir(pdir)):
            path = os.path.join(pdir, name)
            try:
                with open(path, "rb") as f:
                    raw = f.read()
                if anchor_ms is None:
                    anchor_ms = read_capture_time_ms(raw)
                result = embed_image(decode_image(raw))
            except Exception as exc:
                print(f"  SKIP query {person}/{name}: {exc}", file=sys.stderr)
                continue
            usable = [f_ for f_ in result["faces"] if f_["quality"]["usable"]]
            if usable:
                best = max(usable, key=lambda f_: f_["score"])
                face_vecs.append(best["embedding"])
                idx = result["faces"].index(best)
                match = next((p for p in result["persons"] if p["face_idx"] == idx), None)
                if match is not None:
                    person_vecs.append(match["embedding"])
            elif result["persons"]:
                person_vecs.append(max(result["persons"], key=lambda p: p["score"])["embedding"])

        def avg(vecs):
            if not vecs:
                return None
            v = np.mean(np.stack(vecs), axis=0)
            return v / max(np.linalg.norm(v), 1e-12)

        out[person] = {"face": avg(face_vecs), "person": avg(person_vecs), "anchor_ms": anchor_ms}
        anchor_note = f"anchor={anchor_ms}" if anchor_ms is not None else "anchor=none"
        print(f"  query '{person}': {len(face_vecs)} face refs, {len(person_vecs)} person refs, {anchor_note}")
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--store", required=True)
    parser.add_argument("--event-id", required=True)
    parser.add_argument("--labels", required=True)
    parser.add_argument("--queries", required=True)
    parser.add_argument("--k", type=int, default=20)
    parser.add_argument("--report", default="")
    parser.add_argument(
        "--judged-only",
        action="store_true",
        help="score only labeled pairs from user feedback (label column confirmed|wrong); "
        "unjudged results excluded, recall omitted, gate target 0.85 "
        "(EVAL_FEEDBACK_LOOP.md). Use labels from export_feedback_labels.py.",
    )
    parser.add_argument(
        "--tnorm",
        action="store_true",
        help="add a T-norm (§1.3) analysis: fused P@K raw-vs-normalized and a "
        "precision/recall-vs-threshold sweep for each, to pick MATCHER_NORM_THRESHOLD.",
    )
    parser.add_argument(
        "--prf",
        action="store_true",
        help="add a pseudo-relevance-feedback (§1.2) pass: fold --prf-fold of each "
        "person's relevant photos into the query and measure recall@k lift on the rest.",
    )
    parser.add_argument("--prf-fold", type=int, default=1, help="photos to fold in per person for --prf (default 1)")
    parser.add_argument(
        "--time-conditional",
        action="store_true",
        help="add a capture-time-conditional outfit-fusion (Item 1) sweep: scale each "
        "candidate's person weight by time_decay(|takenAt - query anchor|) and compare "
        "windows to the static baseline, to pick PERSON_TIME_W_FULL/ZERO/FLOOR.",
    )
    parser.add_argument(
        "--time-windows",
        default=DEFAULT_TIME_WINDOWS,
        help="';'-separated w_full_min:w_zero_min:floor tuples for --time-conditional "
        f"(default '{DEFAULT_TIME_WINDOWS}').",
    )
    parser.add_argument(
        "--anchors",
        default="",
        help="JSON {person: epoch_ms | ISO8601} overriding each query's capture-time anchor "
        "(e.g. real Find-Me upload times from match_runs); default uses the reference selfie's EXIF.",
    )
    args = parser.parse_args()

    from store import EmbeddingStore

    negatives: dict[str, set[str]] = {}
    if args.judged_only:
        truth, negatives = load_judged_labels(args.labels)
        pairs = sum(len(v) for v in truth.values()) + sum(len(v) for v in negatives.values())
        print(f"Loaded JUDGED labels: {len(set(truth) | set(negatives))} people, {pairs} judged pairs")
    else:
        truth = load_labels(args.labels)
        print(f"Loaded labels: {len(truth)} people, {sum(len(v) for v in truth.values())} (photo,person) pairs")
    event = EmbeddingStore(args.store).load_event(args.event_id)
    print(f"Event '{args.event_id}': {len(event.meta['face'])} face rows, {len(event.meta['person'])} person rows")
    queries = embed_queries(args.queries)
    if not queries:
        sys.exit(
            f"ERROR: no reference photos found in '{args.queries}'. "
            "Expected one subfolder per labeled person (e.g. queries/alice/selfie.jpg) — "
            "see eval/queries/README.md."
        )
    if args.anchors:
        anchors = load_anchors(args.anchors)
        applied = 0
        for person, ms in anchors.items():
            if person in queries:
                queries[person]["anchor_ms"] = ms
                applied += 1
        print(f"Applied {applied}/{len(anchors)} anchor overrides from {args.anchors}")

    all_people = set(truth) | set(negatives)
    missing = sorted(all_people - set(queries))
    if missing:
        print(f"WARNING: labeled people with no reference photos (skipped): {', '.join(missing)}")

    report = evaluate(event, truth, queries, args.k, negatives=negatives, judged=args.judged_only)

    def fmt(v: float | None) -> str:
        return f"{v:.3f}" if v is not None else "  n/a"

    print(f"\n=== Results @ K={args.k}{' (judged-only)' if args.judged_only else ''} ===")
    for mode in ("face", "person"):
        m = report["per_mode"][mode]["mean"]
        print(f"  {mode:>7}: P={fmt(m['precision'])}  R={fmt(m['recall'])}  FP={fmt(m['fp_rate'])}")
    print("  fusion sweep:")
    for e in report["fusion_sweep"]:
        m = e["mean"]
        print(f"    wF={e['w_face']:.1f} wP={e['w_person']:.1f}: P={fmt(m['precision'])}  R={fmt(m['recall'])}")
    b = report["best_fusion"]
    gate = "PASS ✅" if report["gate"]["passed"] else "FAIL ❌"
    target = report["gate"]["target_precision_at_k"]
    print(f"\n  Best: wF={b['w_face']} wP={b['w_person']} → P@{args.k}={fmt(b['mean']['precision'])}  → gate (≥{target}): {gate}")

    if args.judged_only:
        pairs = report["per_mode"]["face"].get("judged_pairs", 0)
        users = len(all_people)
        if pairs < 20 or users < 5:
            print(f"  ⚠️  Below evidence bar ({pairs} judged pairs, {users} users; need ≥20 pairs / ≥5 users) — number not meaningful.")
    else:
        # Retrieved-but-unlabeled photos: likely true hits missing from labels.csv.
        print("\n  Retrieved but unlabeled (face mode) — check these for missed labels:")
        for person, pm in report["per_mode"]["face"]["per_person"].items():
            unlabeled = [r["photoId"] for r in pm.get("retrieved", []) if not r["labeled"]]
            print(f"    {person} ({len(unlabeled)}):")
            for pid in unlabeled:
                print(f"      {pid}")

    if args.tnorm:
        bw_f, bw_p = report["best_fusion"]["w_face"], report["best_fusion"]["w_person"]
        pk_raw = fused_precision_at_k(event, truth, queries, args.k, bw_f, bw_p, False, negatives, args.judged_only)
        pk_tn = fused_precision_at_k(event, truth, queries, args.k, bw_f, bw_p, True, negatives, args.judged_only)
        sweeps = {
            "raw": threshold_sweep(event, truth, queries, bw_f, bw_p, False, negatives, args.judged_only),
            "tnorm": threshold_sweep(event, truth, queries, bw_f, bw_p, True, negatives, args.judged_only),
        }
        report["tnorm_analysis"] = {
            "weights": [bw_f, bw_p],
            "fused_precision_at_k": {"raw": pk_raw, "tnorm": pk_tn},
            "threshold_sweep": sweeps,
        }
        print(f"\n=== T-norm analysis (fused wF={bw_f} wP={bw_p}) ===")
        print(f"  Fused P@{args.k}:  raw={fmt(pk_raw)}   tnorm={fmt(pk_tn)}")
        for name in ("raw", "tnorm"):
            print(f"  {name} threshold sweep (threshold → P / R):")
            for pt in sweeps[name]["points"]:
                print(f"    t={pt['threshold']:>8.4f}: P={fmt(pt['precision'])}  R={fmt(pt['recall'])}  (tp={pt['tp']} fp={pt['fp']})")
        print("  → pick MATCHER_NORM_THRESHOLD from the tnorm row that meets your precision target with the most recall.")

    if args.prf:
        prf = prf_evaluate(event, truth, queries, args.k, fold=args.prf_fold, tnorm=args.judged_only and False)
        report["prf_analysis"] = prf
        m = prf["mean"]
        print(f"\n=== PRF analysis (face, fold={args.prf_fold}, {prf['queries']} eligible people) ===")
        print(f"  Recall@{args.k}:  base={fmt(m['base_recall'])}   +PRF={fmt(m['prf_recall'])}   lift={fmt(m['lift'])}")
        if prf["queries"] == 0:
            print("  ⚠️  No person had more than --prf-fold relevant photos — nothing to hold out.")

    if args.time_conditional:
        bw_f, bw_p = report["best_fusion"]["w_face"], report["best_fusion"]["w_person"]
        windows = parse_windows(args.time_windows)
        tc = time_conditional_sweep(
            event, truth, queries, args.k, bw_f, bw_p, windows, tnorm=False, negatives=negatives, judged=args.judged_only
        )
        report["time_analysis"] = tc
        print(f"\n=== Capture-time-conditional fusion (Item 1; fused wF={bw_f} wP={bw_p}) ===")
        print(f"  {tc['anchored_people']}/{len(truth)} people have a query capture-time anchor.")
        if tc["anchored_people"] == 0:
            print("  ⚠️  No query has a capture-time anchor — every window equals the static baseline.")
            print("      Provide real upload times via --anchors, or use reference selfies with EXIF.")
        if bw_p == 0.0:
            print("  ⚠️  Best fusion weight is face-only (wP=0) — time-conditioning is inert here.")
        for v in tc["variants"]:
            best_pt = max(
                (p for p in v["threshold_sweep"] if p["precision"] is not None),
                key=lambda p: (p["precision"], p["tp"]),
                default=None,
            )
            best_str = (
                f"best-op t={best_pt['threshold']:.4f} P={fmt(best_pt['precision'])} tp={best_pt['tp']} fp={best_pt['fp']}"
                if best_pt
                else "no scored points"
            )
            print(f"    {v['label']:>24}: P@{args.k}={fmt(v['fused_precision_at_k'])}  {best_str}")
        print("  → pick the window that keeps precision at target with the most true positives (tp) retained.")

    if args.report:
        with open(args.report, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, default=lambda o: None)
        print(f"  Report written to {args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
