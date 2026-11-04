import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SHRINK_ABOVE_BYTES, SHRINK_EDGES, shrinkForUpload } from './faceCrop.js';

/**
 * jsdom decodes no images and has no canvas, so both are stubbed: `Image` loads
 * (or fails) at a chosen size, and the canvas hands back blobs of chosen sizes,
 * recording the dimensions it was asked to draw at.
 */
let decode: { width: number; height: number } | 'fail';
let blobSizes: number[];
let drawn: Array<{ width: number; height: number }>;

class FakeImage {
  naturalWidth = 0;
  naturalHeight = 0;
  width = 0;
  height = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_url: string) {
    queueMicrotask(() => {
      if (decode === 'fail') return this.onerror?.();
      this.naturalWidth = this.width = decode.width;
      this.naturalHeight = this.height = decode.height;
      this.onload?.();
    });
  }
  get src(): string {
    return 'blob:fake';
  }
}

const realCreateElement = document.createElement.bind(document);

beforeEach(() => {
  decode = { width: 8064, height: 6048 };
  blobSizes = [];
  drawn = [];
  vi.stubGlobal('Image', FakeImage);
  URL.createObjectURL = vi.fn(() => 'blob:fake');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'canvas') return realCreateElement(tag);
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => drawn.push({ width: canvas.width, height: canvas.height }) }),
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob([new Uint8Array(blobSizes.shift() ?? 1024)])),
    };
    return canvas;
  }) as typeof document.createElement);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const MB = 1024 * 1024;
const pick = (bytes: number, name = 'IMG_0001.HEIC.jpg') =>
  new File([new Uint8Array(bytes)], name, { type: 'image/jpeg', lastModified: 1_700_000_000_000 });

describe('shrinkForUpload', () => {
  it('leaves a pick at or under the threshold untouched (same object, no decode)', async () => {
    const f = pick(SHRINK_ABOVE_BYTES);
    expect(await shrinkForUpload(f)).toBe(f);
    expect(drawn).toEqual([]);
  });

  it('re-encodes a full-resolution phone photo with its long edge at the first step', async () => {
    blobSizes = [3 * MB];
    const out = await shrinkForUpload(pick(18 * MB));
    expect(drawn).toEqual([{ width: SHRINK_EDGES[0], height: 3072 }]);
    expect(out.size).toBe(3 * MB);
    expect(out.type).toBe('image/jpeg');
    expect(out.name).toBe('IMG_0001.HEIC.jpg');
    expect(out.lastModified).toBe(1_700_000_000_000);
  });

  it('keeps the orientation of a portrait photo', async () => {
    decode = { width: 6048, height: 8064 };
    blobSizes = [3 * MB];
    await shrinkForUpload(pick(18 * MB));
    expect(drawn).toEqual([{ width: 3072, height: SHRINK_EDGES[0] }]);
  });

  it('steps down once more when the first re-encode is still over the threshold', async () => {
    blobSizes = [7 * MB, 2 * MB];
    const out = await shrinkForUpload(pick(25 * MB));
    expect(drawn.map((d) => d.width)).toEqual([...SHRINK_EDGES]);
    expect(out.size).toBe(2 * MB);
  });

  it('uploads the original when it cannot be shrunk enough — the api then answers 413', async () => {
    blobSizes = [9 * MB, 8 * MB];
    const f = pick(25 * MB);
    expect(await shrinkForUpload(f)).toBe(f);
  });

  it('uploads the original when the browser cannot decode it (e.g. HEIC outside Safari)', async () => {
    decode = 'fail';
    const f = pick(18 * MB, 'IMG_0002.HEIC');
    expect(await shrinkForUpload(f)).toBe(f);
  });

  // 2026-11-04: a Windows Chrome user's picks were refused as unsupported.
  // A type the api does not take is re-encoded even when it is small.
  it('re-encodes a small pick of a type the api does not take', async () => {
    decode = { width: 1200, height: 1600 };
    blobSizes = [400 * 1024];
    const avif = new File([new Uint8Array(900 * 1024)], 'selfie.avif', { type: 'image/avif' });
    const out = await shrinkForUpload(avif);
    expect(out.type).toBe('image/jpeg');
    expect(out.name).toBe('selfie.jpg');
    expect(drawn).toEqual([{ width: 1200, height: 1600 }]); // never upscaled
  });

  it('sends an unlabelled pick it cannot decode as picked, for the api to identify', async () => {
    decode = 'fail';
    const heic = new File([new Uint8Array(2 * MB)], 'IMG_0003.HEIC', { type: '' });
    expect(await shrinkForUpload(heic)).toBe(heic);
  });
});

