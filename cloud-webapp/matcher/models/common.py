"""
common.py — shared image preprocessing helpers for the ONNX model wrappers.

All models consume RGB uint8 numpy arrays (H, W, 3). Callers decode files
with PIL/cv2 and convert to RGB before passing in.
"""

from __future__ import annotations

import numpy as np


def letterbox(img: np.ndarray, size: int) -> tuple[np.ndarray, float, int, int]:
    """Resize `img` to fit a size×size canvas, preserving aspect ratio.

    Returns (canvas, scale, pad_x, pad_y) where scale maps original→canvas
    coordinates: canvas_xy = orig_xy * scale + (pad_x, pad_y).
    """
    import cv2

    h, w = img.shape[:2]
    scale = min(size / w, size / h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    canvas = np.zeros((size, size, 3), dtype=img.dtype)
    pad_x, pad_y = (size - nw) // 2, (size - nh) // 2
    canvas[pad_y : pad_y + nh, pad_x : pad_x + nw] = resized
    return canvas, scale, pad_x, pad_y


def l2_normalize(v: np.ndarray, axis: int = -1, eps: float = 1e-12) -> np.ndarray:
    """L2-normalize along `axis` (safe for zero vectors)."""
    norm = np.linalg.norm(v, axis=axis, keepdims=True)
    return v / np.maximum(norm, eps)


def clamp_box(box: np.ndarray | list, w: int, h: int) -> list[float]:
    """Clamp an [x1, y1, x2, y2] box to image bounds."""
    x1, y1, x2, y2 = box
    return [
        float(max(0.0, min(x1, w - 1))),
        float(max(0.0, min(y1, h - 1))),
        float(max(0.0, min(x2, w))),
        float(max(0.0, min(y2, h))),
    ]


def expand_face_to_person(face_box: list[float], w: int, h: int) -> list[float]:
    """Heuristic person crop from a face box (fallback when no person
    detector model is available). Expands the face box to roughly cover
    the torso: ~3× width, ~6.5× height anchored just above the face.
    """
    x1, y1, x2, y2 = face_box
    fw, fh = x2 - x1, y2 - y1
    cx = (x1 + x2) / 2.0
    px1 = cx - fw * 1.5
    px2 = cx + fw * 1.5
    py1 = y1 - fh * 0.5
    py2 = y1 + fh * 6.5
    return clamp_box([px1, py1, px2, py2], w, h)
