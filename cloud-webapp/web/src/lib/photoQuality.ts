/**
 * photoQuality.ts — a quick, client-side quality check of the reference selfie
 * BEFORE we run a Find Me search, so we can nudge the user toward a better photo
 * instead of letting them burn a search on one that can't match well.
 *
 * This is a cheap browser-side proxy for the matcher's server-side face checks
 * (matcher/quality.py: too_small / too_blurry / low_confidence). The browser
 * can't run the face detector, so we measure the *whole image*:
 *   - resolution  → a low-res photo means the face is small once cropped, which
 *                   maps to the server's `too_small` rejection (MIN_FACE_PX).
 *   - sharpness   → variance of a Laplacian-style high-pass, mirroring
 *                   quality.py's blur_score (variance of Laplacian).
 *   - brightness  → very dark/blown-out photos detect and embed poorly.
 *
 * It is intentionally a *hint*, never a hard gate — the user can always search
 * anyway, and the authoritative check still runs server-side. Thresholds are
 * named constants so they can be tuned against the eval set / feedback data.
 */

export type QualityIssue = 'low_resolution' | 'blurry' | 'dark' | 'bright';

export type QualityLevel = 'good' | 'fair' | 'poor';

export interface PhotoMetrics {
  /** Natural pixel dimensions of the source image (not the scaled canvas). */
  width: number;
  height: number;
  /** Mean luma 0–255. */
  brightness: number;
  /** Variance of a Laplacian high-pass over the (downscaled) luma. Higher =
   *  sharper. Measured on a fixed working size so the scale is stable. */
  sharpness: number;
}

export interface QualityResult {
  level: QualityLevel;
  issues: QualityIssue[];
  metrics: PhotoMetrics;
}

// Short side below this → the face is likely too small to match well. The
// matcher rejects faces under 40px; a face is a fraction of the frame, so we
// want a comfortably larger whole-image floor.
export const MIN_SHORT_SIDE = 500;
// Sharpness is measured on luma downscaled so the long side is WORK_SIZE px, so
// this threshold is comparable across input resolutions. Conservative on
// purpose — only clearly soft photos trip it, to avoid false "blurry" nags.
export const WORK_SIZE = 512;
export const MIN_SHARPNESS = 60;
// Mean-luma bounds for a usable exposure.
export const MIN_BRIGHTNESS = 50;
export const MAX_BRIGHTNESS = 225;

// Issues that genuinely tank match quality → level 'poor' (we interrupt to
// warn). The rest are minor → 'fair' (we don't interrupt).
const SEVERE: ReadonlySet<QualityIssue> = new Set<QualityIssue>(['low_resolution', 'blurry']);

/**
 * Pure classifier — split out from the canvas work so it's unit-testable
 * without a DOM. Maps measured metrics to issues + an overall level.
 */
export function classifyPhotoQuality(m: PhotoMetrics): QualityResult {
  const issues: QualityIssue[] = [];
  if (Math.min(m.width, m.height) < MIN_SHORT_SIDE) issues.push('low_resolution');
  if (m.sharpness < MIN_SHARPNESS) issues.push('blurry');
  if (m.brightness < MIN_BRIGHTNESS) issues.push('dark');
  else if (m.brightness > MAX_BRIGHTNESS) issues.push('bright');

  const hasSevere = issues.some((i) => SEVERE.has(i));
  const level: QualityLevel = hasSevere ? 'poor' : issues.length > 0 ? 'fair' : 'good';
  return { level, issues, metrics: m };
}

/** Load a File into an HTMLImageElement (universally supported, incl. iOS). */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode_failed'));
    };
    img.src = url;
  });
}

/**
 * Measure a photo's quality metrics in the browser. Draws the image to a small
 * working canvas (capped at WORK_SIZE on the long side) and computes mean luma
 * and a 4-neighbour Laplacian variance. Returns null if the image can't be
 * decoded or a canvas isn't available (caller should then just proceed to
 * search — never block on the hint failing).
 */
export async function analyzePhoto(file: File): Promise<QualityResult | null> {
  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    return null;
  }

  const naturalW = img.naturalWidth || img.width;
  const naturalH = img.naturalHeight || img.height;
  if (!naturalW || !naturalH) return null;

  const scale = Math.min(1, WORK_SIZE / Math.max(naturalW, naturalH));
  const w = Math.max(1, Math.round(naturalW * scale));
  const h = Math.max(1, Math.round(naturalH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    URL.revokeObjectURL(img.src);
    return null;
  }
  ctx.drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(img.src);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null; // tainted canvas / not allowed — skip the hint
  }

  // Grayscale (Rec. 601 luma) + running mean.
  const luma = new Float64Array(w * h);
  let sum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const y = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    luma[p] = y;
    sum += y;
  }
  const brightness = sum / (w * h);

  // 4-neighbour Laplacian; report its variance (higher = sharper). Borders are
  // skipped. Falls back to "sharp enough" for images too small to sample.
  let lapSum = 0;
  let lapSqSum = 0;
  let n = 0;
  for (let yy = 1; yy < h - 1; yy += 1) {
    for (let xx = 1; xx < w - 1; xx += 1) {
      const c = yy * w + xx;
      const lap = luma[c - 1]! + luma[c + 1]! + luma[c - w]! + luma[c + w]! - 4 * luma[c]!;
      lapSum += lap;
      lapSqSum += lap * lap;
      n += 1;
    }
  }
  const sharpness = n > 0 ? lapSqSum / n - (lapSum / n) ** 2 : MIN_SHARPNESS;

  return classifyPhotoQuality({ width: naturalW, height: naturalH, brightness, sharpness });
}
