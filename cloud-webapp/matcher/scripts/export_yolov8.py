#!/usr/bin/env python3
"""
export_yolov8.py — export the person detector to ONNX (see fetch_models.py).

    pip install ultralytics
    python scripts/export_yolov8.py [--weights yolov8n.pt] [--out model_files/yolov8n.onnx]

**Why this script exists at all.** `yolov8n.pt` has been committed since June, but
nobody ever converted it, so `yolov8n.onnx` was never staged and every event was
embedded with the `expand_face_to_person` fallback while its manifest claimed
`+yolov8n+` (9 events / 9,574 photos / 55,270 person crops — see
matcher/models/registry.py). A one-line `yolo export` in a comment was not enough;
a checked-in script that VERIFIES the result is.

Licensing: Ultralytics YOLOv8 is AGPL-3.0, and so are its pretrained weights. That
is settled for this repo — the project relicensed from MIT to AGPL-3.0 in
`8ebb394` precisely because this detector is bundled, so LICENSE and NOTICE now
agree. If you ever swap in a permissive detector (YOLOX / RTMDet / RT-DETR are
Apache-2.0), note that `models/person.py` implements only the YOLOv8 output
layout and would need a new decode path.

The export is checked against the contract `models/person.py` relies on:

  1. output is rank-3 `(1, 4 + num_classes, N)` — it transposes to `(N, 84)` and
     slices `preds[:, :4]` as cxcywh and `preds[:, 4]` as the person score;
  2. **class index 0 is `person`** — that is what makes column 4 the person
     score. A model whose class order differs would silently rank some other
     object as "person";
  3. the exported graph, driven through the real `PersonDetector`, actually finds
     the people in Ultralytics' own sample images.

Check (3) is the one that matters: it exercises letterboxing, the cxcywh→xyxy
conversion, NMS, and clamping together, which is where a subtly wrong export
shows up as plausible-but-wrong boxes rather than an error.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys

# Input size the decode path assumes (models.person.YOLO_INPUT).
YOLO_INPUT = 640
DEFAULT_OPSET = 17


def _fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default="yolov8n.pt", help="Ultralytics .pt checkpoint")
    ap.add_argument("--out", default="model_files/yolov8n.onnx")
    ap.add_argument("--opset", type=int, default=DEFAULT_OPSET)
    args = ap.parse_args()

    try:
        import numpy as np
        from ultralytics import YOLO
    except ImportError as exc:
        _fail(f"missing an export-only dependency ({exc}); pip install ultralytics")

    if not os.path.exists(args.weights):
        _fail(f"weights not found: {args.weights}")

    print(f"==> loading {args.weights}")
    model = YOLO(args.weights)
    names = model.names or {}
    if names.get(0) != "person":
        _fail(
            f"class 0 is {names.get(0)!r}, not 'person'. models/person.py reads column 4 "
            "of the prediction tensor as the person score, which is only correct when "
            "person is class 0 — a different class order would silently score the wrong object."
        )
    print(f"    task={model.task} classes={len(names)} class0={names.get(0)!r}")

    print(f"==> exporting ONNX (imgsz={YOLO_INPUT}, opset={args.opset})")
    produced = model.export(format="onnx", imgsz=YOLO_INPUT, opset=args.opset, dynamic=False)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    if os.path.abspath(produced) != os.path.abspath(args.out):
        shutil.move(produced, args.out)
    print(f"    -> {args.out}")

    # ── contract checks, through the code the indexer actually runs ──────────
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from models.person import PersonDetector  # noqa: E402

    detector = PersonDetector(args.out)
    outputs = detector.session.get_outputs()
    if len(outputs) != 1:
        _fail(f"expected 1 graph output, got {[o.name for o in outputs]}")
    shape = outputs[0].shape
    if len(shape) != 3:
        _fail(f"expected a rank-3 output (1, 4+num_classes, N), got {shape}")
    expected_channels = 4 + len(names)
    if isinstance(shape[1], int) and shape[1] != expected_channels:
        _fail(
            f"output channel dim is {shape[1]}, expected {expected_channels} "
            f"(4 bbox + {len(names)} classes). models/person.py slices [:, :4] and [:, 4]."
        )
    print(f"==> graph contract OK: output {outputs[0].name} {shape}")

    print("==> verifying detections on Ultralytics' sample images")
    try:
        import ultralytics
        from PIL import Image
    except ImportError as exc:  # pragma: no cover
        _fail(f"cannot run the detection check ({exc})")
    assets = os.path.join(os.path.dirname(ultralytics.__file__), "assets")
    probes = {"bus.jpg": 3, "zidane.jpg": 2}  # people visible at score >= 0.4
    for name, minimum in probes.items():
        path = os.path.join(assets, name)
        if not os.path.exists(path):
            print(f"    (skipping {name}: not bundled with this ultralytics build)")
            continue
        img = np.asarray(Image.open(path).convert("RGB"))
        height, width = img.shape[:2]
        dets = detector.detect(img, score_thresh=0.4)
        if len(dets) < minimum:
            _fail(
                f"{name}: found {len(dets)} people, expected >= {minimum}. The export "
                "loads but decodes wrongly — check the output layout and letterboxing."
            )
        for d in dets:
            x1, y1, x2, y2 = d["box"]
            if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
                _fail(f"{name}: box {d['box']} is out of bounds for {width}x{height}")
        print(f"    {name}: {len(dets)} people, all boxes in bounds ✓")

    size_mb = os.path.getsize(args.out) / (1024 * 1024)
    print(
        f"\n==> done ({size_mb:.1f} MB). Stage it so the indexer and matcher can load it:\n"
        f"    gcloud storage cp {args.out} gs://<project-id>-models/model_files/\n"
        "    ./infra/scripts/deploy-indexer.sh <project-id>   # bake into the image\n"
        "    ./infra/scripts/deploy-matcher.sh <project-id>\n"
        "\nNOTE: person crops genuinely change, so the version tag flips from\n"
        "'+faceexpand+' to '+yolov8n+' and EVERY event must be re-indexed\n"
        "(FORCE_REINDEX=1) — then re-prepare the outfit-tagger's events, which key\n"
        "on sourceModelVersion. Verify with infra/scripts/audit-person-crops.sh."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
