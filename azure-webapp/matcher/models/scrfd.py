"""
scrfd.py — SCRFD face detector (InsightFace `det_10g.onnx` from buffalo_l).

Standalone onnxruntime implementation (no `insightface` package dependency —
keeps the Cloud Run image slim). Returns face boxes, 5-point landmarks and
detection scores in original-image coordinates.

Reference: deepinsight/insightface SCRFD postprocessing (strides 8/16/32,
2 anchors per location, distance-to-bbox/kps regression).
"""

from __future__ import annotations

import numpy as np

from .common import clamp_box, letterbox

INPUT_SIZE = 640
STRIDES = (8, 16, 32)
NUM_ANCHORS = 2


def _distance2bbox(points: np.ndarray, distance: np.ndarray) -> np.ndarray:
    return np.stack(
        [
            points[:, 0] - distance[:, 0],
            points[:, 1] - distance[:, 1],
            points[:, 0] + distance[:, 2],
            points[:, 1] + distance[:, 3],
        ],
        axis=-1,
    )


def _distance2kps(points: np.ndarray, distance: np.ndarray) -> np.ndarray:
    out = []
    for i in range(0, distance.shape[1], 2):
        out.append(points[:, 0] + distance[:, i])
        out.append(points[:, 1] + distance[:, i + 1])
    return np.stack(out, axis=-1)  # (N, 10)


def _nms(dets: np.ndarray, iou_thresh: float) -> list[int]:
    """Greedy NMS on dets = [[x1,y1,x2,y2,score], ...] sorted by score desc."""
    x1, y1, x2, y2, scores = dets[:, 0], dets[:, 1], dets[:, 2], dets[:, 3], dets[:, 4]
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0.0, xx2 - xx1 + 1) * np.maximum(0.0, yy2 - yy1 + 1)
        iou = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[1:][iou <= iou_thresh]
    return keep


class ScrfdDetector:
    """SCRFD ONNX face detector."""

    def __init__(self, model_path: str, providers: list[str] | None = None):
        import onnxruntime as ort

        self.session = ort.InferenceSession(
            model_path, providers=providers or ["CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name
        self._center_cache: dict[tuple[int, int, int], np.ndarray] = {}

    def detect(
        self,
        img_rgb: np.ndarray,
        score_thresh: float = 0.5,
        iou_thresh: float = 0.4,
    ) -> list[dict]:
        """Detect faces. Returns [{box, kps, score}] in original coords,
        sorted by score descending. box = [x1,y1,x2,y2]; kps = (5,2)."""
        h, w = img_rgb.shape[:2]
        canvas, scale, pad_x, pad_y = letterbox(img_rgb, INPUT_SIZE)
        blob = (canvas.astype(np.float32) - 127.5) / 128.0
        blob = blob.transpose(2, 0, 1)[None]  # NCHW, RGB

        outputs = self.session.run(None, {self.input_name: blob})

        scores_list, bboxes_list, kps_list = [], [], []
        for idx, stride in enumerate(STRIDES):
            scores = outputs[idx].reshape(-1)
            bbox_preds = outputs[idx + len(STRIDES)].reshape(-1, 4) * stride
            kps_preds = outputs[idx + 2 * len(STRIDES)].reshape(-1, 10) * stride

            fm = INPUT_SIZE // stride
            key = (fm, fm, stride)
            centers = self._center_cache.get(key)
            if centers is None:
                grid = np.stack(
                    np.mgrid[:fm, :fm][::-1], axis=-1
                ).astype(np.float32)  # (fm, fm, 2) as (x, y)
                centers = (grid * stride).reshape(-1, 2)
                centers = np.stack([centers] * NUM_ANCHORS, axis=1).reshape(-1, 2)
                self._center_cache[key] = centers

            keep = np.where(scores >= score_thresh)[0]
            if keep.size == 0:
                continue
            scores_list.append(scores[keep])
            bboxes_list.append(_distance2bbox(centers[keep], bbox_preds[keep]))
            kps_list.append(_distance2kps(centers[keep], kps_preds[keep]))

        if not scores_list:
            return []

        scores = np.concatenate(scores_list)
        bboxes = np.concatenate(bboxes_list)
        kpss = np.concatenate(kps_list)

        # Map letterboxed coords back to original image.
        bboxes[:, [0, 2]] = (bboxes[:, [0, 2]] - pad_x) / scale
        bboxes[:, [1, 3]] = (bboxes[:, [1, 3]] - pad_y) / scale
        kpss[:, 0::2] = (kpss[:, 0::2] - pad_x) / scale
        kpss[:, 1::2] = (kpss[:, 1::2] - pad_y) / scale

        dets = np.hstack([bboxes, scores[:, None]]).astype(np.float32)
        order = dets[:, 4].argsort()[::-1]
        dets, kpss = dets[order], kpss[order]
        keep = _nms(dets, iou_thresh)

        results = []
        for i in keep:
            results.append(
                {
                    "box": clamp_box(dets[i, :4], w, h),
                    "kps": kpss[i].reshape(5, 2),
                    "score": float(dets[i, 4]),
                }
            )
        return results
