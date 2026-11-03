/**
 * selfieUpload.ts — shrink a picked selfie before Find Me uploads it.
 *
 * A 48 MP phone photo can pass the api's 15 MiB per-file cap
 * (`FINDME_MAX_FILE_BYTES`), and on the NYC Marathon event day that surfaced
 * as nine "search failed" errors with nothing to say the photo was the problem.
 * A face needs nowhere near those bytes, so big picks are re-encoded here,
 * before the selfie check, so the check, the reframe and the search all see
 * the same file.
 *
 * Only big picks are touched. Re-encoding drops EXIF (see `renderCropToFile`),
 * and a photo that already fits gains nothing from it.
 */

import { FINDME_MAX_FILE_BYTES } from '@cloud-webapp/shared';

import { renderCropToFile, type CropRect } from './faceCrop.js';

/** Picks above this are re-encoded. Well under the api's per-file cap, and low
 *  enough that a full set of five stays under Cloud Run's 32 MiB request cap. */
export const DOWNSCALE_ABOVE_BYTES = 6 * 1024 * 1024;

/** Long edge of a re-encoded pick. ~12 MP at 4:3: far more than the detector
 *  uses, and it leaves headroom for the reframe, which crops from this file.
 *  Also under iOS Safari's 16.7 MP canvas ceiling. */
export const DOWNSCALE_MAX_EDGE = 4096;

/** The whole image. `clampRect` trims an unbounded rect to the bitmap, so this
 *  needs no decode up front to learn the dimensions. */
const FULL_FRAME: CropRect = { x: 0, y: 0, width: Infinity, height: Infinity };

type Render = (file: File, rect: CropRect, maxEdge: number) => Promise<File | null>;

/**
 * The file to upload for `file`: itself when it is small enough, otherwise a
 * downscaled JPEG. Never throws — a pick the browser can't decode (HEIC outside
 * Safari, say) comes back unchanged, and `oversizedSelfies` then decides whether
 * it can still be sent.
 */
export async function fitSelfieForUpload(
  file: File,
  render: Render = renderCropToFile,
): Promise<File> {
  if (file.size <= DOWNSCALE_ABOVE_BYTES) return file;
  let out: File | null = null;
  try {
    out = await render(file, FULL_FRAME, DOWNSCALE_MAX_EDGE);
  } catch {
    out = null;
  }
  // A re-encode that came out bigger (an already tight JPEG) is no help.
  if (!out || out.size >= file.size) return file;
  const name = file.name.replace(/\.[^.]+$/, '') || 'selfie';
  return new File([out], `${name}.jpg`, { type: 'image/jpeg' });
}

/** Picks the api would refuse with 413 `file_too_large`. */
export function oversizedSelfies(files: readonly File[]): File[] {
  return files.filter((f) => f.size > FINDME_MAX_FILE_BYTES);
}

/** The api's per-file cap in whole MB, for the message. */
export const MAX_SELFIE_MB = Math.round(FINDME_MAX_FILE_BYTES / (1024 * 1024));
