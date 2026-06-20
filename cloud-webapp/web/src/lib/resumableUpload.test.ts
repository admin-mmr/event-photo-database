import { describe, it, expect, vi, afterEach } from 'vitest';
import { committedFromRange, backoffMs, queryOffset } from './resumableUpload.js';

afterEach(() => vi.unstubAllGlobals());

describe('committedFromRange', () => {
  it('returns 0 when the header is absent', () => {
    expect(committedFromRange(null)).toBe(0);
  });

  it('returns N+1 (a count) from a bytes=0-N header', () => {
    // GCS reports the last committed byte index, so 0-0 means 1 byte committed.
    expect(committedFromRange('bytes=0-0')).toBe(1);
    expect(committedFromRange('bytes=0-262143')).toBe(262144);
  });

  it('returns 0 for a malformed / unexpected range header', () => {
    expect(committedFromRange('bytes=*/123')).toBe(0);
    expect(committedFromRange('garbage')).toBe(0);
  });
});

describe('backoffMs', () => {
  it('doubles per attempt starting at 1s', () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(4)).toBe(8000);
  });

  it('caps at 15 seconds', () => {
    expect(backoffMs(5)).toBe(15_000);
    expect(backoffMs(10)).toBe(15_000);
  });
});

describe('queryOffset', () => {
  function res(status: number, rangeHeader?: string): Response {
    return {
      status,
      headers: { get: (h: string) => (h.toLowerCase() === 'range' ? rangeHeader ?? null : null) },
    } as unknown as Response;
  }

  it('returns -1 when GCS reports the upload is already complete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200)));
    expect(await queryOffset('https://gcs/session', 1000)).toBe(-1);
    vi.stubGlobal('fetch', vi.fn(async () => res(201)));
    expect(await queryOffset('https://gcs/session', 1000)).toBe(-1);
  });

  it('parses the committed offset from a 308 Range header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(308, 'bytes=0-511')));
    expect(await queryOffset('https://gcs/session', 1000)).toBe(512);
  });

  it('treats a 308 with no Range header as 0 bytes committed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(308)));
    expect(await queryOffset('https://gcs/session', 1000)).toBe(0);
  });

  it('sends a Content-Range status probe (bytes */total)', async () => {
    const fetchMock = vi.fn(async () => res(308, 'bytes=0-0'));
    vi.stubGlobal('fetch', fetchMock);
    await queryOffset('https://gcs/session', 4096);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['Content-Range']).toBe('bytes */4096');
  });

  it('throws on an unexpected status (e.g. 5xx)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(503)));
    await expect(queryOffset('https://gcs/session', 1000)).rejects.toThrow(/HTTP 503/);
  });
});
