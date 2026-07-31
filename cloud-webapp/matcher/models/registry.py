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

The version string tags every embedding written to the store and drives the
indexer's reuse check (md5 + model_version), so it must change whenever the models
actually change (dev plan §8).

**The version is DERIVED from what loaded, never asserted.** The `@m1` bump added
a `yolov8n` token in anticipation of the person detector, but `yolov8n.onnx` was
never staged — so every event was embedded with the face-box-expansion fallback
while its manifest claimed `+yolov8n+`. All 9 events / 9,574 photos / 55,270
person crops carry that false tag, and because the tag looked right there was
nothing to notice (confirmed 2026-07-31: every event's person boxes are exactly
3.00× the face width and 7.00× its height — `expand_face_to_person`'s constants).
`model_version()` now resolves the person-detector token from the bundle that
actually loaded, so the crop geometry of a stored event is self-describing.

Consequence to be aware of: staging `yolov8n.onnx` genuinely changes person
("outfit") crops, so every event must be re-embedded when it lands. The token
change is subsumed by that re-index rather than adding to it.
"""

from __future__ import annotations

import logging
import os
import threading

log = logging.getLogger(__name__)

# An explicit override wins over everything (pinning a version for a replay, or
# forcing a re-embed); otherwise the version is composed from what loaded.
MODEL_VERSION_OVERRIDE = os.environ.get("MODEL_VERSION", "")

_VERSION_TEMPLATE = "scrfd10g+{person_det}+arcface_r50+osnet_x0_25@m1"
PERSON_DET_TOKEN = "yolov8n"      # a real person detector ran
FACE_EXPAND_TOKEN = "faceexpand"  # models.common.expand_face_to_person ran


def model_version(person_det_loaded: bool) -> str:
    """The version tag for a bundle, reflecting its person-crop geometry.

    Two distinct tags, because the two paths produce genuinely different person
    embeddings: a detector box frames the actual person, while the fallback
    multiplies the face box by a fixed 3×/7× and frames whatever happens to sit
    below the face. Tagging both `+yolov8n+` is precisely what hid the missing
    detector, so do not collapse them back into one constant.
    """
    if MODEL_VERSION_OVERRIDE:
        return MODEL_VERSION_OVERRIDE
    return _VERSION_TEMPLATE.format(
        person_det=PERSON_DET_TOKEN if person_det_loaded else FACE_EXPAND_TOKEN
    )


def _env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


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
        # Derived, not assigned from a constant — see model_version().
        self.version = model_version(person_det is not None)

    @property
    def uses_person_detector(self) -> bool:
        """False when person crops come from face-box expansion. Surfaced so a
        caller (or a log line) can state the geometry rather than infer it."""
        return self.person_det is not None


_bundle: ModelBundle | None = None
_lock = threading.Lock()


def model_dir() -> str:
    return os.environ.get("MODEL_DIR", os.path.join(os.path.dirname(__file__), "..", "model_files"))


def load_bundle(require_person_det: bool | None = None) -> ModelBundle:
    """Load (once) and return the process-wide bundle.

    `require_person_det` decides what a missing `yolov8n.onnx` means:

      * **True** — raise. Correct for the INDEXER, which writes the store: an
        index run without the detector bakes face-expanded person crops into
        every row, and discovering that later costs a full re-embed. Failing the
        job is far cheaper than a silently degraded event.
      * **False** — fall back to face-box expansion, but log an ERROR and tag the
        embeddings `+faceexpand+`. Correct for the live matcher SERVICE, where
        raising would turn a missing optional file into 500s on every Find-Me
        search.

    `None` (default) reads `REQUIRE_PERSON_DET`, defaulting to False — i.e. the
    service-safe behaviour, so no deploy can be broken by this file's absence.
    The indexer passes True explicitly.
    """
    if require_person_det is None:
        require_person_det = _env_flag("REQUIRE_PERSON_DET", False)
    global _bundle
    if _bundle is not None:
        _check_requirement(_bundle, require_person_det)
        return _bundle
    with _lock:
        if _bundle is not None:
            _check_requirement(_bundle, require_person_det)
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
        elif require_person_det:
            raise FileNotFoundError(
                f"Person detector missing: {_path('person_det')}. Without it, person "
                "('outfit') crops are a fixed 3x/7x expansion of the face box rather "
                "than real detections, and anyone whose face was not detected gets no "
                "person crop at all. Stage the model (see matcher/scripts/"
                "fetch_models.py) or set REQUIRE_PERSON_DET=0 to accept the fallback "
                "— embeddings will then be tagged "
                f"'{FACE_EXPAND_TOKEN}' instead of '{PERSON_DET_TOKEN}'."
            )
        else:
            # ERROR, not warning: this silently degraded every event for months.
            log.error(
                "person detector %s NOT FOUND — falling back to face-box expansion. "
                "Person/outfit crops will be a fixed 3x/7x expansion of the face box, "
                "back-turned people get no crop at all, and embeddings are tagged '%s'.",
                _path("person_det"),
                FACE_EXPAND_TOKEN,
            )

        _bundle = ModelBundle(
            face_det=ScrfdDetector(_path("face_det")),
            face_emb=ArcFaceEmbedder(_path("face_emb")),
            person_emb=ReidEmbedder(_path("person_emb")),
            person_det=person_det,
        )
        log.info(
            "models loaded: version=%s person_detector=%s",
            _bundle.version,
            "yes" if _bundle.uses_person_detector else "NO (face-expand fallback)",
        )
        return _bundle


def _check_requirement(bundle: ModelBundle, require_person_det: bool) -> None:
    """A cached bundle must still satisfy a caller that requires the detector.

    Without this, whichever caller loaded first would decide for everyone — so an
    indexer sharing a process with a tolerant caller could quietly write
    face-expanded crops despite asking not to.
    """
    if require_person_det and not bundle.uses_person_detector:
        raise FileNotFoundError(
            "Person detector required, but the already-loaded bundle has none "
            f"(version '{bundle.version}'). Stage yolov8n.onnx, or set "
            "REQUIRE_PERSON_DET=0 to accept face-box expansion."
        )


def set_bundle(bundle: ModelBundle | None) -> None:
    """Test hook: inject a fake bundle (or None to reset)."""
    global _bundle
    _bundle = bundle
