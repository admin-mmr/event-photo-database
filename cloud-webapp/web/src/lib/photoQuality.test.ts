import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  analyzePhoto,
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

/**
 * `analyzePhoto` mints a blob URL per call. Every exit path must revoke it —
 * an un-revoked URL pins the whole File in memory for the life of the page,
 * and the Find-Me flow analyzes a selfie on every pick/retake.
 */
describe('analyzePhoto object-URL lifetime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Stub createObjectURL/revokeObjectURL + Image; returns the revoke spy. */
  function stubImageLoad(dims: { naturalWidth: number; naturalHeight: number }) {
    const revoke = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:stub-url'),
      revokeObjectURL: revoke,
    });
    class StubImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = dims.naturalWidth;
      naturalHeight = dims.naturalHeight;
      width = dims.naturalWidth;
      height = dims.naturalHeight;
      #src = '';
      set src(v: string) {
        this.#src = v;
        queueMicrotask(() => this.onload?.());
      }
      get src() {
        return this.#src;
      }
    }
    vi.stubGlobal('Image', StubImage);
    return revoke;
  }

  const file = () => new File([new Uint8Array([1, 2, 3])], 'selfie.jpg', { type: 'image/jpeg' });

  it('revokes the blob URL when the image reports zero dimensions', async () => {
    const revoke = stubImageLoad({ naturalWidth: 0, naturalHeight: 0 });
    await expect(analyzePhoto(file())).resolves.toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:stub-url');
  });

  it('revokes the blob URL when no 2d canvas context is available', async () => {
    const revoke = stubImageLoad({ naturalWidth: 800, naturalHeight: 600 });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await expect(analyzePhoto(file())).resolves.toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:stub-url');
  });
});
