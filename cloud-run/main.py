"""
main.py — Cloud Run image-conversion service for MMRunners Upload Prep.

Endpoints:
  GET  /healthz   — liveness check (no auth required)
  POST /convert   — download a Drive file, convert to JPG, upload back to Drive

Auth model (recommended approach from spec §7.4):
  - Authorization: Bearer <Google ID token>   — for Cloud Run IAM verification
  - X-User-Access-Token: Bearer <OAuth token> — forwarded user token for Drive API calls

This service never stores files between requests. Every conversion uses a
temporary directory that is cleaned up in a finally block.

See UPLOAD_PREP_FEATURE_SPEC.md §6 for full specification.
"""

import io
import json
import logging
import os
import tempfile
import time
import uuid

import piexif
import rawpy
import requests
from flask import Flask, request, jsonify
from PIL import Image, ImageOps
import pillow_heif
import numpy as np

# ─── One-time Pillow setup ────────────────────────────────────────────────────

pillow_heif.register_heif_opener()
# Cap at 500 megapixels. Large RAW photos from high-end cameras top out around
# 100–150 MP; 500 MP leaves generous headroom while still guarding against
# decompression-bomb attacks and accidental OOMs from malformed input.
# Configurable via env var for future tuning without a redeploy.
Image.MAX_IMAGE_PIXELS = int(os.environ.get("MAX_IMAGE_PIXELS", 500_000_000))

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)s  %(message)s",
)
logger = logging.getLogger(__name__)

# ─── Flask app ────────────────────────────────────────────────────────────────

app = Flask(__name__)

# ─── Constants ────────────────────────────────────────────────────────────────

DRIVE_BASE = "https://www.googleapis.com/drive/v3/files"
DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3/files"

RAW_EXTENSIONS = frozenset(
    [".cr2", ".cr3", ".nef", ".arw", ".dng", ".raf", ".orf", ".rw2", ".pef", ".srw"]
)

# MIME types we can convert via Pillow (transparency-capable types get white-fill).
# Canonical source of truth for accepted upload formats is PhotoMimeType enum in
# gas-app/src/types/enums.ts — keep this list in sync when that enum changes.
# HEIC/HEIF are handled separately via pillow-heif (see HEIC_MIMES below).
PILLOW_MIMES = frozenset([
    "image/png",
    "image/webp",
    "image/tiff",
    "image/bmp",
    "image/avif",
    "image/gif",
])

HEIC_MIMES = frozenset(["image/heic", "image/heif"])

# ─── Helpers ──────────────────────────────────────────────────────────────────

def _user_token(req) -> str | None:
    """Extract the user's Drive OAuth token from X-User-Access-Token header."""
    header = req.headers.get("X-User-Access-Token", "")
    if header.startswith("Bearer "):
        return header[len("Bearer "):]
    return None if not header else header


def _drive_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _drive_get_metadata(file_id: str, token: str) -> dict:
    """Fetch file metadata from Drive. Raises on non-200."""
    url = f"{DRIVE_BASE}/{file_id}?fields=id,name,mimeType,md5Checksum,size"
    resp = requests.get(url, headers=_drive_headers(token), timeout=30)
    if resp.status_code == 401:
        raise PermissionError("unauthorized")
    if resp.status_code == 404:
        raise FileNotFoundError("source_not_found")
    resp.raise_for_status()
    return resp.json()


def _drive_download(file_id: str, token: str, dest_path: str) -> None:
    """Stream-download a Drive file to dest_path. Raises on failure."""
    url = f"{DRIVE_BASE}/{file_id}?alt=media"
    with requests.get(url, headers=_drive_headers(token), stream=True, timeout=120) as resp:
        if resp.status_code == 401:
            raise PermissionError("unauthorized")
        if resp.status_code != 200:
            raise IOError(f"download_failed: HTTP {resp.status_code}")
        with open(dest_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                f.write(chunk)


def _drive_upload(
    jpg_path: str,
    dest_folder_id: str,
    dest_name: str,
    token: str,
) -> str:
    """Multipart-upload a JPG file to Drive. Returns the new file ID."""
    metadata = json.dumps(
        {"name": dest_name, "parents": [dest_folder_id], "mimeType": "image/jpeg"}
    ).encode()

    with open(jpg_path, "rb") as f:
        jpg_bytes = f.read()

    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\n"
        f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
        + metadata.decode()
        + f"\r\n--{boundary}\r\n"
        f"Content-Type: image/jpeg\r\n\r\n"
    ).encode() + jpg_bytes + f"\r\n--{boundary}--".encode()

    headers = {
        **_drive_headers(token),
        "Content-Type": f"multipart/related; boundary={boundary}",
        "Content-Length": str(len(body)),
    }
    resp = requests.post(
        f"{DRIVE_UPLOAD_BASE}?uploadType=multipart",
        headers=headers,
        data=body,
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()["id"]


def _open_image(src_path: str, mime_type: str, file_name: str) -> Image.Image:
    """Open source image and return a Pillow Image, handling all supported formats."""
    ext = os.path.splitext(file_name)[1].lower()

    if mime_type in HEIC_MIMES:
        heif_file = pillow_heif.open_heif(src_path)
        img = heif_file.to_pillow()

    elif mime_type in PILLOW_MIMES:
        img = Image.open(src_path)
        # For animated formats, extract first frame only
        if hasattr(img, "n_frames") and img.n_frames > 1:
            img.seek(0)
        img = img.copy()  # detach from file handle

    elif ext in RAW_EXTENSIONS:
        with rawpy.imread(src_path) as raw:
            rgb = raw.postprocess(use_camera_wb=True, output_bps=8)
        img = Image.fromarray(rgb)

    else:
        raise ValueError(f"unsupported_format: {mime_type} / {ext}")

    return img


def _flatten_transparency(img: Image.Image) -> Image.Image:
    """Flatten RGBA/P transparency onto a white background before JPEG save."""
    if img.mode in ("RGBA", "LA", "PA"):
        background = Image.new("RGB", img.size, (255, 255, 255))
        if img.mode == "RGBA":
            background.paste(img, mask=img.split()[3])
        else:
            background.paste(img.convert("RGBA"), mask=img.convert("RGBA").split()[3])
        return background
    if img.mode == "P":
        img = img.convert("RGBA")
        background = Image.new("RGB", img.size, (255, 255, 255))
        background.paste(img, mask=img.split()[3])
        return background
    return img


def _extract_exif(src_path: str, img: Image.Image) -> bytes | None:
    """Try to extract EXIF bytes from the source file or Pillow image info."""
    # Try piexif first (most reliable for JPEG-origin formats)
    try:
        return piexif.load(src_path).get("Exif") and piexif.dump(piexif.load(src_path))
    except Exception:
        pass

    # Fall back to Pillow's embedded EXIF
    try:
        exif_data = img.info.get("exif")
        if exif_data and isinstance(exif_data, bytes):
            return exif_data
    except Exception:
        pass

    return None


def _bake_orientation_and_reset(img: Image.Image, exif_bytes: bytes | None) -> tuple[Image.Image, bytes | None]:
    """
    Apply EXIF orientation to pixel data, then reset the orientation tag to 1
    so downstream tools don't double-rotate.
    Returns (rotated_image, updated_exif_bytes).
    """
    # Rotate pixels to match the EXIF orientation
    img = ImageOps.exif_transpose(img)

    if exif_bytes:
        try:
            exif_dict = piexif.load(exif_bytes)
            # 0x0112 = Orientation tag in IFD0
            exif_dict["0th"][piexif.ImageIFD.Orientation] = 1
            exif_bytes = piexif.dump(exif_dict)
        except Exception:
            pass  # If EXIF manipulation fails, keep original bytes

    return img, exif_bytes


# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.route("/healthz", methods=["GET"])
def healthz():
    """Liveness probe — no auth required."""
    return jsonify({"ok": True, "version": "2026-04-23"})


@app.route("/convert", methods=["POST"])
def convert():
    """
    Convert a Drive image file to JPG and upload the result to a destination folder.

    Request body (JSON):
      sourceFileId    string   Drive file ID to convert
      destFolderId    string   Drive folder ID for the output JPG
      destName        string   Filename for the output JPG (e.g. "IMG_5001.jpg")
      jpgQuality      int      JPEG quality 1-95 (default 92)
      maxDim          int|null Max dimension in pixels (null = no resize, v1 default)
      bakeOrientation bool     Rotate pixels to upright and reset orientation tag
      preserveExif    bool     Write EXIF metadata into the output JPG

    Auth headers:
      Authorization: Bearer <Google ID token>      (Cloud Run IAM)
      X-User-Access-Token: Bearer <OAuth token>    (Drive API calls inside this service)
    """
    request_id = uuid.uuid4().hex[:8]
    start_ms = time.monotonic() * 1000

    logger.info(f"[{request_id}] POST /convert from {request.remote_addr}")

    # ── Extract Drive token ────────────────────────────────────────────────────
    token = _user_token(request)
    if not token:
        logger.warning(f"[{request_id}] Missing X-User-Access-Token")
        return jsonify({"ok": False, "error": "unauthorized", "message": "X-User-Access-Token header required"}), 401

    # ── Parse body ────────────────────────────────────────────────────────────
    body = request.get_json(silent=True) or {}
    source_file_id  = body.get("sourceFileId")
    dest_folder_id  = body.get("destFolderId")
    dest_name       = body.get("destName")
    jpg_quality     = int(body.get("jpgQuality", 92))
    max_dim         = body.get("maxDim")          # None in v1
    bake_orientation= bool(body.get("bakeOrientation", True))
    preserve_exif   = bool(body.get("preserveExif", True))

    if not source_file_id or not dest_folder_id or not dest_name:
        return jsonify({"ok": False, "error": "internal", "message": "sourceFileId, destFolderId, destName are required"}), 400

    with tempfile.TemporaryDirectory() as tmp_dir:
        try:
            # ── 1. Fetch metadata ──────────────────────────────────────────────
            try:
                meta = _drive_get_metadata(source_file_id, token)
            except PermissionError:
                return jsonify({"ok": False, "error": "unauthorized", "message": "Drive token does not have access to this file"}), 401
            except FileNotFoundError:
                return jsonify({"ok": False, "error": "source_not_found", "message": f"File {source_file_id} not found in Drive"}), 404

            mime_type  = meta.get("mimeType", "")
            file_name  = meta.get("name", "")

            logger.info(f"[{request_id}] source={source_file_id} mime={mime_type} name={file_name}")

            # Apps Script should copy JPEGs directly; refuse conversion here
            if mime_type == "image/jpeg":
                return jsonify({
                    "ok": False,
                    "error": "unsupported_format",
                    "message": "JPEG files should be copied directly by Apps Script, not converted via Cloud Run.",
                }), 400

            # ── 2. Download source file ────────────────────────────────────────
            src_path = os.path.join(tmp_dir, "source" + os.path.splitext(file_name)[1])
            try:
                _drive_download(source_file_id, token, src_path)
            except PermissionError:
                return jsonify({"ok": False, "error": "unauthorized", "message": "Drive token cannot download this file"}), 401
            except IOError as e:
                return jsonify({"ok": False, "error": "download_failed", "message": str(e)}), 502

            # ── 3. Open image ──────────────────────────────────────────────────
            try:
                img = _open_image(src_path, mime_type, file_name)
            except ValueError as e:
                return jsonify({"ok": False, "error": "unsupported_format", "message": str(e)}), 400

            # ── 4. EXIF handling ───────────────────────────────────────────────
            exif_bytes: bytes | None = None
            if preserve_exif:
                exif_bytes = _extract_exif(src_path, img)

            if bake_orientation:
                img, exif_bytes = _bake_orientation_and_reset(img, exif_bytes)

            # ── 5. Flatten transparency (PNG, WEBP with alpha, etc.) ───────────
            img = _flatten_transparency(img)

            # ── 6. Optional resize (v1: maxDim is always None) ─────────────────
            if max_dim:
                img.thumbnail((max_dim, max_dim), Image.LANCZOS)

            # ── 7. Save as JPG ─────────────────────────────────────────────────
            out_path = os.path.join(tmp_dir, dest_name)
            save_kwargs: dict = {"quality": jpg_quality, "optimize": True}
            rgb_img = img.convert("RGB")

            if preserve_exif and exif_bytes:
                try:
                    save_kwargs["exif"] = exif_bytes
                    rgb_img.save(out_path, "JPEG", **save_kwargs)
                except Exception:
                    # If EXIF bytes are malformed, save without them
                    save_kwargs.pop("exif", None)
                    rgb_img.save(out_path, "JPEG", **save_kwargs)
            else:
                rgb_img.save(out_path, "JPEG", **save_kwargs)

            dest_size = os.path.getsize(out_path)

            # ── 8. Upload result to Drive ──────────────────────────────────────
            try:
                dest_file_id = _drive_upload(out_path, dest_folder_id, dest_name, token)
            except Exception as e:
                logger.exception(f"[{request_id}] Upload failed")
                return jsonify({"ok": False, "error": "upload_failed", "message": str(e)}), 502

            elapsed_ms = int(time.monotonic() * 1000 - start_ms)
            logger.info(
                f"[{request_id}] done  destFileId={dest_file_id}  "
                f"destSize={dest_size}  elapsed={elapsed_ms}ms  result=ok"
            )

            return jsonify({
                "ok": True,
                "destFileId": dest_file_id,
                "destSizeBytes": dest_size,
                "sourceMimeType": mime_type,
                "conversionMs": elapsed_ms,
            })

        except Exception as e:
            elapsed_ms = int(time.monotonic() * 1000 - start_ms)
            logger.exception(
                f"[{request_id}] Unhandled exception after {elapsed_ms}ms"
            )
            return jsonify({
                "ok": False,
                "error": "conversion_failed",
                "message": str(e),
            }), 500


# ─── Entrypoint ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)
