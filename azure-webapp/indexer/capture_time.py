"""
capture_time.py — derive a photo's capture time and the sortable filename
prefix (CAPTURE_TIME_SORT_DESIGN).

Resolution chain (most → least authoritative); we also record which tier was
used in `takenAtSource` so the UI can flag best-guesses and a later pass can
upgrade them:

  1. "exif"       — EXIF DateTimeOriginal read from the image bytes (+ optional
                    SubSecTimeOriginal for burst tie-breaking). The real shutter
                    time. JPEG via Pillow; HEIC via pillow-heif (registered on
                    import). Camera local wall-clock, no zone — stored verbatim.
  2. "drive_exif" — Drive's server-side EXIF parse (imageMediaMetadata.time).
                    Same value when present; covers formats Pillow can't read.
  3. "created"    — Drive createdTime (≈ upload time).
  4. "modified"   — Drive modifiedTime (last resort; what the system stored
                    before this feature).

`takenAt` is an ISO-8601 string with no zone offset (e.g. "2026-06-20T14:30:52")
so lexicographic order == chronological order within an event.
"""

from __future__ import annotations

import io
import logging
import re

log = logging.getLogger("indexer.capture_time")

# Register the HEIC/HEIF opener so Pillow can read iPhone .heic EXIF. Best
# effort: if the wheel is missing we just fall back to the Drive tiers.
try:  # pragma: no cover - import side effect
    import pillow_heif

    pillow_heif.register_heif_opener()
except Exception as exc:  # noqa: BLE001  pragma: no cover
    log.warning("pillow-heif not available, HEIC EXIF will use Drive fallback (%s)", exc)

# EXIF tag ids (so we don't depend on Pillow's TAGS name table).
_TAG_DATETIME_ORIGINAL = 36867  # DateTimeOriginal
_TAG_SUBSEC_ORIGINAL = 37521  # SubSecTimeOriginal

# A name that already carries our prefix: YYYYMMDD-HHMMSS, optional _SSS/_NNN.
PREFIX_RE = re.compile(r"^\d{8}-\d{6}(?:_\d{3})?_")

# EXIF/Drive wall-clock: "YYYY:MM:DD HH:MM:SS".
_EXIF_TS_RE = re.compile(r"^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})")


def _exif_to_iso(value: str) -> str | None:
    """Normalize an EXIF/Drive 'YYYY:MM:DD HH:MM:SS' wall-clock to ISO."""
    if not value:
        return None
    m = _EXIF_TS_RE.match(value.strip())
    if not m:
        return None
    y, mo, d, h, mi, s = m.groups()
    return f"{y}-{mo}-{d}T{h}:{mi}:{s}"


def read_exif_datetime(data: bytes) -> tuple[str | None, str | None]:
    """Return (iso_datetime, subsec) from image EXIF, or (None, None).

    Never raises: a corrupt/again-stripped image just yields no EXIF and the
    caller falls back to the Drive tiers.
    """
    try:
        from PIL import Image

        with Image.open(io.BytesIO(data)) as img:
            exif = img.getexif()
            if not exif:
                return None, None
            raw = exif.get(_TAG_DATETIME_ORIGINAL)
            # DateTimeOriginal lives in the Exif IFD on most files.
            if not raw:
                try:
                    ifd = exif.get_ifd(0x8769)  # ExifIFD
                    raw = ifd.get(_TAG_DATETIME_ORIGINAL)
                    subsec = ifd.get(_TAG_SUBSEC_ORIGINAL)
                except Exception:  # noqa: BLE001
                    subsec = None
            else:
                subsec = exif.get(_TAG_SUBSEC_ORIGINAL)
            iso = _exif_to_iso(str(raw)) if raw else None
            sub = None
            if subsec is not None:
                digits = re.sub(r"\D", "", str(subsec))[:3]
                sub = digits.ljust(3, "0") if digits else None
            return iso, sub
    except Exception as exc:  # noqa: BLE001
        log.debug("EXIF read failed: %s", exc)
        return None, None


def resolve_taken_at(exif_iso: str | None, drive_meta: dict) -> tuple[str | None, str]:
    """Pick takenAt + takenAtSource from the EXIF value and Drive metadata.

    `drive_meta` is one file dict from the listing; we read its
    imageMediaMetadata.time / createdTime / modifiedTime fields.
    """
    if exif_iso:
        return exif_iso, "exif"

    img_meta = (drive_meta.get("imageMediaMetadata") or {}).get("time")
    drive_exif = _exif_to_iso(img_meta) if img_meta else None
    if drive_exif:
        return drive_exif, "drive_exif"

    created = drive_meta.get("createdTime")
    if created:
        return created, "created"

    modified = drive_meta.get("modifiedTime")
    if modified:
        return modified, "modified"

    return None, "none"


def prefix_for(taken_at_iso: str | None, subsec: str | None = None, seq: int | None = None) -> str | None:
    """Build the `YYYYMMDD-HHMMSS[_SSS]` sortable filename prefix.

    Sub-second (`subsec`, EXIF SubSecTimeOriginal) wins for burst tie-breaking;
    otherwise a per-batch `seq` (0-999) is zero-padded to `_NNN`. Returns None
    when there's no usable time (caller leaves the name unchanged).
    """
    iso = _exif_to_iso(taken_at_iso) or taken_at_iso
    if not iso:
        return None
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})", iso)
    if not m:
        return None
    base = f"{m.group(1)}{m.group(2)}{m.group(3)}-{m.group(4)}{m.group(5)}{m.group(6)}"
    if subsec:
        return f"{base}_{subsec[:3].ljust(3, '0')}"
    if seq is not None:
        return f"{base}_{seq:03d}"
    return base


def strip_prefix(name: str) -> str:
    """Remove a leading capture-time prefix so renames stay idempotent."""
    return PREFIX_RE.sub("", name, count=1)


def apply_prefix(name: str, prefix: str | None, max_len: int = 240) -> str:
    """Prepend `prefix` to `name` (idempotent), keeping a length cap.

    No-op when `prefix` is None or `name` already starts with that exact prefix.
    """
    if not prefix:
        return name
    base = strip_prefix(name)
    candidate = f"{prefix}_{base}"
    if len(candidate) <= max_len:
        return candidate
    # Trim the base (keep its extension) so the sortable prefix always survives.
    keep = max_len - len(prefix) - 1
    dot = base.rfind(".")
    if 0 <= dot and len(base) - dot <= 12:
        ext = base[dot:]
        stem = base[:dot][: max(0, keep - len(ext))]
        return f"{prefix}_{stem}{ext}"
    return f"{prefix}_{base[:max(0, keep)]}"
