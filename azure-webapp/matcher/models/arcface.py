"""
arcface.py — ArcFace face embedder (InsightFace `w600k_r50.onnx` from buffalo_l).

Aligns the face to the canonical 112×112 ArcFace template using the 5-point
landmarks from SCRFD, then produces an L2-normalized 512-d embedding.
"""

from __future__ import annotations

import numpy as np

from .common import l2_normalize

# Canonical 5-point destination template for 112×112 ArcFace alignment
# (left eye, right eye, nose, left mouth, right mouth) — from insightface.
ARCFACE_DST = np.array(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)

INPUT_SIZE = 112


def align_face(img_rgb: np.ndarray, kps: np.ndarray) -> np.ndarray:
    """Warp the image so the 5 landmarks land on the ArcFace template.

    Uses a similarity transform (cv2.estimateAffinePartial2D = 4-DoF), the
    same family of transform insightface uses via skimage.
    """
    import cv2

    src = np.asarray(kps, dtype=np.float32).reshape(5, 2)
    matrix, _ = cv2.estimateAffinePartial2D(src, ARCFACE_DST, method=cv2.LMEDS)
    if matrix is None:  # degenerate landmarks — fall back to identity-ish crop
        matrix = np.array([[1, 0, 0], [0, 1, 0]], dtype=np.float32)
    return cv2.warpAffine(img_rgb, matrix, (INPUT_SIZE, INPUT_SIZE), borderValue=0)


class ArcFaceEmbedder:
    """ArcFace ONNX embedder. embed() → float32 (512,), L2-normalized."""

    def __init__(self, model_path: str, providers: list[str] | None = None):
        import onnxruntime as ort

        self.session = ort.InferenceSession(
            model_path, providers=providers or ["CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name
        self.dim = int(self.session.get_outputs()[0].shape[-1])

    def embed(self, img_rgb: np.ndarray, kps: np.ndarray) -> np.ndarray:
        aligned = align_face(img_rgb, kps)
        blob = (aligned.astype(np.float32) - 127.5) / 127.5
        blob = blob.transpose(2, 0, 1)[None]  # NCHW, RGB
        out = self.session.run(None, {self.input_name: blob})[0]
        return l2_normalize(out.reshape(-1).astype(np.float32))
