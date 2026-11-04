/**
 * imageType.ts — what a selfie really is, from its bytes when the browser's
 * label can't be trusted.
 *
 * Find-Me used to accept a file only by the Content-Type the browser put on it.
 * Windows Chrome labels a file by its extension through the OS registry, so an
 * iPhone HEIC copied to a PC without the HEIF extension arrives as
 * `application/octet-stream` (or with no type), and was refused with 415 even
 * though the matcher decodes HEIC (pillow-heif). Two Windows users hit that on
 * 2026-11-03/04, one of them five times in two minutes. The label is now only a
 * shortcut: when it isn't one we accept, the magic bytes decide.
 */

/** Types the matcher decodes (pipeline.decode_image: Pillow + pillow-heif). */
export const SELFIE_MIMES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
]);

/** ISO-BMFF `ftyp` brands of HEVC-coded HEIF images (iPhone photos are `heic`). */
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
/** Generic HEIF brands; the codec inside is decided by pillow-heif. */
const HEIF_BRANDS = new Set(['mif1', 'msf1']);

/** The image type `buf` holds, judged by its first bytes; null when it is none we accept. */
export function sniffImageType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (HEIC_BRANDS.has(brand)) return 'image/heic';
    if (HEIF_BRANDS.has(brand)) return 'image/heif';
  }
  return null;
}

/** The type to treat an upload as: its label when we accept it, else its bytes'. */
export function resolveSelfieType(declared: string, buf: Buffer): string | null {
  return SELFIE_MIMES.has(declared) ? declared : sniffImageType(buf);
}
