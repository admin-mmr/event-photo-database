/**
 * faceCrop.ts — reframe a picked selfie around the face the matcher graded.
 *
 * Two jobs, and the difference matters:
 *
 *  - `cropRect` / `cropFaceToDataUrl` produce a tight face thumbnail, used ONLY
 *    to ask "is this you?". Nothing is searched with it.
 *  - `suggestedPortraitRect` / `renderCropToFile` produce the photo we actually
 *    UPLOAD when the framing is poor.
 *
 * The second is deliberately generous. Find Me's default `fused` mode queries on
 * two signals — the face embedding and a person/outfit crop taken from the same
 * image — so a tight face crop would hand the matcher a photo with no body in
 * it and quietly destroy the outfit half of the query (and with it the
 * outfit-only fallback). The suggested crop therefore keeps head, shoulders and
 * as much torso as the frame allows, sitting the face high in a portrait box.
 *
 * Boxes arrive normalized (0–1) from `/api/findme/selfie-check`, so nothing here
 * needs the image's pixel dimensions up front.
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

// ── Reframing the photo we upload ────────────────────────────────────────────

/** Pixel rect in source-image coordinates. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Portrait aspect (w:h) for the suggested crop — roughly a phone photo. */
export const PORTRAIT_ASPECT = 3 / 4;
/** Crop width as a multiple of the face's width: head plus both shoulders. */
export const CROP_FACE_WIDTHS = 3.2;
/** Where the face's centre sits vertically in the crop. Above centre, so the
 *  space below fills with torso — that is what the outfit embedding reads. */
export const FACE_VERTICAL_ANCHOR = 0.32;
/** Longest edge of the uploaded crop. Keeps the upload small without starving
 *  the embedder — well above the matcher's 40px minimum face. */
export const MAX_UPLOAD_EDGE = 1600;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * The crop we propose for upload: a portrait box around the face, extending
 * downward for torso, clamped inside the image.
 *
 * Shrinks rather than slides when the ideal box doesn't fit — sliding would move
 * the face off the anchor and could push it out of frame entirely on a face near
 * an edge, which is exactly the badly-framed case this exists for.
 */
export function suggestedPortraitRect(
  face: NormBox,
  imgW: number,
  imgH: number,
): CropRect {
  const [x1, y1, x2, y2] = face;
  const faceW = Math.max((x2 - x1) * imgW, 1);
  const cx = ((x1 + x2) / 2) * imgW;
  const cy = ((y1 + y2) / 2) * imgH;

  // Ideal size, then shrunk to fit the image on both axes at a fixed aspect.
  let width = Math.min(faceW * CROP_FACE_WIDTHS, imgW);
  let height = width / PORTRAIT_ASPECT;
  if (height > imgH) {
    height = imgH;
    width = height * PORTRAIT_ASPECT;
  }

  // Anchor the face, then clamp the origin so the box stays on the bitmap.
  const x = clamp(cx - width / 2, 0, Math.max(0, imgW - width));
  const y = clamp(cy - height * FACE_VERTICAL_ANCHOR, 0, Math.max(0, imgH - height));
  return { x, y, width, height };
}

/** Normalized box → pixel rect (used to seed the editor from a face box). */
export function toPixelRect(box: NormBox, imgW: number, imgH: number): CropRect {
  const [x1, y1, x2, y2] = box;
  return { x: x1 * imgW, y: y1 * imgH, width: (x2 - x1) * imgW, height: (y2 - y1) * imgH };
}

/** Keep a rect inside the image, preserving its size where possible. */
export function clampRect(rect: CropRect, imgW: number, imgH: number): CropRect {
  const width = clamp(rect.width, 1, imgW);
  const height = clamp(rect.height, 1, imgH);
  return {
    width,
    height,
    x: clamp(rect.x, 0, Math.max(0, imgW - width)),
    y: clamp(rect.y, 0, Math.max(0, imgH - height)),
  };
}

/**
 * Render `rect` of `file` to a JPEG File — the photo the search actually
 * uploads. Returns null if the image can't be decoded or drawn; the caller then
 * uploads the original rather than blocking on a reframe.
 *
 * Note the output carries no EXIF. Orientation is already baked in (the browser
 * orients the <img> before we draw), but `DateTimeOriginal` is lost, so a
 * cropped selfie cannot anchor capture-time-conditional fusion. That knob is off
 * by default (`FUSION_TIME_CONDITIONAL`); if it is ever turned on, the anchor
 * should be read from the ORIGINAL file before cropping.
 */
export async function renderCropToFile(
  file: File,
  rect: CropRect,
  maxEdge = MAX_UPLOAD_EDGE,
): Promise<File | null> {
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

  const src = clampRect(rect, w, h);
  const scale = Math.min(1, maxEdge / Math.max(src.width, src.height));
  const outW = Math.max(1, Math.round(src.width * scale));
  const outH = Math.max(1, Math.round(src.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    URL.revokeObjectURL(img.src);
    return null;
  }
  try {
    ctx.drawImage(img, src.x, src.y, src.width, src.height, 0, 0, outW, outH);
  } catch {
    URL.revokeObjectURL(img.src);
    return null; // tainted canvas
  }
  URL.revokeObjectURL(img.src);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9),
  );
  if (!blob) return null;
  const name = file.name.replace(/\.[^.]+$/, '') || 'selfie';
  return new File([blob], `${name}-cropped.jpg`, { type: 'image/jpeg' });
}

/** Natural pixel size of an already-created object URL, or null if it won't
 *  decode. Separate from the crop helpers so a caller that needs both the size
 *  and a preview only decodes once. */
export function imageSize(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve(
        img.naturalWidth && img.naturalHeight
          ? { width: img.naturalWidth, height: img.naturalHeight }
          : null,
      );
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Same crop as `renderCropToFile`, as a small data URL for preview. */
export async function renderCropToDataUrl(
  file: File,
  rect: CropRect,
  maxEdge = 480,
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
  const src = clampRect(rect, w, h);
  const scale = Math.min(1, maxEdge / Math.max(src.width, src.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(src.width * scale));
  canvas.height = Math.max(1, Math.round(src.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    URL.revokeObjectURL(img.src);
    return null;
  }
  try {
    ctx.drawImage(img, src.x, src.y, src.width, src.height, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(img.src);
  }
}

/** Corner being dragged in the crop editor. */
export type CropHandle = 'nw' | 'ne' | 'sw' | 'se';

/** Smallest edge a crop box may be dragged to, in source pixels. */
export const MIN_CROP_EDGE = 24;

/**
 * Resize `origin` by dragging one corner `(dx, dy)`, holding the opposite
 * corner still and staying inside the image.
 *
 * Pure and separately tested because this is where crop editors go wrong: drag
 * a corner past its opposite and the box inverts; clamp naively at the bitmap
 * edge and the anchored corner creeps. Both are silent — the box just behaves
 * slightly wrong under the finger.
 */
export function resizeRect(
  origin: CropRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  imgW: number,
  imgH: number,
): CropRect {
  const west = handle === 'nw' || handle === 'sw';
  const north = handle === 'nw' || handle === 'ne';
  const right = origin.x + origin.width;
  const bottom = origin.y + origin.height;

  // Moving edges cannot cross the anchored ones.
  let x = west ? Math.min(origin.x + dx, right - MIN_CROP_EDGE) : origin.x;
  let y = north ? Math.min(origin.y + dy, bottom - MIN_CROP_EDGE) : origin.y;
  let width = west ? right - x : Math.max(MIN_CROP_EDGE, origin.width + dx);
  let height = north ? bottom - y : Math.max(MIN_CROP_EDGE, origin.height + dy);

  // Clamping the origin has to give the width back, or the anchored corner moves.
  if (x < 0) {
    width += x;
    x = 0;
  }
  if (y < 0) {
    height += y;
    y = 0;
  }
  width = Math.min(width, imgW - x);
  height = Math.min(height, imgH - y);
  return {
    x,
    y,
    width: Math.max(MIN_CROP_EDGE, width),
    height: Math.max(MIN_CROP_EDGE, height),
  };
}
