"""
fusion.py — combine face + outfit (person-ReID) result lists into one ranking.

Python reference implementation for the M0 spike and eval harness; the
production fusion for the api lands in api/src/lib/fusion.ts in M2 and must
mirror this math (PRD §7.2). Two methods:

- "score": weighted sum of cosine similarities (missing modality → 0).
- "rrf":   reciprocal-rank fusion — robust when the two score scales differ.
"""

from __future__ import annotations

from collections.abc import Callable

# Face is the far more reliable signal than outfit/appearance, so it dominates
# the fused score. Outfit (person-ReID) is kept as a small tie-breaker / boost
# rather than an equal partner: with the old 0.7/0.3 split a confident face
# match (e.g. cosine 0.75) was diluted by a noisy outfit cosine down to ~0.67,
# which read as a discouragingly low match. 0.85/0.15 lets a strong face match
# carry the score while outfit still helps rank near-ties. (Pure outfit-only
# searches set mode='person' and bypass this blend entirely.)
DEFAULT_FACE_WEIGHT = 0.85
DEFAULT_PERSON_WEIGHT = 0.15
DEFAULT_THRESHOLD = 0.25  # min fused score to be reported at all
RRF_K = 60


def time_decay(
    dt_ms: float | None,
    w_full_ms: float,
    w_zero_ms: float,
    floor: float = 0.0,
) -> float:
    """Temporal attenuation multiplier in [floor, 1.0] for the outfit/person
    signal, as a function of the capture-time gap between the query anchor and a
    candidate photo (capture-time-conditional outfit fusion).

    1.0 within `w_full_ms` (same session → same outfit is a valid identity
    signal), linearly fading to `floor` by `w_zero_ms` (large gap ⇒ likely a
    clothing change or a coincidental look-alike, so distrust outfit). `dt_ms`
    of None (capture time unknown for query or candidate) returns 1.0 so the
    caller falls back to the static person weight — no regression when EXIF
    capture time is absent.
    """
    if dt_ms is None:
        return 1.0
    dt = abs(float(dt_ms))
    if dt <= w_full_ms:
        return 1.0
    if dt >= w_zero_ms:
        return floor
    frac = (dt - w_full_ms) / max(w_zero_ms - w_full_ms, 1e-9)
    return 1.0 + frac * (floor - 1.0)


def fuse(
    face_hits: list[dict],
    person_hits: list[dict],
    w_face: float = DEFAULT_FACE_WEIGHT,
    w_person: float = DEFAULT_PERSON_WEIGHT,
    method: str = "score",
    threshold: float = DEFAULT_THRESHOLD,
    top_k: int | None = 50,
    person_weight_fn: Callable[[str], float] | None = None,
) -> list[dict]:
    """Fuse two per-photo hit lists ([{photoId, score, ...}], best first).

    Returns [{photoId, score, faceScore, personScore, personWeight}], best
    first. `top_k=None` returns every photo above `threshold` (the threshold is
    the only gate) — use it when matches must not be capped at an arbitrary
    count.

    `person_weight_fn(photoId) -> float` overrides the scalar `w_person`
    per-photo (score method only) — used for capture-time-conditional fusion,
    where the outfit signal is down-weighted for candidates far in time from the
    query. None (the default) preserves the flat `w_person` for every photo.
    """
    if method not in ("score", "rrf"):
        raise ValueError(f"unknown fusion method: {method}")

    face_by_photo = {h["photoId"]: h for h in face_hits}
    person_by_photo = {h["photoId"]: h for h in person_hits}

    fused = []
    for pid in face_by_photo.keys() | person_by_photo.keys():
        f = face_by_photo.get(pid)
        p = person_by_photo.get(pid)
        wp = None
        if method == "score":
            wp = person_weight_fn(pid) if person_weight_fn is not None else w_person
            score = w_face * (f["score"] if f else 0.0) + wp * (p["score"] if p else 0.0)
        else:  # rrf — ranks are 0-based positions in the input lists
            score = 0.0
            if f is not None:
                score += w_face / (RRF_K + face_hits.index(f) + 1)
            if p is not None:
                score += w_person / (RRF_K + person_hits.index(p) + 1)
        fused.append(
            {
                "photoId": pid,
                "score": score,
                "faceScore": f["score"] if f else None,
                "personScore": p["score"] if p else None,
                "personWeight": wp if p is not None else None,
            }
        )

    fused = [h for h in fused if method == "rrf" or h["score"] >= threshold]
    fused.sort(key=lambda h: -h["score"])
    return fused if top_k is None else fused[:top_k]
