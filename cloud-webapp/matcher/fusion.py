"""
fusion.py — combine face + outfit (person-ReID) result lists into one ranking.

Python reference implementation for the M0 spike and eval harness; the
production fusion for the api lands in api/src/lib/fusion.ts in M2 and must
mirror this math (PRD §7.2). Two methods:

- "score": weighted sum of cosine similarities (missing modality → 0).
- "rrf":   reciprocal-rank fusion — robust when the two score scales differ.
"""

from __future__ import annotations

DEFAULT_FACE_WEIGHT = 0.7
DEFAULT_PERSON_WEIGHT = 0.3
DEFAULT_THRESHOLD = 0.25  # min fused score to be reported at all
RRF_K = 60


def fuse(
    face_hits: list[dict],
    person_hits: list[dict],
    w_face: float = DEFAULT_FACE_WEIGHT,
    w_person: float = DEFAULT_PERSON_WEIGHT,
    method: str = "score",
    threshold: float = DEFAULT_THRESHOLD,
    top_k: int | None = 50,
) -> list[dict]:
    """Fuse two per-photo hit lists ([{photoId, score, ...}], best first).

    Returns [{photoId, score, faceScore, personScore}], best first. `top_k=None`
    returns every photo above `threshold` (the threshold is the only gate) —
    use it when matches must not be capped at an arbitrary count.
    """
    if method not in ("score", "rrf"):
        raise ValueError(f"unknown fusion method: {method}")

    face_by_photo = {h["photoId"]: h for h in face_hits}
    person_by_photo = {h["photoId"]: h for h in person_hits}

    fused = []
    for pid in face_by_photo.keys() | person_by_photo.keys():
        f = face_by_photo.get(pid)
        p = person_by_photo.get(pid)
        if method == "score":
            score = w_face * (f["score"] if f else 0.0) + w_person * (p["score"] if p else 0.0)
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
            }
        )

    fused = [h for h in fused if method == "rrf" or h["score"] >= threshold]
    fused.sort(key=lambda h: -h["score"])
    return fused if top_k is None else fused[:top_k]
