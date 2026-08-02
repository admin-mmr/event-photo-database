#!/usr/bin/env python3
"""
fetch_models.py — download the ONNX model files into MODEL_DIR.

Usage:
    python scripts/fetch_models.py [--dir model_files] [--skip-optional]

Sources (override with env vars if a URL moves):
  - BUFFALO_URL: insightface buffalo_l bundle (det_10g.onnx + w600k_r50.onnx
    are extracted from the zip; the other models in the zip are discarded).
  - YOLO_URL (optional): a YOLOv8n ONNX export for person detection. No
    official ONNX is hosted by ultralytics. Export it from the committed
    checkpoint with `python scripts/export_yolov8.py` — NOT a bare
    `yolo export`, which skips the contract checks (class 0 == person, output
    layout) that models/person.py depends on. Without the file the pipeline
    falls back to face-box expansion, which is how 9 events were embedded with
    the wrong geometry; the indexer now refuses to run in that state.
  - OSNET_URL: OSNet person-ReID ONNX. The torchreid model zoo publishes
    .pth weights; export with deep-person-reid's torchreid → ONNX, or point
    OSNET_URL at a trusted converted artifact.

The M0 accuracy gate (Precision@20 ≥ 0.8) must be measured with the real
models — verify checksums/sources before trusting results.
"""

from __future__ import annotations

import argparse
import io
import os
import ssl
import sys
import urllib.request
import zipfile

try:  # use certifi's CA bundle if available (fixes bare python.org installs on macOS)
    import certifi

    _SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CONTEXT = ssl.create_default_context()

BUFFALO_URL = os.environ.get(
    "BUFFALO_URL",
    "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip",
)
YOLO_URL = os.environ.get("YOLO_URL", "")    # optional, no canonical host
OSNET_URL = os.environ.get("OSNET_URL", "")  # set to your converted artifact

WANTED_FROM_BUFFALO = {"det_10g.onnx", "w600k_r50.onnx"}


def _download(url: str, label: str) -> bytes:
    print(f"Downloading {label}: {url}")
    with urllib.request.urlopen(url, context=_SSL_CONTEXT) as resp:  # noqa: S310 — trusted, user-set URLs
        return resp.read()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", default=os.environ.get("MODEL_DIR", "model_files"))
    parser.add_argument("--skip-optional", action="store_true")
    args = parser.parse_args()
    os.makedirs(args.dir, exist_ok=True)

    # buffalo_l → SCRFD + ArcFace
    missing = [n for n in WANTED_FROM_BUFFALO if not os.path.exists(os.path.join(args.dir, n))]
    if missing:
        data = _download(BUFFALO_URL, "insightface buffalo_l")
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for info in zf.infolist():
                base = os.path.basename(info.filename)
                if base in WANTED_FROM_BUFFALO:
                    with zf.open(info) as src, open(os.path.join(args.dir, base), "wb") as dst:
                        dst.write(src.read())
                    print(f"  extracted {base}")
    else:
        print("buffalo models already present")

    # OSNet (required for outfit matching)
    osnet_path = os.path.join(args.dir, "osnet_x0_25.onnx")
    if not os.path.exists(osnet_path):
        if OSNET_URL:
            with open(osnet_path, "wb") as f:
                f.write(_download(OSNET_URL, "OSNet ReID"))
        else:
            print(
                "WARNING: OSNET_URL not set and osnet_x0_25.onnx missing — "
                "outfit matching will fail. Export from torchreid and place "
                f"it at {osnet_path}.",
                file=sys.stderr,
            )

    # Person detector. "Optional" only in the sense that the pipeline still runs
    # without it — NOT in the sense that its absence is harmless. Calling it
    # optional here, next to a MODEL_VERSION that claimed `+yolov8n+` regardless,
    # is how all 9 events came to be embedded with face-box expansion unnoticed.
    yolo_path = os.path.join(args.dir, "yolov8n.onnx")
    if not args.skip_optional and not os.path.exists(yolo_path):
        if YOLO_URL:
            with open(yolo_path, "wb") as f:
                f.write(_download(YOLO_URL, "YOLOv8n person detector"))
        else:
            print(
                "WARNING: yolov8n.onnx not present. Person ('outfit') crops will be a\n"
                "  fixed 3x/7x expansion of the face box instead of real detections, and\n"
                "  anyone whose face was not detected gets NO person crop at all — so\n"
                "  back-turned and no-face shots are invisible to outfit matching.\n"
                "  Embeddings will be tagged '+faceexpand+' rather than '+yolov8n+'.\n"
                "  The indexer REFUSES to run in this state unless REQUIRE_PERSON_DET=0\n"
                "  (see matcher/models/registry.py). Verify any indexed event with\n"
                "  infra/scripts/audit-person-crops.sh.",
                file=sys.stderr,
            )

    print(f"Done. Models in {os.path.abspath(args.dir)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
