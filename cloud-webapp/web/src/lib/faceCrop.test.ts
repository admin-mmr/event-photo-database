import { describe, it, expect } from 'vitest';
import {
  cropRect,
  CROP_PADDING,
  suggestedPortraitRect,
  clampRect,
  CROP_FACE_WIDTHS,
  PORTRAIT_ASPECT,
  resizeRect,
  MIN_CROP_EDGE,
  type NormBox,
} from './faceCrop.js';

/**
 * The geometry is the part worth testing without a DOM: an off-by-one here puts
 * the crop on someone's shoulder and the "is this you?" prompt becomes useless.
 */
describe('cropRect', () => {
  it('centres a square on the face and pads it', () => {
    // 100px face centred at (500, 500) in a 1000×1000 image.
    const { sx, sy, size } = cropRect([0.45, 0.45, 0.55, 0.55], 1000, 1000);
    expect(size).toBeCloseTo(100 * (1 + CROP_PADDING));
    expect(sx + size / 2).toBeCloseTo(500);
    expect(sy + size / 2).toBeCloseTo(500);
  });

  it('squares off a non-square face box using its longer side', () => {
    // Tall box: 100 wide, 200 high — the crop follows the 200.
    const { size } = cropRect([0.45, 0.4, 0.55, 0.6], 1000, 1000);
    expect(size).toBeCloseTo(200 * (1 + CROP_PADDING));
  });

  it('slides a face near the edge inward instead of sampling off-bitmap', () => {
    // Face hard against the top-left corner.
    const { sx, sy, size } = cropRect([0.0, 0.0, 0.1, 0.1], 1000, 1000);
    expect(sx).toBe(0);
    expect(sy).toBe(0);
    expect(size).toBeGreaterThan(0);
  });

  it('keeps the crop inside the image on the far edges too', () => {
    const { sx, sy, size } = cropRect([0.9, 0.9, 1.0, 1.0], 1000, 800);
    expect(sx + size).toBeLessThanOrEqual(1000);
    expect(sy + size).toBeLessThanOrEqual(800);
  });

  it('never exceeds the image, even for a face that fills the frame', () => {
    const { sx, sy, size } = cropRect([0, 0, 1, 1], 640, 480);
    expect(size).toBe(480); // clamped to the short side
    expect(sx).toBeGreaterThanOrEqual(0);
    expect(sy).toBeGreaterThanOrEqual(0);
    expect(sx + size).toBeLessThanOrEqual(640);
  });

  it('degenerate boxes still yield a drawable rect', () => {
    const { size } = cropRect([0.5, 0.5, 0.5, 0.5], 1000, 1000);
    expect(size).toBeGreaterThanOrEqual(1);
  });
});

describe('suggestedPortraitRect (the crop we upload)', () => {
  // 1000x1000 image, 100px face centred at (500, 400).
  const face: NormBox = [0.45, 0.35, 0.55, 0.45];

  it('is far wider than the face, so the outfit signal survives', () => {
    const r = suggestedPortraitRect(face, 1000, 1000);
    expect(r.width).toBeCloseTo(100 * CROP_FACE_WIDTHS);
    // The whole point: a tight face box would leave the person embedder nothing.
    expect(r.width).toBeGreaterThan(100 * 2);
  });

  it('is portrait, with the face high and torso below', () => {
    const r = suggestedPortraitRect(face, 1000, 1000);
    expect(r.width / r.height).toBeCloseTo(PORTRAIT_ASPECT);
    const faceCy = 400;
    const below = r.y + r.height - faceCy;
    const above = faceCy - r.y;
    expect(below).toBeGreaterThan(above); // more room under the chin than over the head
  });

  it('shrinks to fit rather than sliding the face out of frame', () => {
    // Face hard against the top-left of a small image.
    const r = suggestedPortraitRect([0.0, 0.0, 0.2, 0.2], 200, 200);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(200);
    expect(r.y + r.height).toBeLessThanOrEqual(200);
  });

  it('never exceeds the image on either axis', () => {
    for (const [w, h] of [[400, 3000], [3000, 400], [640, 480]] as const) {
      const r = suggestedPortraitRect(face, w, h);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(w + 1e-6);
      expect(r.y + r.height).toBeLessThanOrEqual(h + 1e-6);
    }
  });

  it('keeps the graded face inside the crop', () => {
    for (const f of [[0.45, 0.35, 0.55, 0.45], [0.0, 0.0, 0.1, 0.1], [0.9, 0.85, 1.0, 0.95]] as const) {
      const r = suggestedPortraitRect(f, 1000, 800);
      const fx = ((f[0] + f[2]) / 2) * 1000;
      const fy = ((f[1] + f[3]) / 2) * 800;
      expect(fx).toBeGreaterThanOrEqual(r.x - 1e-6);
      expect(fx).toBeLessThanOrEqual(r.x + r.width + 1e-6);
      expect(fy).toBeGreaterThanOrEqual(r.y - 1e-6);
      expect(fy).toBeLessThanOrEqual(r.y + r.height + 1e-6);
    }
  });
});

describe('clampRect', () => {
  it('slides an out-of-bounds rect back inside', () => {
    expect(clampRect({ x: -50, y: -50, width: 100, height: 100 }, 500, 500))
      .toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(clampRect({ x: 480, y: 480, width: 100, height: 100 }, 500, 500))
      .toEqual({ x: 400, y: 400, width: 100, height: 100 });
  });

  it('shrinks a rect larger than the image', () => {
    const r = clampRect({ x: 0, y: 0, width: 900, height: 900 }, 500, 400);
    expect(r).toEqual({ x: 0, y: 0, width: 500, height: 400 });
  });
});

describe('resizeRect (crop editor corner drag)', () => {
  const origin = { x: 100, y: 100, width: 200, height: 200 };

  it('grows from the south-east corner, holding the north-west still', () => {
    const r = resizeRect(origin, 'se', 50, 30, 1000, 1000);
    expect(r.x).toBe(100);
    expect(r.y).toBe(100);
    expect(r.width).toBe(250);
    expect(r.height).toBe(230);
  });

  it('grows from the north-west corner, holding the south-east still', () => {
    const r = resizeRect(origin, 'nw', -50, -50, 1000, 1000);
    expect(r.x).toBe(50);
    expect(r.y).toBe(50);
    expect(r.x + r.width).toBe(300); // opposite corner unmoved
    expect(r.y + r.height).toBe(300);
  });

  it('refuses to invert when a corner is dragged past its opposite', () => {
    const r = resizeRect(origin, 'nw', 500, 500, 1000, 1000);
    expect(r.width).toBeGreaterThanOrEqual(MIN_CROP_EDGE);
    expect(r.height).toBeGreaterThanOrEqual(MIN_CROP_EDGE);
    expect(r.x + r.width).toBeLessThanOrEqual(300);
  });

  it('holds the anchored corner when clamped at the image edge', () => {
    // Drag NW far past the top-left: the SE corner must not creep.
    const r = resizeRect(origin, 'nw', -500, -500, 1000, 1000);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.x + r.width).toBe(300);
    expect(r.y + r.height).toBe(300);
  });

  it('stops at the far edges instead of overflowing', () => {
    const r = resizeRect(origin, 'se', 5000, 5000, 400, 350);
    expect(r.x + r.width).toBeLessThanOrEqual(400);
    expect(r.y + r.height).toBeLessThanOrEqual(350);
  });

  it('never returns a rect outside the image, for any drag', () => {
    for (const h of ['nw', 'ne', 'sw', 'se'] as const) {
      for (const [dx, dy] of [[-999, -999], [999, 999], [-999, 999], [999, -999]] as const) {
        const r = resizeRect(origin, h, dx, dy, 500, 500);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.width).toBeLessThanOrEqual(500 + 1e-9);
        expect(r.y + r.height).toBeLessThanOrEqual(500 + 1e-9);
      }
    }
  });
});
