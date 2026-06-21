"""
quality.py — reference-photo quality checks (PRD FR-7/FR-8: reject or warn on
no-face / tiny / blurry uploads before running a search).
"""

from __future__ import annotations

import numpy as np

MIN_FACE_PX = 40          # min face box side in pixels
MIN_DET_SCORE = 0.5       # SCRFD score threshold for a usable face
BLUR_THRESHOLD = 45.0     # variance of Laplacian below this = too blurry


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


def assess_face(img_rgb: np.ndarray, det: dict) -> dict:
    """Quality verdict for one detected face.

    Returns {usable, reasons[], det_score, face_px, blur}.
    """
    reasons = []
    if det["score"] < MIN_DET_SCORE:
        reasons.append("low_confidence")
    if not face_size_ok(det["box"]):
        reasons.append("too_small")
    blur = blur_score(img_rgb, det["box"])
    if blur < BLUR_THRESHOLD:
        reasons.append("too_blurry")
    return {
        "usable": not reasons,
        "reasons": reasons,
        "det_score": det["score"],
        "face_px": int(min(det["box"][2] - det["box"][0], det["box"][3] - det["box"][1])),
        "blur": blur,
    }
