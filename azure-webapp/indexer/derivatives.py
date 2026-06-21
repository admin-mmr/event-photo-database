"""
derivatives.py — serving copies (web + thumb JPEGs) from an original image.

Reuses the conversion conventions from cloud-run/main.py: EXIF orientation
baked in, HEIC via pillow-heif, decompression-bomb guard.
"""

from __future__ import annotations

import io

WEB_MAX_PX = 1600
THUMB_MAX_PX = 320
WEB_QUALITY = 85
THUMB_QUALITY = 80
MAX_IMAGE_PIXELS = 500_000_000  # same guard as cloud-run/main.py + matcher


def _open_rgb(data: bytes):
    from PIL import Image, ImageOps

    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
    except ImportError:
        pass
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)
    return img.convert("RGB")


def _resize_jpeg(img, max_px: int, quality: int) -> bytes:
    from PIL import Image

    w, h = img.size
    scale = max_px / max(w, h)
    if scale < 1.0:
        img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def make_derivatives(data: bytes) -> dict[str, bytes]:
    """original bytes → {"web": jpeg, "thumb": jpeg}. Raises on undecodable input."""
    img = _open_rgb(data)
    return {
        "web": _resize_jpeg(img, WEB_MAX_PX, WEB_QUALITY),
        "thumb": _resize_jpeg(img.copy(), THUMB_MAX_PX, THUMB_QUALITY),
    }
