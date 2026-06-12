#!/usr/bin/env python3
"""
export_osnet.py — one-time export of osnet_x0_25 to ONNX (see fetch_models.py).

torchreid is NOT pip-installable cleanly (its setup.py imports the full
package, dragging in scipy/h5py/etc.), and we only need one self-contained
file: torchreid/models/osnet.py. So: clone the repo, load that file directly.

Prereqs (in the matcher venv):
    pip install -r requirements-export.txt
    git clone --depth 1 https://github.com/KaiyangZhou/deep-person-reid.git /tmp/deep-person-reid

Usage:
    python scripts/export_osnet.py [--repo /tmp/deep-person-reid] \
        [--out model_files/osnet_x0_25.onnx]

Builds ImageNet-pretrained osnet_x0_25 (weights fetched via gdown) and
exports with the contract models/person.py expects: 1x3x256x128 input,
512-d feature output (eval mode → features, not logits).
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys


def load_osnet_module(repo: str):
    """Import torchreid/models/osnet.py as a standalone module."""
    path = os.path.join(repo, "torchreid", "models", "osnet.py")
    if not os.path.exists(path):
        sys.exit(
            f"{path} not found — clone the repo first:\n"
            "  git clone --depth 1 https://github.com/KaiyangZhou/deep-person-reid.git /tmp/deep-person-reid"
        )
    spec = importlib.util.spec_from_file_location("osnet", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default="/tmp/deep-person-reid")
    parser.add_argument("--out", default="model_files/osnet_x0_25.onnx")
    args = parser.parse_args()

    import torch

    osnet = load_osnet_module(args.repo)
    model = osnet.osnet_x0_25(num_classes=1000, pretrained=True, loss="softmax")
    model.eval()

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    dummy = torch.randn(1, 3, 256, 128)
    torch.onnx.export(
        model,
        dummy,
        args.out,
        input_names=["input"],
        output_names=["feat"],
        opset_version=12,
        dynamic_axes={"input": {0: "batch"}, "feat": {0: "batch"}},
    )

    # sanity check: output must be (1, 512)
    import numpy as np
    import onnxruntime as ort

    sess = ort.InferenceSession(args.out, providers=["CPUExecutionProvider"])
    out = sess.run(None, {"input": np.zeros((1, 3, 256, 128), dtype=np.float32)})[0]
    assert out.shape == (1, 512), f"unexpected output shape {out.shape}"
    print(f"OK: {args.out} (output {out.shape})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
