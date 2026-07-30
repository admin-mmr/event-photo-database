import { describe, it, expect } from 'vitest';
import { cropRect, CROP_PADDING } from './faceCrop.js';

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
