"""Tests for capture_time: EXIF read, fallback chain, and filename prefixing."""

import io

from PIL import Image

from capture_time import (
    read_exif_datetime,
    resolve_taken_at,
    prefix_for,
    strip_prefix,
    apply_prefix,
    PREFIX_RE,
)


def _jpeg_with_datetime(value: str | None) -> bytes:
    img = Image.new("RGB", (8, 8), (10, 20, 30))
    buf = io.BytesIO()
    if value is None:
        img.save(buf, "JPEG")
    else:
        exif = img.getexif()
        exif[36867] = value  # DateTimeOriginal
        img.save(buf, "JPEG", exif=exif)
    return buf.getvalue()


# ── read_exif_datetime ───────────────────────────────────────────────────────

def test_read_exif_datetime_happy():
    iso, sub = read_exif_datetime(_jpeg_with_datetime("2026:06:20 14:30:52"))
    assert iso == "2026-06-20T14:30:52"
    assert sub is None


def test_read_exif_datetime_none_when_absent():
    iso, sub = read_exif_datetime(_jpeg_with_datetime(None))
    assert iso is None


def test_read_exif_datetime_never_raises_on_garbage():
    assert read_exif_datetime(b"not an image") == (None, None)


# ── resolve_taken_at fallback chain ──────────────────────────────────────────

def test_resolve_prefers_exif():
    iso, src = resolve_taken_at("2026-06-20T14:30:52", {"modifiedTime": "2020-01-01T00:00:00Z"})
    assert (iso, src) == ("2026-06-20T14:30:52", "exif")


def test_resolve_drive_exif_when_no_exif():
    iso, src = resolve_taken_at(None, {"imageMediaMetadata": {"time": "2026:06:20 14:30:52"}})
    assert (iso, src) == ("2026-06-20T14:30:52", "drive_exif")


def test_resolve_created_then_modified():
    assert resolve_taken_at(None, {"createdTime": "2026-06-20T10:00:00Z"}) == ("2026-06-20T10:00:00Z", "created")
    assert resolve_taken_at(None, {"modifiedTime": "2026-06-19T09:00:00Z"}) == ("2026-06-19T09:00:00Z", "modified")


def test_resolve_none_when_nothing():
    assert resolve_taken_at(None, {}) == (None, "none")


# ── prefix helpers ───────────────────────────────────────────────────────────

def test_prefix_for_basic_and_subsec_and_seq():
    assert prefix_for("2026-06-20T14:30:52") == "20260620-143052"
    assert prefix_for("2026-06-20T14:30:52", subsec="07") == "20260620-143052_070"
    assert prefix_for("2026-06-20T14:30:52", seq=3) == "20260620-143052_003"
    assert prefix_for(None) is None


def test_prefix_for_accepts_exif_colon_format():
    assert prefix_for("2026:06:20 14:30:52") == "20260620-143052"


def test_strip_and_idempotent_apply():
    name = "MMR_JaneDoe_IMG_4231.JPG"
    prefixed = apply_prefix(name, "20260620-143052")
    assert prefixed == "20260620-143052_MMR_JaneDoe_IMG_4231.JPG"
    assert PREFIX_RE.match(prefixed)
    # Re-applying with the same time is a no-op (no stacked prefix).
    assert apply_prefix(prefixed, "20260620-143052") == prefixed
    # A new time replaces the old prefix rather than stacking.
    assert apply_prefix(prefixed, "20260101-000000") == "20260101-000000_MMR_JaneDoe_IMG_4231.JPG"
    assert strip_prefix(prefixed) == name


def test_apply_prefix_none_is_noop():
    assert apply_prefix("x.jpg", None) == "x.jpg"


def test_apply_prefix_respects_length_cap_keeping_extension():
    long_base = "A" * 300 + ".jpg"
    out = apply_prefix(long_base, "20260620-143052", max_len=60)
    assert out.startswith("20260620-143052_")
    assert out.endswith(".jpg")
    assert len(out) <= 60
