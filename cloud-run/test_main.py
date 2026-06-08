"""
test_main.py — Thorough test suite for the Cloud Run image-conversion service.

Run from the cloud-run/ directory:

    pip install -r requirements.txt pytest
    pytest -v

The suite is organized in three layers:

  1. Pure-helper unit tests (no network): _user_token, _drive_headers,
     _open_image, _flatten_transparency, _extract_exif,
     _bake_orientation_and_reset.

  2. Endpoint tests for /healthz and /convert. These drive the *real*
     conversion pipeline end-to-end but stub the three Drive I/O helpers
     (_drive_get_metadata, _drive_download, _drive_upload) so no network
     access is required. The stub for _drive_download writes a freshly
     generated image to the temp path so the genuine Pillow code runs.

  3. Format-matrix tests that confirm every accepted input MIME/extension
     in PILLOW_MIMES / HEIC_MIMES / RAW_EXTENSIONS flows through /convert
     and yields a valid JPEG. Inputs whose encoders are not present in the
     test environment (AVIF, HEIC) are skipped rather than failed.

Design note: stubbing the three Drive helpers (rather than the lower-level
`requests` calls) keeps the tests focused on conversion behaviour while still
exercising _open_image, transparency flattening, orientation baking, resizing,
EXIF handling and JPEG encoding for real.
"""

import io
import json
import os

import numpy as np
import piexif
import pytest
from PIL import Image, ImageOps

import main


# ──────────────────────────────────────────────────────────────────────────────
# Capability probes — some encoders may be absent in a given environment.
# ──────────────────────────────────────────────────────────────────────────────

def _can_encode(fmt: str, **save_kwargs) -> bool:
    """Return True if Pillow (plus registered openers) can encode `fmt` here."""
    buf = io.BytesIO()
    try:
        Image.new("RGB", (8, 8), (10, 20, 30)).save(buf, fmt, **save_kwargs)
        return buf.tell() > 0
    except Exception:
        return False


HAS_WEBP = _can_encode("WEBP")
HAS_TIFF = _can_encode("TIFF")
HAS_GIF = _can_encode("GIF")
HAS_BMP = _can_encode("BMP")
HAS_HEIF = _can_encode("HEIF")   # provided by pillow_heif's registered opener
HAS_AVIF = _can_encode("AVIF")   # provided by pillow_heif's registered opener


# ──────────────────────────────────────────────────────────────────────────────
# Image-generation helpers
# ──────────────────────────────────────────────────────────────────────────────

def _rgb_image(size=(32, 24), color=(123, 45, 67)) -> Image.Image:
    return Image.new("RGB", size, color)


def _rgba_image(size=(32, 24)) -> Image.Image:
    """An RGBA image: left half opaque red, right half fully transparent."""
    img = Image.new("RGBA", size, (255, 0, 0, 255))
    w, h = size
    for x in range(w // 2, w):
        for y in range(h):
            img.putpixel((x, y), (0, 0, 0, 0))
    return img


def _palette_image_with_transparency(size=(16, 16)) -> Image.Image:
    """A mode 'P' image with a designated transparent palette index."""
    img = Image.new("P", size)
    # palette index 0 = red, index 1 = green
    palette = [255, 0, 0] + [0, 255, 0] + [0, 0, 0] * 254
    img.putpalette(palette)
    # left column index 0, rest index 1
    for x in range(size[0]):
        for y in range(size[1]):
            img.putpixel((x, y), 0 if x < size[0] // 2 else 1)
    img.info["transparency"] = 0
    return img


def _bytes_for(fmt: str, img: Image.Image | None = None, **save_kwargs) -> bytes:
    img = img if img is not None else _rgb_image()
    buf = io.BytesIO()
    img.save(buf, fmt, **save_kwargs)
    return buf.getvalue()


def _exif_bytes(orientation: int = 1, rich: bool = True) -> bytes:
    """
    Build EXIF bytes carrying a given Orientation tag.

    By default (`rich=True`) the Exif sub-IFD is also populated, mirroring a
    real camera photo. This matters because main._extract_exif only returns
    bytes when the "Exif" sub-IFD is non-empty (see the documented xfail
    regression test test_extract_exif_orientation_only_is_dropped).
    """
    exif_dict = {
        "0th": {piexif.ImageIFD.Orientation: orientation, piexif.ImageIFD.Make: b"TestCam"},
        "Exif": {piexif.ExifIFD.DateTimeOriginal: b"2026:01:01 12:00:00"} if rich else {},
        "1st": {}, "GPS": {}, "Interop": {},
    }
    return piexif.dump(exif_dict)


# ──────────────────────────────────────────────────────────────────────────────
# Fixtures
# ──────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def client():
    main.app.config.update(TESTING=True)
    return main.app.test_client()


class DriveStub:
    """
    Captures Drive interactions and feeds a generated source image into the
    pipeline. Install it via the `drive` fixture, then configure `.source_bytes`,
    `.mime_type`, `.file_name` per test.
    """

    def __init__(self):
        self.mime_type = "image/png"
        self.file_name = "source.png"
        self.source_bytes = _bytes_for("PNG")
        self.size = len(self.source_bytes)
        self.md5 = "deadbeef"
        # populated after a /convert call:
        self.uploaded_path = None
        self.uploaded_folder = None
        self.uploaded_name = None
        self.uploaded_bytes = None
        # error injection hooks (set to an Exception instance to raise):
        self.metadata_error = None
        self.download_error = None
        self.upload_error = None

    # --- stubs matching main's helper signatures ---
    def get_metadata(self, file_id, token):
        if self.metadata_error:
            raise self.metadata_error
        return {
            "id": file_id,
            "name": self.file_name,
            "mimeType": self.mime_type,
            "md5Checksum": self.md5,
            "size": str(self.size),
        }

    def download(self, file_id, token, dest_path):
        if self.download_error:
            raise self.download_error
        with open(dest_path, "wb") as f:
            f.write(self.source_bytes)

    def upload(self, jpg_path, dest_folder_id, dest_name, token):
        if self.upload_error:
            raise self.upload_error
        self.uploaded_path = jpg_path
        self.uploaded_folder = dest_folder_id
        self.uploaded_name = dest_name
        with open(jpg_path, "rb") as f:
            self.uploaded_bytes = f.read()
        return "uploaded-file-id-123"


@pytest.fixture
def drive(monkeypatch):
    stub = DriveStub()
    monkeypatch.setattr(main, "_drive_get_metadata", stub.get_metadata)
    monkeypatch.setattr(main, "_drive_download", stub.download)
    monkeypatch.setattr(main, "_drive_upload", stub.upload)
    return stub


def _post_convert(client, body, token="user-oauth-token"):
    headers = {}
    if token is not None:
        headers["X-User-Access-Token"] = f"Bearer {token}"
    return client.post("/convert", json=body, headers=headers)


def _default_body(**overrides):
    body = {
        "sourceFileId": "src-file-id",
        "destFolderId": "dest-folder-id",
        "destName": "OUTPUT.jpg",
    }
    body.update(overrides)
    return body


# ══════════════════════════════════════════════════════════════════════════════
# 1. Helper: _user_token
# ══════════════════════════════════════════════════════════════════════════════

class _FakeReq:
    def __init__(self, headers):
        self.headers = headers


@pytest.mark.parametrize("header_value,expected", [
    ("Bearer abc123", "abc123"),
    ("abc123", "abc123"),          # raw token without scheme is accepted
    ("Bearer ", ""),               # "Bearer " with empty token → "" after strip
    ("", None),                    # empty header → None
])
def test_user_token_variants(header_value, expected):
    req = _FakeReq({"X-User-Access-Token": header_value})
    assert main._user_token(req) == expected


def test_user_token_missing_header():
    req = _FakeReq({})
    assert main._user_token(req) is None


def test_drive_headers():
    assert main._drive_headers("tok") == {"Authorization": "Bearer tok"}


# ══════════════════════════════════════════════════════════════════════════════
# 2. Helper: _open_image
# ══════════════════════════════════════════════════════════════════════════════

def test_open_png(tmp_path):
    p = tmp_path / "a.png"
    p.write_bytes(_bytes_for("PNG", _rgba_image()))
    img = main._open_image(str(p), "image/png", "a.png")
    assert img.size == (32, 24)


@pytest.mark.skipif(not HAS_WEBP, reason="WEBP encoder not available")
def test_open_webp(tmp_path):
    p = tmp_path / "a.webp"
    p.write_bytes(_bytes_for("WEBP", _rgb_image()))
    img = main._open_image(str(p), "image/webp", "a.webp")
    assert img.size == (32, 24)


@pytest.mark.skipif(not HAS_BMP, reason="BMP encoder not available")
def test_open_bmp(tmp_path):
    p = tmp_path / "a.bmp"
    p.write_bytes(_bytes_for("BMP", _rgb_image()))
    img = main._open_image(str(p), "image/bmp", "a.bmp")
    assert img.size == (32, 24)


@pytest.mark.skipif(not HAS_TIFF, reason="TIFF encoder not available")
def test_open_tiff(tmp_path):
    p = tmp_path / "a.tiff"
    p.write_bytes(_bytes_for("TIFF", _rgb_image()))
    img = main._open_image(str(p), "image/tiff", "a.tiff")
    assert img.size == (32, 24)


@pytest.mark.skipif(not HAS_GIF, reason="GIF encoder not available")
def test_open_animated_gif_takes_first_frame(tmp_path):
    """A multi-frame GIF should yield only the first frame."""
    frames = [
        Image.new("P", (20, 10), 0),
        Image.new("P", (20, 10), 1),
        Image.new("P", (20, 10), 2),
    ]
    p = tmp_path / "anim.gif"
    frames[0].save(str(p), "GIF", save_all=True, append_images=frames[1:], duration=100, loop=0)
    img = main._open_image(str(p), "image/gif", "anim.gif")
    assert img.size == (20, 10)
    # The returned image is detached (copied) from the file handle:
    assert not getattr(img, "fp", None)


@pytest.mark.skipif(not HAS_HEIF, reason="HEIF encoder not available in this environment")
def test_open_heic(tmp_path):
    p = tmp_path / "a.heic"
    _rgb_image().save(str(p), "HEIF")
    img = main._open_image(str(p), "image/heic", "a.heic")
    assert img.size == (32, 24)


def test_open_raw_via_monkeypatched_rawpy(tmp_path, monkeypatch):
    """RAW files are routed by extension through rawpy.postprocess → Image.fromarray."""
    class FakeRaw:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def postprocess(self, **kwargs):
            assert kwargs.get("use_camera_wb") is True
            assert kwargs.get("output_bps") == 8
            return np.zeros((12, 18, 3), dtype=np.uint8)  # (h, w, 3)

    monkeypatch.setattr(main.rawpy, "imread", lambda path: FakeRaw())
    p = tmp_path / "shot.dng"
    p.write_bytes(b"not-a-real-raw-but-rawpy-is-stubbed")
    img = main._open_image(str(p), "image/x-adobe-dng", "shot.dng")
    assert img.size == (18, 12)  # PIL size is (w, h)


def test_open_unsupported_format_raises(tmp_path):
    p = tmp_path / "weird.xyz"
    p.write_bytes(b"garbage")
    with pytest.raises(ValueError, match="unsupported_format"):
        main._open_image(str(p), "application/octet-stream", "weird.xyz")


# ══════════════════════════════════════════════════════════════════════════════
# 3. Helper: _flatten_transparency
# ══════════════════════════════════════════════════════════════════════════════

def test_flatten_rgba_to_white():
    img = _rgba_image((32, 24))
    flat = main._flatten_transparency(img)
    assert flat.mode == "RGB"
    # transparent right half should now be white
    assert flat.getpixel((30, 12)) == (255, 255, 255)
    # opaque left half stays red
    assert flat.getpixel((2, 12)) == (255, 0, 0)


def test_flatten_la_mode():
    base = Image.new("LA", (16, 16))
    # left fully opaque grey 100, right fully transparent
    for x in range(16):
        for y in range(16):
            base.putpixel((x, y), (100, 255 if x < 8 else 0))
    flat = main._flatten_transparency(base)
    assert flat.mode == "RGB"
    # transparent region flattened to white
    assert flat.getpixel((15, 8)) == (255, 255, 255)


def test_flatten_palette_with_transparency():
    img = _palette_image_with_transparency((16, 16))
    flat = main._flatten_transparency(img)
    assert flat.mode == "RGB"
    # transparent (index 0) region becomes white
    assert flat.getpixel((1, 8)) == (255, 255, 255)


def test_flatten_rgb_passthrough_unchanged():
    img = _rgb_image((10, 10), (5, 6, 7))
    flat = main._flatten_transparency(img)
    assert flat.mode == "RGB"
    assert flat.getpixel((5, 5)) == (5, 6, 7)
    assert flat is img  # no copy made for already-opaque RGB


# ══════════════════════════════════════════════════════════════════════════════
# 4. Helper: _extract_exif
# ══════════════════════════════════════════════════════════════════════════════

def test_extract_exif_from_jpeg(tmp_path):
    p = tmp_path / "with_exif.jpg"
    _rgb_image().save(str(p), "JPEG", exif=_exif_bytes(orientation=6))
    img = Image.open(str(p))
    exif = main._extract_exif(str(p), img)
    assert exif is not None
    loaded = piexif.load(exif)
    assert loaded["0th"][piexif.ImageIFD.Orientation] == 6


@pytest.mark.xfail(
    reason="KNOWN BUG: _extract_exif returns the empty dict {} (not bytes/None) when the "
           "source's Exif sub-IFD is empty — e.g. an image carrying only an orientation "
           "tag. Downstream `if exif_bytes:` then treats {} as falsy and silently drops "
           "ALL EXIF, including the orientation reset. Remove this xfail once "
           "_extract_exif is fixed to return bytes whenever any IFD has data.",
    strict=True,
)
def test_extract_exif_orientation_only_is_dropped(tmp_path):
    p = tmp_path / "orient_only.jpg"
    _rgb_image().save(str(p), "JPEG", exif=_exif_bytes(orientation=6, rich=False))
    img = Image.open(str(p))
    exif = main._extract_exif(str(p), img)
    # Correct behaviour would be to return EXIF bytes preserving orientation 6.
    assert isinstance(exif, (bytes, type(None)))
    if exif:
        assert piexif.load(exif)["0th"][piexif.ImageIFD.Orientation] == 6


def test_extract_exif_none_when_absent(tmp_path):
    p = tmp_path / "no_exif.png"
    _rgb_image().save(str(p), "PNG")
    img = Image.open(str(p))
    assert main._extract_exif(str(p), img) is None


def test_extract_exif_pillow_info_fallback(tmp_path, monkeypatch):
    """If piexif can't parse the file, fall back to img.info['exif']."""
    p = tmp_path / "src.png"
    _rgb_image().save(str(p), "PNG")
    # Force piexif.load to fail so the fallback branch is exercised.
    monkeypatch.setattr(main.piexif, "load", lambda *_a, **_k: (_ for _ in ()).throw(ValueError("boom")))
    sentinel = _exif_bytes(orientation=3)
    img = Image.open(str(p))
    img.info["exif"] = sentinel
    assert main._extract_exif(str(p), img) == sentinel


# ══════════════════════════════════════════════════════════════════════════════
# 5. Helper: _bake_orientation_and_reset
# ══════════════════════════════════════════════════════════════════════════════

def test_bake_orientation_resets_tag_to_one():
    exif_in = _exif_bytes(orientation=6)
    img = _rgb_image((40, 20))
    _, exif_out = main._bake_orientation_and_reset(img, exif_in)
    assert exif_out is not None
    assert piexif.load(exif_out)["0th"][piexif.ImageIFD.Orientation] == 1


def test_bake_orientation_transposes_pixels():
    """Orientation 6 implies a 90° rotation → width/height swap."""
    img = _rgb_image((40, 20))
    img.info["exif"] = _exif_bytes(orientation=6)
    rotated, _ = main._bake_orientation_and_reset(img, img.info["exif"])
    assert rotated.size == (20, 40)


def test_bake_orientation_handles_none_exif():
    img = _rgb_image((40, 20))  # no embedded exif → no rotation
    rotated, exif_out = main._bake_orientation_and_reset(img, None)
    assert exif_out is None
    assert rotated.size == (40, 20)


def test_bake_orientation_keeps_bytes_on_malformed_exif():
    bad = b"not-valid-exif"
    img = _rgb_image((10, 10))
    _, exif_out = main._bake_orientation_and_reset(img, bad)
    assert exif_out == bad  # malformed bytes are returned untouched


# ══════════════════════════════════════════════════════════════════════════════
# 6. Endpoint: /healthz
# ══════════════════════════════════════════════════════════════════════════════

def test_healthz_no_auth_required(client):
    resp = client.get("/healthz")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["ok"] is True
    assert "version" in data


# ══════════════════════════════════════════════════════════════════════════════
# 7. Endpoint: /convert — auth & validation
# ══════════════════════════════════════════════════════════════════════════════

def test_convert_requires_user_token(client, drive):
    resp = _post_convert(client, _default_body(), token=None)
    assert resp.status_code == 401
    assert resp.get_json()["error"] == "unauthorized"


@pytest.mark.parametrize("missing", ["sourceFileId", "destFolderId", "destName"])
def test_convert_requires_all_params(client, drive, missing):
    body = _default_body()
    del body[missing]
    resp = _post_convert(client, body)
    assert resp.status_code == 400
    assert resp.get_json()["ok"] is False


def test_convert_empty_body(client, drive):
    resp = _post_convert(client, {})
    assert resp.status_code == 400


def test_convert_rejects_jpeg_source(client, drive):
    drive.mime_type = "image/jpeg"
    drive.file_name = "already.jpg"
    resp = _post_convert(client, _default_body())
    assert resp.status_code == 400
    assert resp.get_json()["error"] == "unsupported_format"


# ══════════════════════════════════════════════════════════════════════════════
# 8. Endpoint: /convert — Drive error propagation
# ══════════════════════════════════════════════════════════════════════════════

def test_convert_metadata_permission_error(client, drive):
    drive.metadata_error = PermissionError("unauthorized")
    resp = _post_convert(client, _default_body())
    assert resp.status_code == 401
    assert resp.get_json()["error"] == "unauthorized"


def test_convert_metadata_not_found(client, drive):
    drive.metadata_error = FileNotFoundError("source_not_found")
    resp = _post_convert(client, _default_body())
    assert resp.status_code == 404
    assert resp.get_json()["error"] == "source_not_found"


def test_convert_download_permission_error(client, drive):
    drive.download_error = PermissionError("unauthorized")
    resp = _post_convert(client, _default_body())
    assert resp.status_code == 401
    assert resp.get_json()["error"] == "unauthorized"


def test_convert_download_io_error(client, drive):
    drive.download_error = IOError("download_failed: HTTP 500")
    resp = _post_convert(client, _default_body())
    assert resp.status_code == 502
    assert resp.get_json()["error"] == "download_failed"


def test_convert_upload_failure(client, drive):
    drive.upload_error = RuntimeError("drive upload 500")
    resp = _post_convert(client, _default_body())
    assert resp.status_code == 502
    assert resp.get_json()["error"] == "upload_failed"


def test_convert_unsupported_source_format(client, drive):
    drive.mime_type = "application/octet-stream"
    drive.file_name = "mystery.bin"
    drive.source_bytes = b"\x00\x01\x02not an image"
    resp = _post_convert(client, _default_body())
    assert resp.status_code == 400
    assert resp.get_json()["error"] == "unsupported_format"


# ══════════════════════════════════════════════════════════════════════════════
# 9. Endpoint: /convert — successful conversions
# ══════════════════════════════════════════════════════════════════════════════

def _assert_valid_jpeg(raw: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(raw))
    img.load()
    assert img.format == "JPEG"
    assert img.mode == "RGB"
    return img


def test_convert_png_success(client, drive):
    drive.mime_type = "image/png"
    drive.file_name = "photo.png"
    drive.source_bytes = _bytes_for("PNG", _rgb_image((64, 48)))
    resp = _post_convert(client, _default_body())
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["ok"] is True
    assert data["destFileId"] == "uploaded-file-id-123"
    assert data["destSizeBytes"] > 0
    assert data["sourceMimeType"] == "image/png"
    assert "conversionMs" in data
    # Verify the bytes actually uploaded to Drive are a valid RGB JPEG:
    out = _assert_valid_jpeg(drive.uploaded_bytes)
    assert out.size == (64, 48)
    assert drive.uploaded_name == "OUTPUT.jpg"
    assert drive.uploaded_folder == "dest-folder-id"


def test_convert_flattens_transparency_to_white(client, drive):
    drive.mime_type = "image/png"
    drive.file_name = "alpha.png"
    drive.source_bytes = _bytes_for("PNG", _rgba_image((40, 20)))
    resp = _post_convert(client, _default_body())
    assert resp.status_code == 200
    out = _assert_valid_jpeg(drive.uploaded_bytes)
    # right half was transparent → near-white after flatten + JPEG
    r, g, b = out.getpixel((38, 10))
    assert r > 245 and g > 245 and b > 245


def test_convert_respects_max_dim_resize(client, drive):
    drive.mime_type = "image/png"
    drive.file_name = "big.png"
    drive.source_bytes = _bytes_for("PNG", _rgb_image((800, 400)))
    resp = _post_convert(client, _default_body(maxDim=200))
    assert resp.status_code == 200
    out = _assert_valid_jpeg(drive.uploaded_bytes)
    assert max(out.size) <= 200
    # aspect ratio preserved (2:1)
    assert out.size == (200, 100)


def test_convert_no_resize_when_maxdim_null(client, drive):
    drive.mime_type = "image/png"
    drive.file_name = "exact.png"
    drive.source_bytes = _bytes_for("PNG", _rgb_image((300, 150)))
    resp = _post_convert(client, _default_body(maxDim=None))
    assert resp.status_code == 200
    out = _assert_valid_jpeg(drive.uploaded_bytes)
    assert out.size == (300, 150)


def test_convert_quality_affects_size(client, drive):
    """Lower JPEG quality should yield a smaller (or equal) output."""
    img_bytes = _bytes_for("PNG", _rgb_image((256, 256)))

    drive.mime_type = "image/png"
    drive.file_name = "q.png"
    drive.source_bytes = img_bytes
    r_hi = _post_convert(client, _default_body(jpgQuality=95))
    size_hi = r_hi.get_json()["destSizeBytes"]

    drive.source_bytes = img_bytes
    r_lo = _post_convert(client, _default_body(jpgQuality=20))
    size_lo = r_lo.get_json()["destSizeBytes"]

    assert size_lo <= size_hi


def test_convert_preserves_exif_when_requested(client, drive):
    # Build a PNG, but feed EXIF through a JPEG-origin path: use TIFF which can carry exif.
    src = _rgb_image((50, 50))
    buf = io.BytesIO()
    src.save(buf, "JPEG", exif=_exif_bytes(orientation=1))
    # Re-route as PNG won't carry exif; use a format Pillow reads exif from.
    # Simplest reliable path: source is a non-jpeg the service accepts AND carries exif.
    # WEBP supports exif; fall back to skipping if WEBP unavailable.
    if not HAS_WEBP:
        pytest.skip("WEBP needed to carry EXIF into a non-JPEG source")
    wbuf = io.BytesIO()
    src.save(wbuf, "WEBP", exif=_exif_bytes(orientation=1))
    drive.mime_type = "image/webp"
    drive.file_name = "exif.webp"
    drive.source_bytes = wbuf.getvalue()

    resp = _post_convert(client, _default_body(preserveExif=True, bakeOrientation=True))
    assert resp.status_code == 200
    out = Image.open(io.BytesIO(drive.uploaded_bytes))
    out.load()
    # Output should carry an EXIF block with orientation reset to 1.
    exif = out.info.get("exif")
    assert exif is not None
    assert piexif.load(exif)["0th"][piexif.ImageIFD.Orientation] == 1


def test_convert_drops_exif_when_not_requested(client, drive):
    if not HAS_WEBP:
        pytest.skip("WEBP needed for EXIF source")
    wbuf = io.BytesIO()
    _rgb_image((40, 40)).save(wbuf, "WEBP", exif=_exif_bytes(orientation=6))
    drive.mime_type = "image/webp"
    drive.file_name = "exif.webp"
    drive.source_bytes = wbuf.getvalue()
    resp = _post_convert(client, _default_body(preserveExif=False))
    assert resp.status_code == 200
    out = Image.open(io.BytesIO(drive.uploaded_bytes))
    out.load()
    assert out.info.get("exif") in (None, b"")


def test_convert_bakes_orientation_into_pixels(client, drive):
    """With bakeOrientation, an orientation-6 source comes out physically rotated."""
    if not HAS_WEBP:
        pytest.skip("WEBP needed to carry orientation into source")
    src = _rgb_image((60, 30))
    wbuf = io.BytesIO()
    src.save(wbuf, "WEBP", exif=_exif_bytes(orientation=6))
    drive.mime_type = "image/webp"
    drive.file_name = "rot.webp"
    drive.source_bytes = wbuf.getvalue()
    resp = _post_convert(client, _default_body(bakeOrientation=True))
    assert resp.status_code == 200
    out = _assert_valid_jpeg(drive.uploaded_bytes)
    # orientation 6 swaps W/H: 60x30 → 30x60
    assert out.size == (30, 60)


# ══════════════════════════════════════════════════════════════════════════════
# 10. Format matrix — every accepted input lands as a valid JPEG via /convert
# ══════════════════════════════════════════════════════════════════════════════

FORMAT_CASES = [
    ("image/png", "in.png", "PNG", True),
    ("image/webp", "in.webp", "WEBP", HAS_WEBP),
    ("image/tiff", "in.tiff", "TIFF", HAS_TIFF),
    ("image/bmp", "in.bmp", "BMP", HAS_BMP),
    ("image/gif", "in.gif", "GIF", HAS_GIF),
    ("image/heic", "in.heic", "HEIF", HAS_HEIF),
    ("image/heif", "in.heif", "HEIF", HAS_HEIF),
    ("image/avif", "in.avif", "AVIF", HAS_AVIF),
]


@pytest.mark.parametrize("mime,name,fmt,available", FORMAT_CASES)
def test_convert_format_matrix(client, drive, mime, name, fmt, available):
    if not available:
        pytest.skip(f"{fmt} encoder not available in this environment")
    drive.mime_type = mime
    drive.file_name = name
    drive.source_bytes = _bytes_for(fmt, _rgb_image((48, 32)))
    resp = _post_convert(client, _default_body(destName="out.jpg"))
    assert resp.status_code == 200, resp.get_json()
    out = _assert_valid_jpeg(drive.uploaded_bytes)
    assert out.size == (48, 32)


def test_every_pillow_mime_is_exercised_or_skipped():
    """Guard: keep the format matrix in sync with PILLOW_MIMES + HEIC_MIMES."""
    covered = {mime for mime, *_ in FORMAT_CASES}
    declared = set(main.PILLOW_MIMES) | set(main.HEIC_MIMES)
    missing = declared - covered
    assert not missing, f"Format matrix missing coverage for: {missing}"
