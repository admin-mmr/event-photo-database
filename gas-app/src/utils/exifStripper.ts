/**
 * exifStripper.ts — Client-side JPEG EXIF removal utility (Phase 7).
 *
 * Design constraints:
 *   - Photos are uploaded directly from the browser to Drive; bytes never pass
 *     through GAS. Stripping must happen in the browser before the Drive PUT.
 *   - This module exports a pure function that operates on ArrayBuffers so it
 *     can be unit-tested in Node without any DOM or GAS globals.
 *
 * What we strip:
 *   - APP1 segments (marker 0xFFE1) — these carry EXIF (and XMP) metadata,
 *     including GPS coordinates that can dox photo locations.
 *   - APP13 segments (marker 0xFFED) — Photoshop/IPTC metadata, can include
 *     photographer name, caption, location keyword.
 *
 * What we keep:
 *   - APP0 (JFIF marker) — required for some viewers.
 *   - All other APP markers (APP2 ICC profile, APP14 Adobe, etc.) — safe.
 *   - SOF, DHT, DQT, SOS, image data — the actual picture.
 *
 * Supported formats:
 *   - JPEG (magic bytes 0xFFD8): stripped.
 *   - Everything else (PNG, HEIC, MP4, …): returned unchanged.
 *     HEIC EXIF is inside an ISOBMFF container and requires a parser we do
 *     not have client-side; GPS data in HEIC is a known trade-off documented
 *     in the admin setup guide.
 *
 * Correctness properties:
 *   - Non-JPEG input → identical ArrayBuffer reference returned.
 *   - JPEG with no strippable segments → new ArrayBuffer with identical bytes.
 *   - Malformed JPEG (truncated segment, impossible length) → original buffer
 *     returned unchanged so the upload still proceeds.
 */

/** JPEG magic bytes. */
const JPEG_SOI_0 = 0xff;
const JPEG_SOI_1 = 0xd8;

/** Segment markers we strip. */
const STRIP_MARKERS = new Set([
  0xffe1, // APP1  — EXIF / XMP
  0xffed, // APP13 — IPTC / Photoshop
]);

/**
 * Removes EXIF and IPTC metadata segments from a JPEG ArrayBuffer.
 * Returns the input buffer unchanged for non-JPEG files or on parse error.
 *
 * The returned buffer is always a fresh copy for JPEG input so callers can
 * safely hand it off to the Drive upload without aliasing the original.
 */
export function stripJpegExif(buffer: ArrayBuffer): ArrayBuffer {
  const view = new DataView(buffer);

  // Fast path: not a JPEG.
  if (
    view.byteLength < 4 ||
    view.getUint8(0) !== JPEG_SOI_0 ||
    view.getUint8(1) !== JPEG_SOI_1
  ) {
    return buffer;
  }

  // Collect byte ranges to keep: start with the SOI (first 2 bytes).
  const keepRanges: Array<[number, number]> = [[0, 2]];

  let offset = 2;
  try {
    while (offset < view.byteLength - 1) {
      // Every segment starts with 0xFF followed by the marker byte.
      if (view.getUint8(offset) !== 0xff) {
        // Lost sync — return original to avoid a corrupted upload.
        return buffer;
      }

      const markerByte = view.getUint8(offset + 1);
      const marker = (0xff00 | markerByte) >>> 0;

      // SOI / EOI / RST markers have no length field.
      if (
        markerByte === 0xd8 || // SOI
        markerByte === 0xd9 || // EOI
        (markerByte >= 0xd0 && markerByte <= 0xd7) // RST0–RST7
      ) {
        keepRanges.push([offset, offset + 2]);
        offset += 2;
        continue;
      }

      // SOS (Start of Scan): the compressed image data follows with no further
      // parseable segment structure. Everything to end-of-file is image data.
      if (markerByte === 0xda) {
        keepRanges.push([offset, view.byteLength]);
        break;
      }

      // All other segments carry a 2-byte big-endian length immediately after
      // the marker. The length includes its own 2 bytes but not the marker.
      if (offset + 3 >= view.byteLength) {
        return buffer; // Truncated — bail out safely.
      }
      const segmentLength = view.getUint16(offset + 2, false); // big-endian
      if (segmentLength < 2) {
        return buffer; // Impossible length — bail out safely.
      }

      const segEnd = offset + 2 + segmentLength;
      if (segEnd > view.byteLength) {
        return buffer; // Segment overruns buffer — bail out safely.
      }

      if (!STRIP_MARKERS.has(marker)) {
        keepRanges.push([offset, segEnd]);
      }
      // Stripped segments are simply not added to keepRanges.

      offset = segEnd;
    }
  } catch {
    // Any unexpected error → return original so upload is not broken.
    return buffer;
  }

  // Build the output buffer by concatenating kept ranges.
  const totalSize = keepRanges.reduce((sum, [s, e]) => sum + (e - s), 0);
  const out = new Uint8Array(totalSize);
  let writePos = 0;
  for (const [start, end] of keepRanges) {
    out.set(new Uint8Array(buffer, start, end - start), writePos);
    writePos += end - start;
  }
  return out.buffer;
}

/**
 * Returns true when the buffer is JPEG and contains at least one strippable
 * segment. Useful for UI feedback ("EXIF stripped from N files").
 */
export function hasStrippableExif(buffer: ArrayBuffer): boolean {
  const view = new DataView(buffer);
  if (
    view.byteLength < 4 ||
    view.getUint8(0) !== JPEG_SOI_0 ||
    view.getUint8(1) !== JPEG_SOI_1
  ) {
    return false;
  }
  let offset = 2;
  while (offset < view.byteLength - 3) {
    if (view.getUint8(offset) !== 0xff) break;
    const markerByte = view.getUint8(offset + 1);
    if (markerByte === 0xda) break; // reached image data
    if (markerByte === 0xd8 || markerByte === 0xd9) { offset += 2; continue; }
    if (markerByte >= 0xd0 && markerByte <= 0xd7) { offset += 2; continue; }
    const marker = (0xff00 | markerByte) >>> 0;
    if (STRIP_MARKERS.has(marker)) return true;
    if (offset + 3 >= view.byteLength) break;
    const len = view.getUint16(offset + 2, false);
    if (len < 2 || offset + 2 + len > view.byteLength) break;
    offset += 2 + len;
  }
  return false;
}
