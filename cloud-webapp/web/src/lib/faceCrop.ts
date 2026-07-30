/**
 * faceCrop.ts — cut the detected face out of a picked selfie, for the "is this
 * you?" confirmation.
 *
 * When the face is small in frame, the useful question is not "is this photo
 * good" but "did we find the right face" — a face 6% of the frame across is
 * hard to judge at thumbnail size, and if the detector locked onto someone
 * behind the searcher, the results will be that person's. Cropping to the box
 * the matcher graded answers that in one glance.
 *
 * The box arrives normalized (0–1) from `/api/findme/selfie-check`, so nothing
 * here needs the image's pixel dimensions up front.
 */

/** Normalized [x1, y1, x2, y2], each 0–1. */
export type NormBox = readonly [number, number, number, number];

/** Fraction of the face's own size added around the box, so the crop reads as a
 *  head-and-shoulders portrait rather than a tight cut at the hairline. */
export const CROP_PADDING = 0.6;
/** Output edge in CSS pixels. Small — it's an inline confirmation, not a viewer. */
export const CROP_SIZE = 160;

/** Load a File into an HTMLImageElement (universally supported, incl. iOS). */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode_failed'));
    };
    img.src = url;
  });
}

/**
 * Square crop around `box`, padded and clamped to the image.
 *
 * Square on purpose: the result sits in a fixed slot next to the prompt, and
 * letting the aspect follow the face box would make the layout jump between
 * photos. Returns the source rect in pixels.
 */
export function cropRect(
  box: NormBox,
  width: number,
  height: number,
  padding = CROP_PADDING,
): { sx: number; sy: number; size: number } {
  const [x1, y1, x2, y2] = box;
  const cx = ((x1 + x2) / 2) * width;
  const cy = ((y1 + y2) / 2) * height;
  const faceSide = Math.max((x2 - x1) * width, (y2 - y1) * height);
  // Never larger than the image, never a degenerate zero-size rect.
  const size = Math.max(1, Math.min(faceSide * (1 + padding), width, height));
  // Clamp the origin so a face near an edge slides inward instead of sampling
  // outside the bitmap (which would letterbox the crop with transparent pixels).
  const sx = Math.min(Math.max(0, cx - size / 2), Math.max(0, width - size));
  const sy = Math.min(Math.max(0, cy - size / 2), Math.max(0, height - size));
  return { sx, sy, size };
}

/**
 * Render the crop to a data URL, or null if the image can't be decoded or a
 * canvas isn't available. Never throws: the confirmation is a nicety, and
 * failing to draw it must not block the search.
 */
export async function cropFaceToDataUrl(
  file: File,
  box: NormBox,
  outSize = CROP_SIZE,
): Promise<string | null> {
  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    return null;
  }
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) {
    URL.revokeObjectURL(img.src);
    return null;
  }

  const { sx, sy, size } = cropRect(box, w, h);
  const canvas = document.createElement('canvas');
  canvas.width = outSize;
  canvas.height = outSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    URL.revokeObjectURL(img.src);
    return null;
  }
  try {
    ctx.drawImage(img, sx, sy, size, size, 0, 0, outSize, outSize);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    return null; // tainted canvas / not allowed
  } finally {
    URL.revokeObjectURL(img.src);
  }
}
