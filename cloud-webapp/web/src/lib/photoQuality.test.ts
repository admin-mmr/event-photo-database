import { describe, it, expect } from 'vitest';
import {
  classifyPhotoQuality,
  MIN_SHORT_SIDE,
  MIN_SHARPNESS,
  MIN_BRIGHTNESS,
  MAX_BRIGHTNESS,
  type PhotoMetrics,
} from './photoQuality.js';

// A comfortably good baseline; individual tests override one axis at a time.
function metrics(over: Partial<PhotoMetrics> = {}): PhotoMetrics {
  return { width: 1200, height: 1600, brightness: 130, sharpness: 500, ...over };
}

describe('classifyPhotoQuality', () => {
  it('passes a clear, well-lit, high-res photo as good', () => {
    const r = classifyPhotoQuality(metrics());
    expect(r.level).toBe('good');
    expect(r.issues).toEqual([]);
  });

  it('flags low resolution as a severe (poor) issue', () => {
    const r = classifyPhotoQuality(metrics({ width: 320, height: 400 }));
    expect(r.issues).toContain('low_resolution');
    expect(r.level).toBe('poor');
  });

  it('treats the short side, not the long side, as the resolution gate', () => {
    // Tall but narrow: long side is huge, short side is below the floor.
    const r = classifyPhotoQuality(metrics({ width: 300, height: 4000 }));
    expect(r.issues).toContain('low_resolution');
  });

  it('does not flag a photo exactly at the resolution floor', () => {
    const r = classifyPhotoQuality(metrics({ width: MIN_SHORT_SIDE, height: MIN_SHORT_SIDE }));
    expect(r.issues).not.toContain('low_resolution');
  });

  it('flags a blurry photo as severe (poor)', () => {
    const r = classifyPhotoQuality(metrics({ sharpness: MIN_SHARPNESS - 1 }));
    expect(r.issues).toContain('blurry');
    expect(r.level).toBe('poor');
  });

  it('treats dark/bright as minor (fair), not poor', () => {
    const dark = classifyPhotoQuality(metrics({ brightness: MIN_BRIGHTNESS - 10 }));
    expect(dark.issues).toContain('dark');
    expect(dark.level).toBe('fair');

    const bright = classifyPhotoQuality(metrics({ brightness: MAX_BRIGHTNESS + 10 }));
    expect(bright.issues).toContain('bright');
    expect(bright.level).toBe('fair');
  });

  it('combines a severe and a minor issue, staying poor', () => {
    const r = classifyPhotoQuality(metrics({ width: 200, height: 200, brightness: 20 }));
    expect(r.issues).toEqual(expect.arrayContaining(['low_resolution', 'dark']));
    expect(r.level).toBe('poor');
  });
});
