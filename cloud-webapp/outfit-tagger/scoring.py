"""
scoring.py — combining a sample query and a text query into one ranking.

**Why the modalities are normalized before they are blended.** SigLIP puts images
and text in one space, but not on one scale: image↔image cosines for same-ish
crops land around 0.5–0.9, while image↔text cosines for a correct description land
around 0.05–0.15. A plain `w*text + (1-w)*sample` is therefore almost entirely the
sample term for any sane `w`, and the weight the caller sets does not mean what it
says. Both sides are therefore mapped onto a common scale — but NOT the same way,
and the difference is the whole point of this module.

**Samples: cohort z-score.** An image query is compared against crops drawn from
the same distribution, so test-normalization against the event's own crops is
sound — the same transform the matcher applies in `store.top_k(tnorm=True)`, for
the same reason. The cohort is the *masked* row set: if the caller is ranking only
`head` crops, the background must be head crops too.

**Text: calibration against a query-independent background, NOT a cohort z-score.**
Cohort z-scoring the text channel is *actively wrong*, and it shipped that way
until a real measurement caught it. Dividing by the per-query standard deviation
removes exactly the signal that carries relevance: an out-of-domain prompt ("a
laptop keyboard close up") is uniformly dissimilar to every crop, so its spread is
tiny and any slight outlier becomes a large z; a relevant prompt ("a runner in
pink shorts") is broadly similar to *all* runner crops, so its best hit sits fewer
std above a higher mean. Measured on event 2622d5ab (2,589 person crops), absurd
prompts scored a mean max of **+4.41** against plausible ones at **+3.36** — the
ranking inverted — while the RAW cosines separated cleanly (0.106 vs 0.031, and
min(plausible) > max(absurd) in both regions).

Because a z-score is affine it never reordered results *within* one query; what it
corrupted was magnitude, which is what the blend weight and any threshold consume.
So the text channel is instead scaled by statistics that do not depend on the
query: the mean and std of the (background-prompt × crop) cosine population for
this event. A uniformly-dissimilar query then scores low everywhere, which is the
correct answer, and a relevant one scores high on its matches.

Scores are consequently in "std above the event's text background" units, not
cosines. No default gate is applied — the plan's guardrails require an offline
sweep on judged labels before a number gates anything, so the service caps results
by `top_k` and leaves the cutoff to the caller.
"""

from __future__ import annotations

import numpy as np


def mean_unit(vectors) -> np.ndarray | None:
    """Mean of unit vectors, re-normalized — the few-shot prototype for a set of
    samples. Returns None for an empty set (no query, as opposed to a zero
    query, which would score everything identically)."""
    arr = [np.asarray(v, dtype=np.float32).reshape(-1) for v in vectors]
    arr = [v for v in arr if v.size and np.isfinite(v).all()]
    if not arr:
        return None
    stacked = np.stack(arr)
    centroid = stacked.mean(axis=0)
    norm = float(np.linalg.norm(centroid))
    if norm < 1e-12:
        # Samples that cancel out (antipodal vectors) carry no direction; treat
        # that as "no usable query" rather than returning a garbage unit vector.
        return None
    return (centroid / norm).astype(np.float32)


# Generic prompts spanning the kinds of content an event photo might contain, used
# ONLY to characterize where this event's image↔text cosines sit — never to answer
# a query. They must stay generic and stay fixed: the calibration has to be
# independent of what any caller asks, or the bug this replaces comes straight
# back. Deliberately disjoint from anything used to evaluate the fix, so the
# verification is not measuring its own calibration set.
BACKGROUND_PROMPTS = (
    "a photograph",
    "a person",
    "clothing",
    "an outdoor scene",
    "a close-up",
    "a building",
    "an animal",
    "a vehicle",
    "food",
    "the sky",
    "grass",
    "a crowd of people",
    "a road",
    "trees",
    "text on a sign",
)


def text_calibration(
    vectors: np.ndarray,
    embed_text,
    prompts=BACKGROUND_PROMPTS,
) -> tuple[float, float]:
    """(mean, std) of the (background-prompt × crop) cosine population.

    This is what the text channel is scaled by. It depends on the event's crops
    and on the model, but NOT on the caller's query — which is the property that
    makes the score comparable across queries, and the property a cohort z-score
    lacks.

    Cost is one text embed per prompt, once per event per process (the caller
    caches it); the dot products are free next to that.
    """
    if vectors.size == 0 or not prompts:
        return 0.0, 1.0
    sims = np.stack([vectors @ np.asarray(embed_text(p), dtype=np.float32).reshape(-1) for p in prompts])
    std = float(sims.std())
    # A degenerate background (identical crops, or a broken tower) must not turn
    # into a divide-by-noise that inflates every score.
    return float(sims.mean()), std if std > 1e-6 else 1.0


def scale(sims: np.ndarray, mean: float, std: float) -> np.ndarray:
    """Apply a FIXED (query-independent) affine calibration — the text path."""
    sims = np.asarray(sims, dtype=np.float32)
    if sims.size == 0:
        return sims
    return ((sims - mean) / (std if abs(std) > 1e-6 else 1.0)).astype(np.float32)


def zscore(sims: np.ndarray, mask: np.ndarray | None = None) -> np.ndarray:
    """Z-score `sims` against the masked cohort — the SAMPLE path only.

    Sound for image↔image similarity, where query and cohort come from the same
    distribution. **Do not use this for the text channel** (see the module
    docstring): the per-query std is precisely what destroys text relevance, and
    `scale()` with `text_calibration()` is the text path.

    Masked-out rows are still returned (so the array stays row-aligned with the
    index) but take no part in the mean/std. A cohort of fewer than two rows has
    no meaningful spread, so the raw similarities are passed through — a
    degenerate event must not turn into a divide-by-noise.
    """
    sims = np.asarray(sims, dtype=np.float32)
    if sims.size == 0:
        return sims
    cohort = sims if mask is None else sims[mask]
    if cohort.size < 2:
        return sims
    std = float(cohort.std())
    if std < 1e-6:
        return sims - float(cohort.mean())
    return ((sims - float(cohort.mean())) / std).astype(np.float32)


def fuse(
    sample_z: np.ndarray | None,
    text_z: np.ndarray | None,
    text_weight: float,
) -> np.ndarray:
    """Blend the two z-scored modalities.

    With only one modality present its z-scores ARE the result — a text-only or
    samples-only query must not be silently scaled by a weight meant for a blend.
    """
    if sample_z is None and text_z is None:
        raise ValueError("fuse() needs at least one modality")
    if text_z is None:
        return np.asarray(sample_z, dtype=np.float32)
    if sample_z is None:
        return np.asarray(text_z, dtype=np.float32)
    w = min(max(float(text_weight), 0.0), 1.0)
    return ((1.0 - w) * sample_z + w * text_z).astype(np.float32)


def rank_photos(
    index,
    scores: np.ndarray,
    mask: np.ndarray,
    top_k: int | None,
    min_score: float | None,
    components: dict[str, np.ndarray] | None = None,
) -> list[dict]:
    """Best-scoring crop per photo, best first.

    Per-photo rather than per-crop because the caller asks "which photos show
    this outfit", and a photo with six people in it should be represented by its
    best-matching crop rather than appearing six times. `components` (e.g. the
    per-modality z-scores) are reported for the winning crop so a caller can see
    whether a hit was driven by the samples or by the description — the same
    reason `match_runs` stores per-modality scores for Find-Me.
    """
    if len(scores) == 0:
        return []
    best: dict[str, dict] = {}
    for i in np.nonzero(mask)[0]:
        i = int(i)
        score = float(scores[i])
        if min_score is not None and score < min_score:
            continue
        row = index.rows[i]
        pid = str(row.get("photoId"))
        prev = best.get(pid)
        if prev is not None and prev["score"] >= score:
            continue
        hit = {
            "photoId": pid,
            "score": score,
            "region": row.get("region"),
            "box": row.get("box"),
            "row": i,
        }
        if components:
            for name, arr in components.items():
                hit[name] = float(arr[i]) if arr is not None and len(arr) > i else None
        best[pid] = hit
    ranked = sorted(best.values(), key=lambda h: -h["score"])
    return ranked if top_k is None else ranked[:top_k]
