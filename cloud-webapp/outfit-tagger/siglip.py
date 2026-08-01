"""
siglip.py — SigLIP ONNX image + text encoders (the joint embedding space).

Two towers, one space: an image crop and a text description both become unit
vectors that can be compared with a dot product. That is what lets `/detect`
take *samples* and a *description* as two forms of the same query.

    VisionEncoder.embed(crop_rgb) -> float32 (dim,), L2-normalized
    TextEncoder.embed("orange singlet")  -> float32 (dim,), L2-normalized

**Preprocessing is read from JSON written at export time, not hardcoded here.**
`scripts/export_siglip.py` runs with `transformers` available and dumps the
processor's real values into `vision_config.json` / `text_config.json` beside the
.onnx files. Guessing these at runtime is the classic way to ship a model that
loads fine and embeds subtly wrong — a wrong normalization or a wrong pad id
degrades silently into bad rankings, with no error to notice. The defaults below
are only a documented fallback for a local smoke run, and `load_encoders`
logs loudly when it uses them.

SigLIP's own `logit_scale`/`logit_bias` (its sigmoid-loss calibration) are
deliberately ignored: they turn a cosine into a probability, and we only ever
*rank* by cosine. Cross-modality score comparability is handled in `main.py` by
z-scoring each modality against the event cohort instead — see `fuse_scores`.

Licensing: SigLIP weights (google/siglip-base-patch16-224) are Apache-2.0, which
clears the plan's "permissive weights only" guardrail. CLIP ViT-B/32 (MIT) is a
drop-in alternative — both towers are just ONNX files with a recorded config.
"""

from __future__ import annotations

import json
import logging
import os
import string
import threading

import numpy as np

log = logging.getLogger(__name__)

VISION_FILE = "siglip_vision.onnx"
TEXT_FILE = "siglip_text.onnx"
TOKENIZER_FILE = "siglip_tokenizer.model"
VISION_CONFIG = "vision_config.json"
TEXT_CONFIG = "text_config.json"

MODEL_VERSION = os.environ.get("OUTFIT_MODEL_VERSION", "siglip_base_patch16_224@o1")

# Fallback preprocessing — the documented SigLIP base defaults. Used ONLY when
# the export script's config JSON is missing (see module docstring).
_VISION_FALLBACK = {
    "size": 224,
    "mean": [0.5, 0.5, 0.5],
    "std": [0.5, 0.5, 0.5],
    "rescale": 1.0 / 255.0,
}
_TEXT_FALLBACK = {
    "max_length": 64,
    "pad_token_id": 1,
    "eos_token_id": 1,
    "add_eos": True,
    "canonicalize": True,
}


def l2_normalize(v: np.ndarray, eps: float = 1e-12) -> np.ndarray:
    """L2-normalize a 1-D vector (safe for the zero vector)."""
    return v / max(float(np.linalg.norm(v)), eps)


def _read_config(path: str, fallback: dict, what: str) -> dict:
    if not os.path.exists(path):
        log.warning(
            "%s config %s missing — falling back to documented SigLIP defaults. "
            "Re-run scripts/export_siglip.py so preprocessing is recorded from the "
            "real processor; a mismatch here degrades ranking silently.",
            what,
            path,
        )
        return dict(fallback)
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    return {**fallback, **cfg}


class VisionEncoder:
    """SigLIP vision tower. embed(crop_rgb) → unit vector."""

    def __init__(self, model_path: str, config: dict):
        import onnxruntime as ort

        self.session = ort.InferenceSession(
            model_path, providers=["CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name
        self.dim = int(self.session.get_outputs()[0].shape[-1])
        self.size = int(config["size"])
        self.mean = np.asarray(config["mean"], dtype=np.float32)
        self.std = np.asarray(config["std"], dtype=np.float32)
        self.rescale = float(config["rescale"])

    def preprocess(self, crop_rgb: np.ndarray) -> np.ndarray:
        """RGB uint8 (H, W, 3) → NCHW float32 batch of 1.

        A plain square resize, matching `SiglipImageProcessor` — NOT the
        letterbox the detectors use. Letterboxing a crop would pad it with black
        bars, and unlike a detector (which is trained on padded canvases) the
        vision tower reads those bars as image content.
        """
        import cv2

        resized = cv2.resize(
            crop_rgb, (self.size, self.size), interpolation=cv2.INTER_CUBIC
        )
        blob = resized.astype(np.float32) * self.rescale
        blob = (blob - self.mean) / self.std
        return blob.transpose(2, 0, 1)[None]

    def embed(self, crop_rgb: np.ndarray) -> np.ndarray:
        out = self.session.run(None, {self.input_name: self.preprocess(crop_rgb)})[0]
        return l2_normalize(out.reshape(-1).astype(np.float32))


class Tokenizer:
    """SigLIP's SentencePiece tokenization, standalone (no ONNX session).

    Separate from `TextEncoder` so `scripts/export_siglip.py` can verify it
    against the real `transformers` tokenizer at export time — the one place where
    both are available. That check is the actual guard against the silent-wrongness
    risk in this module's docstring: a wrong pad id or a missing canonicalization
    step produces embeddings that are confidently wrong and raise nothing.
    """

    def __init__(self, tokenizer_path: str, config: dict):
        import sentencepiece as spm

        self.sp = spm.SentencePieceProcessor(model_file=tokenizer_path)
        self.max_length = int(config["max_length"])
        self.pad_token_id = int(config["pad_token_id"])
        self.eos_token_id = int(config["eos_token_id"])
        self.add_eos = bool(config["add_eos"])
        self.canonicalize = bool(config["canonicalize"])

    def encode(self, text: str) -> np.ndarray:
        """Text → int64 (1, max_length) token ids, padded to a fixed length.

        SigLIP canonicalizes first (lowercase, punctuation stripped, whitespace
        collapsed) and pads to a FIXED `max_length` rather than to the longest
        item in a batch — the exported graph has a static sequence length, so a
        shorter tensor is a shape error and a longer one is silently truncated.
        """
        ids = list(self.sp.encode(canonicalize_text(text) if self.canonicalize else text))
        if self.add_eos:
            ids = ids[: self.max_length - 1] + [self.eos_token_id]
        else:
            ids = ids[: self.max_length]
        ids = ids + [self.pad_token_id] * (self.max_length - len(ids))
        return np.asarray([ids], dtype=np.int64)


class TextEncoder:
    """SigLIP text tower + its tokenizer. embed(str) → unit vector."""

    def __init__(self, model_path: str, tokenizer_path: str, config: dict):
        import onnxruntime as ort

        self.session = ort.InferenceSession(
            model_path, providers=["CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name
        self.dim = int(self.session.get_outputs()[0].shape[-1])
        self.tokenizer = Tokenizer(tokenizer_path, config)

    def embed(self, text: str) -> np.ndarray:
        out = self.session.run(None, {self.input_name: self.tokenizer.encode(text)})[0]
        return l2_normalize(out.reshape(-1).astype(np.float32))


def canonicalize_text(text: str) -> str:
    """SigLIP's text canonicalization: lowercase, drop punctuation, collapse
    whitespace. Applied before tokenizing so "Orange Singlet!" and
    "orange singlet" produce the same ids."""
    lowered = text.lower().translate(str.maketrans("", "", string.punctuation))
    return " ".join(lowered.split())


class EncoderBundle:
    """The vision tower, the (optional) text tower, and the version tag.

    `text` is None when the text tower was not staged. A samples-only query still
    works in that case, so a missing text tower degrades the service to
    image-query-only rather than failing every request — the same
    "absent ≠ broken" posture the matcher takes with its optional person
    detector.
    """

    def __init__(self, vision: VisionEncoder, text: TextEncoder | None):
        self.vision = vision
        self.text = text
        self.version = MODEL_VERSION
        self.dim = vision.dim
        if text is not None and text.dim != vision.dim:
            raise ValueError(
                f"tower dim mismatch: vision {vision.dim} vs text {text.dim} — "
                "the two .onnx files are from different exports"
            )


_bundle: EncoderBundle | None = None
_lock = threading.Lock()


def model_dir() -> str:
    return os.environ.get(
        "MODEL_DIR", os.path.join(os.path.dirname(__file__), "model_files")
    )


def load_encoders() -> EncoderBundle:
    """Load (once) and return the process-wide encoder bundle.

    Lazy + cached like the matcher's `load_bundle`: a Cloud Run instance pays the
    model load once, and `/healthz` never triggers it so a cold instance can
    still answer a health probe fast.
    """
    global _bundle
    if _bundle is not None:
        return _bundle
    with _lock:
        if _bundle is not None:
            return _bundle
        d = model_dir()
        vision_path = os.path.join(d, VISION_FILE)
        if not os.path.exists(vision_path):
            raise FileNotFoundError(
                f"Required model file missing: {vision_path} — "
                "run scripts/export_siglip.py or set MODEL_DIR."
            )
        vision = VisionEncoder(
            vision_path,
            _read_config(os.path.join(d, VISION_CONFIG), _VISION_FALLBACK, "vision"),
        )
        text = None
        text_path = os.path.join(d, TEXT_FILE)
        tok_path = os.path.join(d, TOKENIZER_FILE)
        if os.path.exists(text_path) and os.path.exists(tok_path):
            text = TextEncoder(
                text_path,
                tok_path,
                _read_config(os.path.join(d, TEXT_CONFIG), _TEXT_FALLBACK, "text"),
            )
        else:
            log.warning(
                "text tower not staged (%s / %s) — text descriptions will be "
                "rejected; sample-image queries still work",
                text_path,
                tok_path,
            )
        _bundle = EncoderBundle(vision=vision, text=text)
        return _bundle


def set_bundle(bundle: EncoderBundle | None) -> None:
    """Test hook: inject a fake bundle (or None to reset)."""
    global _bundle
    _bundle = bundle
