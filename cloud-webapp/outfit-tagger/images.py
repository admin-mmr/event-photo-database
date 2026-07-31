"""
images.py — decode bytes to an RGB array.

Deliberately a local copy of the two lines that matter from
`matcher/pipeline.decode_image` rather than an import: this service has its own
Docker build context and shares no Python with the matcher, which is what keeps a
change there from being able to break Find-Me's neighbour. The decompression-bomb
cap and the EXIF-orientation transpose are the parts that must not drift — a
photo decoded without `exif_transpose` is rotated relative to the boxes the
indexer produced, which would quietly crop the wrong region.
"""

from __future__ import annotations

import io

import numpy as np

MAX_IMAGE_PIXELS = 500_000_000  # decompression-bomb guard (same as matcher/pipeline.py)

_HEIF_REGISTERED = False


def _register_heif() -> None:
    global _HEIF_REGISTERED
    if _HEIF_REGISTERED:
        return
    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
    except ImportError:
        pass
    _HEIF_REGISTERED = True


def decode_image(data: bytes) -> np.ndarray:
    """Decode image bytes → RGB uint8 (H, W, 3). EXIF orientation is baked in.
    HEIC/HEIF supported when pillow-heif is installed."""
    from PIL import Image, ImageOps

    _register_heif()
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)
    return np.asarray(img.convert("RGB"))
