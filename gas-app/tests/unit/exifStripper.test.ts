/**
 * exifStripper.test.ts
 *
 * Tests for stripJpegExif() and hasStrippableExif(). All inputs are synthetic
 * minimal JPEG byte sequences so the test has no external file dependencies.
 *
 * JPEG structure recap:
 *   SOI  = FF D8
 *   Segment = FF <marker> <length-hi> <length-lo> <data...>
 *             where length = 2 + data.length (includes the 2 length bytes)
 *   SOS  = FF DA ... (image data follows, no further segment parsing)
 *   EOI  = FF D9
 */

import { stripJpegExif, hasStrippableExif } from '../../src/utils/exifStripper';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Concatenates Uint8Arrays into a single ArrayBuffer. */
function concat(...parts: Uint8Array[]): ArrayBuffer {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out.buffer;
}

/** SOI marker (Start of Image). */
const SOI = new Uint8Array([0xff, 0xd8]);

/** EOI marker (End of Image) — used as a minimal image-data stand-in. */
const EOI = new Uint8Array([0xff, 0xd9]);

/**
 * Builds a minimal SOS segment + fake compressed data so the parser stops
 * scanning and copies everything to end-of-file.
 */
function sos(payloadBytes = 4): Uint8Array {
  // SOS header: FF DA + length(2) + minimal header bytes
  // length field = 2 + payloadBytes that are part of the segment header
  // For simplicity just use a short fixed header followed by fake image bytes
  const header = new Uint8Array([0xff, 0xda, 0x00, 0x0c,
    0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]);
  const imageData = new Uint8Array(payloadBytes).fill(0xab);
  return concat(header, imageData) as unknown as Uint8Array;
}

/**
 * Builds a generic APP or other segment with the given marker byte and payload.
 * marker: e.g. 0xe0 for APP0, 0xe1 for APP1, 0xed for APP13.
 */
function segment(markerByte: number, payload: Uint8Array): Uint8Array {
  const length = 2 + payload.length; // length field includes its own 2 bytes
  return new Uint8Array([
    0xff, markerByte,
    (length >> 8) & 0xff, length & 0xff,
    ...payload,
  ]);
}

const APP0_PAYLOAD = new Uint8Array([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]); // "JFIF\0\1"
const APP1_EXIF    = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\0\0"
const APP13_IPTC   = new Uint8Array([0x50, 0x68, 0x6f, 0x74, 0x6f]); // "Photo"

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('stripJpegExif()', () => {

  // ── Non-JPEG passthrough ───────────────────────────────────────────────────

  it('returns the original buffer reference for a PNG file', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer; // PNG magic
    expect(stripJpegExif(png)).toBe(png);
  });

  it('returns the original buffer reference for a HEIC-like file', () => {
    const heic = new Uint8Array([0x00, 0x00, 0x00, 0x18]).buffer;
    expect(stripJpegExif(heic)).toBe(heic);
  });

  it('returns the original buffer reference for an empty buffer', () => {
    const empty = new ArrayBuffer(0);
    expect(stripJpegExif(empty)).toBe(empty);
  });

  it('returns the original buffer reference for a 1-byte buffer', () => {
    const tiny = new Uint8Array([0xff]).buffer;
    expect(stripJpegExif(tiny)).toBe(tiny);
  });

  // ── JPEG with no strippable segments ──────────────────────────────────────

  it('returns a new buffer with identical bytes for a JPEG with no EXIF', () => {
    const app0Seg = segment(0xe0, APP0_PAYLOAD);
    const sosSeg  = sos();
    const input   = concat(SOI, app0Seg, new Uint8Array(sosSeg));

    const result = stripJpegExif(input);

    // Should be a new buffer (copy), not the same reference.
    expect(result).not.toBe(input);
    expect(new Uint8Array(result)).toEqual(new Uint8Array(input));
  });

  // ── EXIF stripping ────────────────────────────────────────────────────────

  it('removes an APP1 (EXIF) segment from a JPEG', () => {
    const app0Seg = segment(0xe0, APP0_PAYLOAD);
    const app1Seg = segment(0xe1, APP1_EXIF);
    const sosSeg  = sos();
    const input   = concat(SOI, app0Seg, app1Seg, new Uint8Array(sosSeg));

    const result = new Uint8Array(stripJpegExif(input));

    // Output must not contain the APP1 marker.
    const resultStr = Array.from(result).map(b => b.toString(16).padStart(2,'0')).join('');
    expect(resultStr).not.toContain('ffe1');

    // APP0 and SOI must still be present.
    expect(result[0]).toBe(0xff);
    expect(result[1]).toBe(0xd8);
  });

  it('removes an APP13 (IPTC) segment from a JPEG', () => {
    const app13Seg = segment(0xed, APP13_IPTC);
    const sosSeg   = sos();
    const input    = concat(SOI, app13Seg, new Uint8Array(sosSeg));

    const result = new Uint8Array(stripJpegExif(input));

    const resultStr = Array.from(result).map(b => b.toString(16).padStart(2,'0')).join('');
    expect(resultStr).not.toContain('ffed');
  });

  it('removes both APP1 and APP13 when both are present', () => {
    const app0Seg  = segment(0xe0, APP0_PAYLOAD);
    const app1Seg  = segment(0xe1, APP1_EXIF);
    const app13Seg = segment(0xed, APP13_IPTC);
    const sosSeg   = sos();
    const input    = concat(SOI, app0Seg, app1Seg, app13Seg, new Uint8Array(sosSeg));

    const result = new Uint8Array(stripJpegExif(input));
    const resultStr = Array.from(result).map(b => b.toString(16).padStart(2,'0')).join('');
    expect(resultStr).not.toContain('ffe1');
    expect(resultStr).not.toContain('ffed');
  });

  it('preserves APP0 (JFIF) and image data after stripping', () => {
    const app0Seg = segment(0xe0, APP0_PAYLOAD);
    const app1Seg = segment(0xe1, APP1_EXIF);
    const sosSeg  = sos(8);
    const input   = concat(SOI, app0Seg, app1Seg, new Uint8Array(sosSeg));

    const stripped = stripJpegExif(input);

    // Reconstruct expected: SOI + APP0 + SOS-and-beyond (no APP1)
    const expected = concat(SOI, app0Seg, new Uint8Array(sosSeg));
    expect(new Uint8Array(stripped)).toEqual(new Uint8Array(expected));
  });

  it('output is smaller than input when EXIF is stripped', () => {
    const app1Seg = segment(0xe1, new Uint8Array(200).fill(0x99));
    const sosSeg  = sos();
    const input   = concat(SOI, app1Seg, new Uint8Array(sosSeg));

    const result = stripJpegExif(input);
    expect(result.byteLength).toBeLessThan(input.byteLength);
  });

  // ── Robustness / malformed input ──────────────────────────────────────────

  it('returns original buffer for a JPEG with a truncated segment', () => {
    // SOI + marker + only 1 byte of length (needs 2)
    const truncated = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]).buffer;
    expect(stripJpegExif(truncated)).toBe(truncated);
  });

  it('returns original buffer for a JPEG with an impossible segment length (< 2)', () => {
    const badLen = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]).buffer; // length=1
    expect(stripJpegExif(badLen)).toBe(badLen);
  });

  it('returns original buffer when a segment overruns the file', () => {
    // Claims length=500 but file is only 10 bytes.
    const overrun = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x01, 0xf4, 0x00, 0x00]).buffer;
    expect(stripJpegExif(overrun)).toBe(overrun);
  });

  it('handles a JPEG with only SOI + EOI (no segments)', () => {
    const input = concat(SOI, EOI);
    const result = stripJpegExif(input);
    // EOI is a 2-byte marker with no length field; parser keeps it.
    expect(result.byteLength).toBeGreaterThan(0);
    expect(new Uint8Array(result)[0]).toBe(0xff);
    expect(new Uint8Array(result)[1]).toBe(0xd8);
  });
});

// ─── hasStrippableExif ────────────────────────────────────────────────────────

describe('hasStrippableExif()', () => {
  it('returns false for a non-JPEG buffer', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    expect(hasStrippableExif(png)).toBe(false);
  });

  it('returns false for a JPEG with no APP1 or APP13', () => {
    const input = concat(SOI, segment(0xe0, APP0_PAYLOAD), new Uint8Array(sos()));
    expect(hasStrippableExif(input)).toBe(false);
  });

  it('returns true for a JPEG with an APP1 segment', () => {
    const input = concat(SOI, segment(0xe1, APP1_EXIF), new Uint8Array(sos()));
    expect(hasStrippableExif(input)).toBe(true);
  });

  it('returns true for a JPEG with an APP13 segment', () => {
    const input = concat(SOI, segment(0xed, APP13_IPTC), new Uint8Array(sos()));
    expect(hasStrippableExif(input)).toBe(true);
  });
});
