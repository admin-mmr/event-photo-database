import { describe, it, expect, vi } from 'vitest';
import { FINDME_MAX_FILE_BYTES } from '@cloud-webapp/shared';

import {
  DOWNSCALE_ABOVE_BYTES,
  DOWNSCALE_MAX_EDGE,
  MAX_SELFIE_MB,
  fitSelfieForUpload,
  oversizedSelfies,
} from './selfieUpload.js';

/** A File that reports `size` without allocating it. */
function fileOfSize(size: number, name = 'IMG_0001.HEIC', type = 'image/heic'): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

describe('fitSelfieForUpload', () => {
  it('leaves a pick that already fits untouched (no re-encode, EXIF kept)', async () => {
    const render = vi.fn();
    const f = fileOfSize(DOWNSCALE_ABOVE_BYTES);
    expect(await fitSelfieForUpload(f, render)).toBe(f);
    expect(render).not.toHaveBeenCalled();
  });

  it('downscales a big pick to the max edge, whole frame, as a JPEG', async () => {
    const small = fileOfSize(3 * 1024 * 1024, 'x-cropped.jpg', 'image/jpeg');
    const render = vi.fn().mockResolvedValue(small);
    const out = await fitSelfieForUpload(fileOfSize(20 * 1024 * 1024), render);

    const [, rect, maxEdge] = render.mock.calls[0]!;
    expect(maxEdge).toBe(DOWNSCALE_MAX_EDGE);
    // Unbounded, so clampRect trims it to the whole bitmap.
    expect(rect).toMatchObject({ x: 0, y: 0, width: Infinity, height: Infinity });
    expect(out.name).toBe('IMG_0001.jpg');
    expect(out.type).toBe('image/jpeg');
  });

  it('keeps the original when the browser cannot decode it', async () => {
    const big = fileOfSize(20 * 1024 * 1024);
    expect(await fitSelfieForUpload(big, vi.fn().mockResolvedValue(null))).toBe(big);
    expect(await fitSelfieForUpload(big, vi.fn().mockRejectedValue(new Error('boom')))).toBe(big);
  });

  it('keeps the original when the re-encode is no smaller', async () => {
    const big = fileOfSize(8 * 1024 * 1024);
    const bigger = fileOfSize(9 * 1024 * 1024, 'a.jpg', 'image/jpeg');
    expect(await fitSelfieForUpload(big, vi.fn().mockResolvedValue(bigger))).toBe(big);
  });
});

describe('oversizedSelfies', () => {
  it('flags exactly the picks past the api cap', () => {
    const ok = fileOfSize(FINDME_MAX_FILE_BYTES);
    const over = fileOfSize(FINDME_MAX_FILE_BYTES + 1);
    expect(oversizedSelfies([ok, over])).toEqual([over]);
  });

  it('names the cap in whole MB', () => {
    expect(MAX_SELFIE_MB).toBe(15);
  });
});
