"""
quality.py — per-face quality checks.

Two consumers, same numbers:
  * reference photos (PRD FR-7/FR-8) — reject or warn on no-face / tiny / blurry
    uploads before running a search;
  * indexed gallery faces — the indexer persists this verdict per face row so
    the matcher can score a photo's suitability as an *anchor* (a confirmed,
    front-facing, in-domain reference to re-query with) and optionally
    down-weight faces that are too small/side-on to embed reliably
    (PEOPLE_RECOGNITION_QUALITY_PLAN.md Item 5).
"""

from __future__ import annotations

import numpy as np

MIN_FACE_PX = 40          # min face box side in pixels
MIN_DET_SCORE = 0.5       # SCRFD score threshold for a usable face
BLUR_THRESHOLD = 45.0     # variance of Laplacian below this = too blurry

# 5-point landmark order as returned by SCRFD (models/scrfd.py): left eye,
# right eye, nose, left mouth corner, right mouth corner.
_LEFT_EYE, _RIGHT_EYE, _NOSE = 0, 1, 2

# Nose offset (in interocular widths) treated as full profile — i.e. the point
# where `frontality` bottoms out at 0. A head-on face sits near 0.0 and a true
# profile near 0.5, so 0.35 puts the knee well into "one cheek only" territory.
YAW_FULL_PROFILE = 0.35

# Face-to-image size fraction at which a face is "as big as it needs to be" for
# quality purposes; used to turn `face_frac` into a 0..1 term.
FULL_FACE_FRAC = 0.08


def face_size_ok(box: list[float], min_px: int = MIN_FACE_PX) -> bool:
    return (box[2] - box[0]) >= min_px and (box[3] - box[1]) >= min_px


def blur_score(img_rgb: np.ndarray, box: list[float] | None = None) -> float:
    """Variance of the Laplacian (higher = sharper). Crops to `box` if given."""
    import cv2

    img = img_rgb
    if box is not None:
        x1, y1, x2, y2 = (int(round(v)) for v in box)
        img = img_rgb[max(0, y1) : max(0, y2), max(0, x1) : max(0, x2)]
        if img.size == 0:
            return 0.0
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def frontality(kps) -> float | None:
    """How head-on a face is, 1.0 = nose centred between the eyes, 0.0 = profile.

    Yaw proxy: the nose's offset from the eye midpoint measured ALONG the
    interocular axis, in units of interocular distance. It is ~0 head-on and
    grows toward ±0.5 as the head turns, and because both the offset and its
    normalizer rotate with the head it is invariant to face size and in-plane
    roll. Costs nothing extra — SCRFD already returns the landmarks.

    Returns None when landmarks are missing or degenerate (eyes coincident), so
    callers can tell "not frontal" apart from "not measured" — an indexed face
    from before this field existed must not be treated as side-on.
    """
    if kps is None:
        return None
    pts = np.asarray(kps, dtype=np.float32).reshape(-1, 2)
    if pts.shape[0] <= _NOSE:
        return None
    axis = pts[_RIGHT_EYE] - pts[_LEFT_EYE]
    span_sq = float(axis @ axis)
    if span_sq < 1e-6:
        return None
    midpoint = (pts[_LEFT_EYE] + pts[_RIGHT_EYE]) / 2.0
    offset = abs(float((pts[_NOSE] - midpoint) @ axis)) / span_sq
    return max(0.0, 1.0 - offset / YAW_FULL_PROFILE)


def face_fraction(box: list[float], img_shape: tuple[int, ...]) -> float:
    """Face box's short side as a fraction of the image's short side.

    Absolute `face_px` is not comparable across an event: the same person at the
    same distance measures 3× larger on a 24 MP body than on a phone. The
    fraction is, which is what makes "solo portrait" separable from "face in the
    back row" on mixed camera fleets.
    """
    short_side = float(min(img_shape[0], img_shape[1]))
    if short_side <= 0:
        return 0.0
    face_side = min(box[2] - box[0], box[3] - box[1])
    return max(0.0, float(face_side) / short_side)


def quality_term(front: float | None, frac: float | None) -> float:
    """Composite 0..1 reliability of a face crop's embedding.

    Multiplicative on purpose: a face that is BOTH small and side-on is far less
    trustworthy than the sum of the two penalties suggests — that combination is
    exactly the back-row crowd face whose embedding drifts toward whoever it
    vaguely resembles. An unmeasured component contributes 1.0 (neutral), so a
    manifest written before these fields existed scores as before.
    """
    front_term = 1.0 if front is None else max(0.0, min(1.0, front))
    size_term = 1.0 if frac is None else max(0.0, min(1.0, frac / FULL_FACE_FRAC))
    return front_term * size_term


# ── Reference-selfie grading (upload-time check) ─────────────────────────────
# A selfie is held at arm's length, so its face normally fills a good part of the
# frame; "full marks" is a much larger fraction than for a gallery photo.
SELFIE_FULL_FACE_FRAC = 0.25
# Advisory floors. These do NOT reject an upload — `assess_face().usable` is the
# only hard gate, and tightening it would start refusing selfies that search
# fine today. These drive "you could do better" hints instead.
SELFIE_ADVISE_FRONTALITY = 0.55
SELFIE_ADVISE_FACE_FRAC = 0.10
# Laplacian variance treated as properly sharp (BLUR_THRESHOLD is the floor at
# which we refuse outright, which is a long way from a good reference photo).
SHARP_BLUR = 4 * BLUR_THRESHOLD


def selfie_score(q: dict) -> float:
    """0..1 suitability of one detected face as a reference selfie.

    Same ingredients as the anchor ranking — front-on, big, sharp — so "the best
    selfie you gave us" and "the best photo of you in the event" are graded on
    one scale. Unmeasured frontality scores 0.6: not assumed frontal, but not
    punished as if it were known to be turned away."""
    front = q.get("frontality")
    frac = q.get("face_frac")
    blur = q.get("blur")
    front_term = 0.6 if front is None else max(0.0, min(1.0, front))
    size_term = 1.0 if frac is None else min(1.0, max(0.0, frac) / SELFIE_FULL_FACE_FRAC)
    sharp_term = 1.0 if blur is None else min(1.0, max(0.0, blur) / SHARP_BLUR)
    return round(0.45 * front_term + 0.35 * size_term + 0.20 * sharp_term, 4)


def face_advisories(q: dict) -> list[str]:
    """Non-blocking hints derivable from ONE face's own quality verdict.

    Shared by the pick-time `/quality` check and by `/search`, which reports the
    same codes for the face it actually queried with. One implementation on
    purpose: a searcher warned "turned away" before searching and then told
    nothing after (or vice versa) would rightly not trust either message.

    An unmeasured component yields no advisory — absent is "unknown", never
    "bad", so a face from a pre-quality manifest is not slandered.
    """
    out = []
    front = q.get("frontality")
    if front is not None and front < SELFIE_ADVISE_FRONTALITY:
        out.append("not_frontal")
    frac = q.get("face_frac")
    if frac is not None and frac < SELFIE_ADVISE_FACE_FRAC:
        out.append("face_small_in_frame")
    blur = q.get("blur")
    if blur is not None and BLUR_THRESHOLD <= blur < SHARP_BLUR:
        out.append("slightly_soft")
    return out


def selfie_advisories(q: dict, face_count: int) -> list[str]:
    """`face_advisories` plus the one hint that needs the whole frame.

    `multiple_faces` matters most: with a friend in frame the matcher searches
    for whichever face it is most confident about, which is a real cause of
    "it found someone else's photos" — and the user can only fix it at pick time.
    """
    out = ["multiple_faces"] if face_count > 1 else []
    out.extend(face_advisories(q))
    return out


def assess_face(img_rgb: np.ndarray, det: dict) -> dict:
    """Quality verdict for one detected face.

    Returns {usable, reasons[], warnings[], det_score, face_px, face_frac,
    frontality, blur}. `frontality` is None when the detector supplied no
    landmarks.

    `reasons` REJECT the face — it cannot be used as a query. `warnings` are
    advisory: the face works, but it is small or turned away and the searcher
    should be told, since that quietly costs them matches. Keeping the two
    apart is deliberate — a three-quarter view still matches, and promoting it
    to a rejection would refuse searches that succeed today.
    """
    reasons = []
    if det["score"] < MIN_DET_SCORE:
        reasons.append("low_confidence")
    if not face_size_ok(det["box"]):
        reasons.append("too_small")
    blur = blur_score(img_rgb, det["box"])
    if blur < BLUR_THRESHOLD:
        reasons.append("too_blurry")
    verdict = {
        "usable": not reasons,
        "reasons": reasons,
        "det_score": det["score"],
        "face_px": int(min(det["box"][2] - det["box"][0], det["box"][3] - det["box"][1])),
        "face_frac": face_fraction(det["box"], img_rgb.shape),
        "frontality": frontality(det.get("kps")),
        "blur": blur,
    }
    verdict["warnings"] = face_advisories(verdict)
    return verdict
