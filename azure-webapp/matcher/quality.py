"""
quality.py — reference-photo quality checks (PRD FR-7/FR-8: reject or warn on
no-face / tiny / blurry uploads before running a search).
"""

from __future__ import annotations

import numpy as np

MIN_FACE_PX = 40          # min face box side in pixels
MIN_DET_SCORE = 0.5       # SCRFD score threshold for a usable face
BLUR_THRESHOLD = 45.0     # variance of Laplacian below this = too blurry

# ── Advisory thresholds ───────────────────────────────────────────────────────
# These do NOT reject a face — they are reported so the searcher can be told,
# right after uploading, why their reference is weak and what to change. A
# three-quarter view or a smallish face still matches, just less reliably, so
# blocking on them would refuse searches that work today.
SMALL_FACE_PX = 80        # usable, but small enough to hurt match quality
# |nose offset from the eye midpoint| as a fraction of inter-ocular distance.
# ~0 looking straight at the camera; grows as the head turns. 0.35 sits well
# past normal frontal variation and short of a full profile.
FRONTAL_RATIO = 0.35


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


def frontal_offset(kps) -> float | None:
    """How far the nose sits from the midpoint between the eyes, as a fraction
    of the inter-ocular distance. ~0 = looking at the camera; larger = the head
    is turned. None when landmarks are missing or the eyes coincide.

    Measured ALONG the eye axis rather than in raw x, so a tilted (rolled) head
    isn't mistaken for a turned one. SCRFD's 5 landmarks are ordered
    [left_eye, right_eye, nose, left_mouth, right_mouth].
    """
    if kps is None:
        return None
    pts = np.asarray(kps, dtype=np.float64)
    if pts.shape[0] < 3:
        return None
    left_eye, right_eye, nose = pts[0], pts[1], pts[2]
    axis = right_eye - left_eye
    span = float(np.hypot(axis[0], axis[1]))
    if span < 1e-6:
        return None
    v = nose - (left_eye + right_eye) / 2.0
    along = float(v[0] * axis[0] + v[1] * axis[1]) / span
    return abs(along) / span


def assess_face(img_rgb: np.ndarray, det: dict) -> dict:
    """Quality verdict for one detected face.

    Returns {usable, reasons[], warnings[], det_score, face_px, blur, frontality}.

    `reasons` REJECT the face (it can't be used as a query); `warnings` are
    advisory — the face is usable but the searcher should be told what is weak
    about their photo, since a small or turned-away face quietly costs matches.
    """
    reasons = []
    if det["score"] < MIN_DET_SCORE:
        reasons.append("low_confidence")
    if not face_size_ok(det["box"]):
        reasons.append("too_small")
    blur = blur_score(img_rgb, det["box"])
    if blur < BLUR_THRESHOLD:
        reasons.append("too_blurry")

    face_px = int(min(det["box"][2] - det["box"][0], det["box"][3] - det["box"][1]))
    frontality = frontal_offset(det.get("kps"))
    warnings = []
    if MIN_FACE_PX <= face_px < SMALL_FACE_PX:
        warnings.append("small_face")
    if frontality is not None and frontality > FRONTAL_RATIO:
        warnings.append("not_frontal")

    return {
        "usable": not reasons,
        "reasons": reasons,
        "warnings": warnings,
        "det_score": det["score"],
        "face_px": face_px,
        "blur": blur,
        "frontality": frontality,
    }
