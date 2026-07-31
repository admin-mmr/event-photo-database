"""
crops.py — which regions of a photo to embed, and how to cut them.

**No detector runs here.** The boxes come from the matcher's existing
`<eventId>/embeddings/manifest.json`, which the indexer already writes: `persons`
rows carry YOLO person boxes and `faces` rows carry SCRFD face boxes. Reusing
them is what keeps this service off the Find-Me critical path — it reads one
immutable artifact, adds no detection compute, and cannot change anything the
matcher loads.

Two regions per photo, because scale decides what is even visible:

  * `person` — the person box as-is. An *outfit* (singlet, shorts, kit colour)
    fills this crop, so a whole-person crop is the right frame for it.
  * `head`   — the face box expanded to include ears, hair, and headwear. An
    accessory like open-ear headphones is a handful of pixels inside a person
    crop and contributes essentially nothing to a 224×224 embedding; cropping
    tight to the head is what gives it enough resolution to register.

Crops are cut from the **mirrored original** (`<eventId>/photos/orig/…`), not the
≤1600px `web` derivative, for two reasons: manifest boxes are in original-image
pixel coordinates and the manifest records no original dimensions, so there is no
sound way to rescale them onto a web copy; and downscaling to 1600px is precisely
what destroys the ear-region detail the `head` crop exists to capture.
"""

from __future__ import annotations

import numpy as np

# MIME → original extension the indexer wrote (`indexer/job.py` line ~456).
# **Duplicated from indexer/job.py ORIG_EXT_BY_MIME** and pinned by
# `test_crops.py::test_orig_ext_matches_indexer` — same convention as the api's
# `origExtForMime` ↔ `origExtParity.test.ts`, and for the same reason (separate
# deployables, separate Docker build contexts). Change one, change both.
ORIG_EXT_BY_MIME = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/webp": "webp",
    "image/tiff": "tif",
    "image/bmp": "bmp",
    "image/avif": "avif",
}
DEFAULT_EXT = "bin"

REGIONS = ("person", "head")

# Head crop geometry, in multiples of the face box. Wide enough to take in both
# ears (where an open-ear band sits) and biased upward so a cap, visor, or the
# top of a headband is inside the frame rather than cut off at the hairline.
HEAD_W_SCALE = 1.7
HEAD_H_SCALE = 1.7
HEAD_UP_BIAS = 0.15

# Below this, the crop's short side is so small that resizing it up to the
# encoder's 224×224 input yields interpolation artefacts rather than detail. Such
# crops are recorded with `small: true` so `/detect` can exclude them instead of
# ranking noise; they are still embedded, because "small" is a caller's judgment
# call and re-preparing an event to change the cutoff would be wasteful.
MIN_CROP_PX = 24


def orig_ext(mime_type: str | None) -> str:
    """Extension of the mirrored original for `mime_type`."""
    return ORIG_EXT_BY_MIME.get(mime_type or "", DEFAULT_EXT)


def orig_path(event_id: str, photo_id: str, mime_type: str | None) -> str:
    """Store-relative path of a photo's mirrored original."""
    return f"{event_id}/photos/orig/{photo_id}.{orig_ext(mime_type)}"


def clamp_box(box, width: int, height: int) -> list[float]:
    """Clamp [x1, y1, x2, y2] to image bounds (same semantics as the matcher's
    `models.common.clamp_box`)."""
    x1, y1, x2, y2 = box
    return [
        float(max(0.0, min(x1, width - 1))),
        float(max(0.0, min(y1, height - 1))),
        float(max(0.0, min(x2, width))),
        float(max(0.0, min(y2, height))),
    ]


def head_box(face_box, width: int, height: int) -> list[float]:
    """Expand a face box into a head crop (ears + hair + headwear).

    Grown about the face centre, then shifted up by `HEAD_UP_BIAS` face-heights.
    Clamped to the image, so a face at the frame edge yields a smaller — but
    still correctly positioned — crop rather than an out-of-bounds one.
    """
    x1, y1, x2, y2 = (float(v) for v in face_box)
    fw, fh = x2 - x1, y2 - y1
    cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0 - fh * HEAD_UP_BIAS
    half_w, half_h = fw * HEAD_W_SCALE / 2.0, fh * HEAD_H_SCALE / 2.0
    return clamp_box([cx - half_w, cy - half_h, cx + half_w, cy + half_h], width, height)


def cut(img_rgb: np.ndarray, box) -> np.ndarray:
    """Crop `box` out of an RGB array. Returns an empty array for a degenerate
    box, which callers must treat as "no crop" rather than embedding it."""
    h, w = img_rgb.shape[:2]
    x1, y1, x2, y2 = (int(round(v)) for v in clamp_box(box, w, h))
    if x2 <= x1 or y2 <= y1:
        return np.zeros((0, 0, 3), dtype=img_rgb.dtype)
    return img_rgb[y1:y2, x1:x2]


def short_side(box) -> float:
    x1, y1, x2, y2 = box
    return min(x2 - x1, y2 - y1)


def specs_for_event(manifest: dict) -> list[dict]:
    """Every crop this event should have embedded, in a deterministic order.

    Returns `[{photoId, region, box, sourceRow}]`, all `person` rows first and
    then all `head` rows, each in manifest order — so a re-prepare of an
    unchanged manifest produces byte-identical row ordering, which is what makes
    the store's rows comparable across runs.

    `box` is only the *nominal* box: `head` boxes are derived from the face box
    without knowing the image size yet, so they are recomputed (and clamped)
    per photo in `job.py` once the image is decoded.
    """
    specs: list[dict] = []
    for row, meta in enumerate(manifest.get("persons") or []):
        pid = meta.get("photoId")
        box = meta.get("box")
        if not pid or not box:
            continue
        specs.append({"photoId": str(pid), "region": "person", "box": list(box), "sourceRow": row})
    for row, meta in enumerate(manifest.get("faces") or []):
        pid = meta.get("photoId")
        box = meta.get("box")
        if not pid or not box:
            continue
        specs.append({"photoId": str(pid), "region": "head", "box": list(box), "sourceRow": row})
    return specs


def resolve_box(spec: dict, width: int, height: int) -> list[float]:
    """The actual pixel box to cut for `spec`, now that the image size is known."""
    if spec["region"] == "head":
        return head_box(spec["box"], width, height)
    return clamp_box(spec["box"], width, height)
