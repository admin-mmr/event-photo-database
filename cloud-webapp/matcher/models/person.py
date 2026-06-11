"""
person.py — person detection + ReID ("outfit") embedding.

- PersonDetector: YOLOv8 ONNX (class 0 = person). Optional: if no model file
  is present, the pipeline falls back to expanding face boxes
  (common.expand_face_to_person), which covers people whose faces are
  visible but misses back-of-head shots. Good enough to start M0; install
  the detector to evaluate outfit-only recall properly.
- ReidEmbedder: OSNet ONNX (256×128 input, 512-d output), ImageNet
  normalization, L2-normalized output.
"""

from __future__ import annotations

import numpy as np

from .common import clamp_box, l2_normalize, letterbox

YOLO_INPUT = 640
REID_H, REID_W = 256, 128

_IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


class PersonDetector:
    """YOLOv8-family ONNX detector, filtered to the `person` class."""

    def __init__(self, model_path: str, providers: list[str] | None = None):
        import onnxruntime as ort

        self.session = ort.InferenceSession(
            model_path, providers=providers or ["CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name

    def detect(
        self,
        img_rgb: np.ndarray,
        score_thresh: float = 0.4,
        iou_thresh: float = 0.5,
    ) -> list[dict]:
        """Returns [{box, score}] for persons, original coords, score desc."""
        import cv2

        h, w = img_rgb.shape[:2]
        canvas, scale, pad_x, pad_y = letterbox(img_rgb, YOLO_INPUT)
        blob = canvas.astype(np.float32) / 255.0
        blob = blob.transpose(2, 0, 1)[None]

        out = self.session.run(None, {self.input_name: blob})[0]
        # YOLOv8 ONNX output: (1, 4 + num_classes, N) → (N, 4 + C)
        preds = out[0].T
        boxes_cxcywh = preds[:, :4]
        person_scores = preds[:, 4]  # class 0 = person
        keep = person_scores >= score_thresh
        if not keep.any():
            return []
        boxes_cxcywh, person_scores = boxes_cxcywh[keep], person_scores[keep]

        # cxcywh (letterbox coords) → xyxy (original coords)
        cx, cy, bw, bh = boxes_cxcywh.T
        x1 = (cx - bw / 2 - pad_x) / scale
        y1 = (cy - bh / 2 - pad_y) / scale
        x2 = (cx + bw / 2 - pad_x) / scale
        y2 = (cy + bh / 2 - pad_y) / scale

        xywh = np.stack([x1, y1, x2 - x1, y2 - y1], axis=-1)
        idxs = cv2.dnn.NMSBoxes(
            xywh.tolist(), person_scores.tolist(), score_thresh, iou_thresh
        )
        idxs = np.array(idxs).reshape(-1)

        results = [
            {
                "box": clamp_box([x1[i], y1[i], x2[i], y2[i]], w, h),
                "score": float(person_scores[i]),
            }
            for i in idxs
        ]
        results.sort(key=lambda r: -r["score"])
        return results


class ReidEmbedder:
    """OSNet ONNX person-ReID embedder. embed(crop) → float32 (dim,), L2-normalized."""

    def __init__(self, model_path: str, providers: list[str] | None = None):
        import onnxruntime as ort

        self.session = ort.InferenceSession(
            model_path, providers=providers or ["CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name
        self.dim = int(self.session.get_outputs()[0].shape[-1])

    def embed(self, crop_rgb: np.ndarray) -> np.ndarray:
        import cv2

        resized = cv2.resize(crop_rgb, (REID_W, REID_H), interpolation=cv2.INTER_LINEAR)
        blob = resized.astype(np.float32) / 255.0
        blob = (blob - _IMAGENET_MEAN) / _IMAGENET_STD
        blob = blob.transpose(2, 0, 1)[None]
        out = self.session.run(None, {self.input_name: blob})[0]
        return l2_normalize(out.reshape(-1).astype(np.float32))
