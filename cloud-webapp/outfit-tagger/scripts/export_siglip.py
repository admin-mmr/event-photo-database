#!/usr/bin/env python3
"""
export_siglip.py — export SigLIP's two towers to ONNX and RECORD their preprocessing.

    pip install torch transformers sentencepiece onnx onnxruntime onnxscript
    python scripts/export_siglip.py --dir model_files

Writes into --dir:

    siglip_vision.onnx        vision tower  → image embedding
    siglip_text.onnx          text tower    → text embedding
    siglip_tokenizer.model    SentencePiece model
    vision_config.json        size / mean / std / rescale, from the real processor
    text_config.json          max_length / pad id / eos id / canonicalization

**Recording the config is the point, not a nicety.** The runtime
(`siglip.load_encoders`) reads these JSON files instead of hardcoding
preprocessing, because a wrong normalization constant or pad id yields
embeddings that are confidently wrong, rank badly, and raise nothing. This script
is the only place where `transformers` is available to state the truth, so it
also VERIFIES the runtime against it before declaring success:

  1. tokenizer parity — our `siglip.Tokenizer` must produce the same ids as the
     HF tokenizer on a set of probe strings;
  2. embedding parity — the ONNX towers must agree with the torch model to a
     tight cosine tolerance on the same probes.

Either check failing fails the export. A staged model that quietly disagrees with
its own runtime is exactly the failure this repo has been burned by elsewhere
(a hand-kept COPY list, a drifted deploy timeout): it looks fine until the
results are wrong.

Licensing: google/siglip-base-patch16-224 is Apache-2.0, which clears the
"permissive weights only" guardrail in PEOPLE_RECOGNITION_QUALITY_PLAN.md.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

MODEL_ID = os.environ.get("SIGLIP_MODEL_ID", "google/siglip-base-patch16-224")

# Probe strings + a probe image are used for the two parity checks. Deliberately
# includes punctuation and mixed case (to exercise canonicalization), something
# longer than a couple of tokens, and the empty-ish case.
PROBES = [
    "orange singlet",
    "Bright Orange Singlet!",
    "a runner wearing a yellow visor and pink shorts",
    "open-ear headphones",
    "x",
]
COSINE_TOLERANCE = 1e-3


def _fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="model_files", help="output directory")
    ap.add_argument("--model-id", default=MODEL_ID)
    ap.add_argument("--opset", type=int, default=17)
    args = ap.parse_args()

    try:
        import numpy as np
        import torch
        from transformers import AutoProcessor, SiglipModel
    except ImportError as exc:
        _fail(
            f"missing an export-only dependency ({exc}); "
            "pip install torch transformers sentencepiece onnx onnxruntime onnxscript"
        )

    # torch >= 2.6 routes torch.onnx.export through its dynamo exporter, which
    # imports onnxscript lazily — so a missing onnxscript fails partway through
    # the first export rather than at import time. Check it up front.
    try:
        import onnxscript  # noqa: F401
    except ImportError:
        _fail("torch.onnx.export needs onnxscript; pip install onnxscript")

    out_dir = os.path.abspath(args.dir)
    os.makedirs(out_dir, exist_ok=True)
    print(f"==> loading {args.model_id}")
    model = SiglipModel.from_pretrained(args.model_id).eval()
    processor = AutoProcessor.from_pretrained(args.model_id)
    image_processor, tokenizer = processor.image_processor, processor.tokenizer

    # ── record preprocessing, from the processor rather than from memory ──────
    # `image_processor.size` has changed shape across transformers versions: a
    # plain dict in 4.x, a `SizeDict` (attribute access, not a dict subclass) in
    # 5.x, and occasionally a bare int or a {"shortest_edge": N} form. Read it
    # tolerantly rather than pinning a version — the value is what matters, and a
    # crash here is a needless block on exporting a correct model.
    def _size_dim(size_obj, *keys) -> int | None:
        for key in keys:
            try:
                value = size_obj[key]
            except (TypeError, KeyError, IndexError):
                value = getattr(size_obj, key, None)
            if value is not None:
                return int(value)
        return None

    size = image_processor.size
    height = _size_dim(size, "height", "shortest_edge")
    width = _size_dim(size, "width", "shortest_edge")
    if height is None:
        if isinstance(size, (int, float)):
            height = width = int(size)
        else:
            _fail(f"cannot read a side length out of processor size {size!r} ({type(size).__name__})")
    if width is not None and width != height:
        _fail(f"non-square processor size {size} — the runtime assumes a square resize")
    side = int(height)
    vision_config = {
        "size": side,
        "mean": [float(v) for v in image_processor.image_mean],
        "std": [float(v) for v in image_processor.image_std],
        "rescale": float(getattr(image_processor, "rescale_factor", 1 / 255)),
        "modelId": args.model_id,
    }
    max_length = int(getattr(tokenizer, "model_max_length", 64))
    if max_length > 1024:  # HF uses a sentinel (very large int) for "unset"
        max_length = 64
    text_config = {
        "max_length": max_length,
        "pad_token_id": int(tokenizer.pad_token_id),
        "eos_token_id": int(tokenizer.eos_token_id),
        # SigLIP's tokenizer canonicalizes (lowercase + strip punctuation) inside
        # __call__; the parity check below is what actually confirms it.
        "add_eos": True,
        "canonicalize": True,
        "modelId": args.model_id,
    }

    # ── export the two towers ────────────────────────────────────────────────
    vision_path = os.path.join(out_dir, "siglip_vision.onnx")
    text_path = os.path.join(out_dir, "siglip_text.onnx")

    def pooled(out):
        """The single pooled embedding, whatever shape the API returned.

        `get_image_features` / `get_text_features` return a bare tensor in
        transformers 4.x and a `BaseModelOutputWithPooling` in 5.x. Exporting the
        object directly is NOT a harmless difference: ONNX flattens it into TWO
        graph outputs with `last_hidden_state` FIRST, so the runtime — which reads
        output[0] — would silently embed a [batch, tokens, dim] patch-token tensor
        instead of the [batch, dim] pooled vector. It raises nothing and ranks
        garbage. Take the pooled tensor explicitly.
        """
        if isinstance(out, torch.Tensor):
            return out
        pooled_output = getattr(out, "pooler_output", None)
        if pooled_output is None:
            raise RuntimeError(
                f"cannot find the pooled embedding on {type(out).__name__} "
                f"(keys: {list(out.keys()) if hasattr(out, 'keys') else '?'})"
            )
        return pooled_output

    class VisionTower(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, pixel_values):
            return pooled(self.m.get_image_features(pixel_values=pixel_values))

    class TextTower(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, input_ids):
            return pooled(self.m.get_text_features(input_ids=input_ids))

    def assert_single_embedding_output(path: str, what: str) -> None:
        """A structural guard on the exported graph: exactly ONE output, rank 2.

        The runtime reads `session.get_outputs()[0]` and flattens it. Anything
        else — a second output, or a rank-3 token tensor — means it would embed
        the wrong thing without erroring, which is how the transformers 5.x
        output-object change first slipped through here.
        """
        import onnxruntime as ort

        session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        outputs = session.get_outputs()
        if len(outputs) != 1:
            _fail(
                f"{what} exported {len(outputs)} graph outputs "
                f"({[o.name for o in outputs]}); the runtime reads only the first, "
                "so the pooled embedding must be the sole output"
            )
        if len(outputs[0].shape) != 2:
            _fail(
                f"{what} output '{outputs[0].name}' has shape {outputs[0].shape}; "
                "expected [batch, dim] — a rank-3 tensor is per-token hidden state, "
                "not the pooled embedding"
            )

    print(f"==> exporting vision tower → {vision_path}")
    dummy_pixels = torch.zeros(1, 3, side, side)
    torch.onnx.export(
        VisionTower(model),
        (dummy_pixels,),
        vision_path,
        input_names=["pixel_values"],
        output_names=["image_embeds"],
        dynamic_axes={"pixel_values": {0: "batch"}, "image_embeds": {0: "batch"}},
        opset_version=args.opset,
    )
    assert_single_embedding_output(vision_path, "vision tower")

    print(f"==> exporting text tower → {text_path}")
    dummy_ids = torch.full((1, max_length), int(tokenizer.pad_token_id), dtype=torch.long)
    torch.onnx.export(
        TextTower(model),
        (dummy_ids,),
        text_path,
        input_names=["input_ids"],
        output_names=["text_embeds"],
        dynamic_axes={"input_ids": {0: "batch"}, "text_embeds": {0: "batch"}},
        opset_version=args.opset,
    )
    assert_single_embedding_output(text_path, "text tower")

    # ── stage the SentencePiece model ────────────────────────────────────────
    spm_dest = os.path.join(out_dir, "siglip_tokenizer.model")
    spm_src = getattr(tokenizer, "vocab_file", None)
    if not spm_src or not os.path.exists(spm_src):
        saved = os.path.join(out_dir, "_tokenizer_tmp")
        tokenizer.save_pretrained(saved)
        candidates = [f for f in os.listdir(saved) if f.endswith(".model")]
        if not candidates:
            _fail(f"no SentencePiece .model found in {saved}")
        spm_src = os.path.join(saved, candidates[0])
    shutil.copyfile(spm_src, spm_dest)
    print(f"==> tokenizer → {spm_dest}")

    with open(os.path.join(out_dir, "vision_config.json"), "w", encoding="utf-8") as f:
        json.dump(vision_config, f, indent=2)
    with open(os.path.join(out_dir, "text_config.json"), "w", encoding="utf-8") as f:
        json.dump(text_config, f, indent=2)

    # ── check 1: tokenizer parity ────────────────────────────────────────────
    print("==> verifying tokenizer parity against transformers")
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import siglip as runtime  # noqa: E402  (needs the path insert above)

    ours = runtime.Tokenizer(spm_dest, text_config)
    for probe in PROBES:
        theirs = tokenizer(
            probe, padding="max_length", max_length=max_length, truncation=True
        )["input_ids"]
        mine = ours.encode(probe)[0].tolist()
        if list(theirs) != mine:
            _fail(
                "tokenizer mismatch — the runtime would embed different ids than "
                f"transformers.\n  probe: {probe!r}\n  hf:    {list(theirs)}\n  ours:  {mine}\n"
                "Fix siglip.Tokenizer/canonicalize_text (or the recorded text_config) "
                "before staging these weights."
            )
    print(f"    tokenizer parity OK on {len(PROBES)} probes")

    # ── check 2: embedding parity ────────────────────────────────────────────
    print("==> verifying ONNX/torch embedding parity")

    def cos(a, b):
        a = np.asarray(a, dtype=np.float64).reshape(-1)
        b = np.asarray(b, dtype=np.float64).reshape(-1)
        return float(a @ b / max(np.linalg.norm(a) * np.linalg.norm(b), 1e-12))

    text_encoder = runtime.TextEncoder(text_path, spm_dest, text_config)
    for probe in PROBES:
        ids = torch.from_numpy(ours.encode(probe))
        with torch.no_grad():
            expected = pooled(model.get_text_features(input_ids=ids)).numpy()
        similarity = cos(expected, text_encoder.embed(probe))
        if similarity < 1.0 - COSINE_TOLERANCE:
            _fail(f"text tower mismatch on {probe!r}: cosine {similarity:.6f} vs torch")

    rng = np.random.default_rng(0)
    probe_image = rng.integers(0, 256, size=(side + 37, side + 11, 3), dtype=np.uint8)
    vision_encoder = runtime.VisionEncoder(vision_path, vision_config)
    with torch.no_grad():
        expected = pooled(
            model.get_image_features(
                pixel_values=torch.from_numpy(vision_encoder.preprocess(probe_image))
            )
        ).numpy()
    similarity = cos(expected, vision_encoder.embed(probe_image))
    if similarity < 1.0 - COSINE_TOLERANCE:
        _fail(f"vision tower mismatch: cosine {similarity:.6f} vs torch")
    print(f"    embedding parity OK (cosine ≥ {1 - COSINE_TOLERANCE})")

    print(
        "\n==> done. Stage to GCS for deploys (one time per model change).\n"
        "    The staged path must END IN `model_files` — Cloud Build pulls it with\n"
        "    `cp -r` and the Dockerfile does `COPY model_files/`:\n"
        f"    gcloud storage cp -r {out_dir} gs://<project-id>-models/outfit/\n"
        "    then: ./infra/scripts/deploy-outfit-tagger.sh <project-id>\n"
        "NOTE: changing weights changes the embedding space — bump "
        "OUTFIT_MODEL_VERSION in siglip.py and re-run the prepare job for every "
        "prepared event, or /detect will refuse them with model_version_mismatch."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
