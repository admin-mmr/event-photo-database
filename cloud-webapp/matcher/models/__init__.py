from .registry import (
    FACE_EXPAND_TOKEN,
    PERSON_DET_TOKEN,
    ModelBundle,
    load_bundle,
    model_version,
    set_bundle,
)

# `MODEL_VERSION` is deliberately NOT exported any more: the version depends on
# whether the person detector actually loaded, so a module-level constant could
# only ever be a guess — and the guess it made (`+yolov8n+` regardless) is what
# mislabelled every stored event. Use `model_version(person_det_loaded)`, or read
# `bundle.version`.
__all__ = [
    "FACE_EXPAND_TOKEN",
    "PERSON_DET_TOKEN",
    "ModelBundle",
    "load_bundle",
    "model_version",
    "set_bundle",
]
