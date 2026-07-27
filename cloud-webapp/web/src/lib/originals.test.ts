/**
 * The point of these tests is the SHAPE of the network traffic, not just the
 * returned blob: the byte read must go straight to the signed GCS URL, with no
 * api path involved and no Authorization header riding along. Following the
 * api's cross-origin 302 instead is what broke Save-to-Photos on iOS Safari.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { fetchOriginalBlob, signOriginal } from './originals.js';

const SIGNED = 'https://storage.googleapis.com/derivatives/ev1/p1.jpg?X-Goog-Signature=abc';

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Stub fetch: JSON for the api sign call, bytes for the signed URL. */
function stubFetch(opts: { signStatus?: number; blobStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    // The firebase SDK lazily fetches its own config the first time we ask for
    // an ID token; that's test-harness noise, not traffic under test.
    if (url.includes('/__/firebase/')) {
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }
    calls.push({ url, headers });

    if (url.startsWith('https://storage.googleapis.com/')) {
      const status = opts.blobStatus ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        blob: async () => new Blob(['PHOTO-BYTES'], { type: 'image/jpeg' }),
      } as unknown as Response;
    }
    const status = opts.signStatus ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ ok: true, url: SIGNED, filename: 'IMG_001.jpg' }),
      text: async () => '',
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('signOriginal', () => {
  it('asks the api for JSON rather than a redirect', async () => {
    const calls = stubFetch();
    const out = await signOriginal('ev1', 'p1');
    expect(out).toEqual({ url: SIGNED, filename: 'IMG_001.jpg' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/api/events/ev1/photos/p1/original');
    expect(calls[0]!.url).toContain('format=json');
  });

  it('url-encodes ids so a slash cannot escape the path', async () => {
    const calls = stubFetch();
    await signOriginal('ev/1', 'p 1');
    expect(calls[0]!.url).toContain('/api/events/ev%2F1/photos/p%201/original');
  });
});

describe('fetchOriginalBlob', () => {
  it('reads the bytes straight from the signed URL, not through the api', async () => {
    const calls = stubFetch();
    const blob = await fetchOriginalBlob('ev1', 'p1');
    expect(blob.type).toBe('image/jpeg');

    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe(SIGNED);
    // The byte read is a plain cross-origin GET. No Authorization header: the
    // signed URL carries its own auth, and GCS rejects a request that presents
    // both.
    expect(Object.keys(calls[1]!.headers)).toHaveLength(0);
  });

  it('never routes the byte read through an /api path', async () => {
    const calls = stubFetch();
    await fetchOriginalBlob('ev1', 'p1');
    const byteRead = calls[calls.length - 1]!;
    expect(byteRead.url.startsWith('/api')).toBe(false);
    expect(byteRead.url).toMatch(/^https:\/\/storage\.googleapis\.com\//);
  });

  it('throws when the signed URL itself fails (e.g. a CORS/403 on the bucket)', async () => {
    stubFetch({ blobStatus: 403 });
    await expect(fetchOriginalBlob('ev1', 'p1')).rejects.toThrow(/HTTP 403/);
  });

  it('throws when the api will not sign', async () => {
    stubFetch({ signStatus: 404 });
    await expect(fetchOriginalBlob('ev1', 'p1')).rejects.toThrow();
  });
});
