"""
registry.py — lazy, process-wide model bundle.

Models load once on first use (Cloud Run cold start cost is paid once per
instance). Paths come from MODEL_DIR (default ./model_files):

    MODEL_DIR/
      det_10g.onnx        # SCRFD face detector        (required)
      w600k_r50.onnx      # ArcFace face embedder      (required)
      yolov8n.onnx        # person detector            (optional — falls back
                          #   to face-box expansion when absent)
      osnet_x0_25.onnx    # person-ReID embedder       (required for outfit)

`MODEL_VERSION` tags every embedding written to the store; bump it whenever
any model file changes so the indexer knows to re-embed (dev plan §8).
"""

from __future__ import annotations

import os
import threading

MODEL_VERSION = os.environ.get("MODEL_VERSION", "scrfd10g+arcface_r50+osnet_x0_25@m0")

_DEFAULT_FILES = {
    "face_det": "det_10g.onnx",
    "face_emb": "w600k_r50.onnx",
    "person_det": "yolov8n.onnx",
    "person_emb": "osnet_x0_25.onnx",
}


class ModelBundle:
    """Holds the four model wrappers; person_det may be None (fallback mode)."""

    def __init__(self, face_det, face_emb, person_emb, person_det=None):
        self.face_det = face_det
        self.face_emb = face_emb
        self.person_emb = person_emb
        self.person_det = person_det
        self.version = MODEL_VERSION


_bundle: ModelBundle | None = None
_lock = threading.Lock()


def model_dir() -> str:
    return os.environ.get("MODEL_DIR", os.path.join(os.path.dirname(__file__), "..", "model_files"))


def load_bundle() -> ModelBundle:
    """Load (once) and return the process-wide bundle."""
    global _bundle
    if _bundle is not None:
        return _bundle
    with _lock:
        if _bundle is not None:
            return _bundle

        from .arcface import ArcFaceEmbedder
        from .person import PersonDetector, ReidEmbedder
        from .scrfd import ScrfdDetector

        d = model_dir()

        def _path(key: str) -> str:
            return os.path.join(d, _DEFAULT_FILES[key])

        for key in ("face_det", "face_emb", "person_emb"):
            if not os.path.exists(_path(key)):
                raise FileNotFoundError(
                    f"Required model file missing: {_path(key)} — "
                    "run scripts/fetch_models.py or set MODEL_DIR."
                )

        person_det = None
        if os.path.exists(_path("person_det")):
            person_det = PersonDetector(_path("person_det"))

        _bundle = ModelBundle(
            face_det=ScrfdDetector(_path("face_det")),
            face_emb=ArcFaceEmbedder(_path("face_emb")),
            person_emb=ReidEmbedder(_path("person_emb")),
            person_det=person_det,
        )
        return _bundle


def set_bundle(bundle: ModelBundle | None) -> None:
    """Test hook: inject a fake bundle (or None to reset)."""
    global _bundle
    _bundle = bundle
