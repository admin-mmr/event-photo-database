/**
 * The point of these tests is the SHAPE of the network traffic as much as the
 * returned blob: the byte read must go straight to the signed GCS URL, with no
 * api path involved and no Authorization header riding along. Following the
 * api's cross-origin 302 instead is what broke Save-to-Photos on iOS Safari.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { OriginalsFetcher } from './originals.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * OriginalsFetcher — the guarantees the "Preparing…" fix rests on.
 *
 * Three paths want the same originals (mobile prefetch, save fallback, ZIP) and
 * each used to fetch independently, so a phone downloaded the same
 * multi-megabyte photo two or three times over one connection with no
 * concurrency cap. "Preparing…" sat for minutes, and when the duplicated
 * transfers failed together the user got "could not load any of the selected
 * photos". So: one signing call per batch, never a second transfer for a photo
 * already cached or in flight, and a hard cap on simultaneous transfers.
 */
describe('OriginalsFetcher', () => {
  /** Batch-sign stub: JSON of signed URLs for the api call, bytes for GCS. */
  interface FetcherStub {
    signCalls: Array<{ url: string; photoIds: string[] }>;
    byteReads: string[];
    byteReadHeaders: Record<string, string>[];
    peakInFlight: () => number;
    openGates: () => void;
  }

  function stubBatch(
    opts: { gated?: boolean; failUrl?: (url: string) => boolean; dropIds?: string[]; signFails?: boolean } = {},
  ): FetcherStub {
    const signCalls: Array<{ url: string; photoIds: string[] }> = [];
    const byteReads: string[] = [];
    const byteReadHeaders: Record<string, string>[] = [];
    let inFlight = 0;
    let peak = 0;
    let gates: (() => void)[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/__/firebase/')) {
          return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
        }

        if (url.includes('/originals/sign')) {
          if (opts.signFails) return { ok: false, status: 429, json: async () => ({}) } as unknown as Response;
          const ids = (JSON.parse(String(init?.body ?? '{}')) as { photoIds: string[] }).photoIds;
          signCalls.push({ url, photoIds: ids });
          const kept = ids.filter((id) => !(opts.dropIds ?? []).includes(id));
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              files: kept.map((photoId) => ({
                photoId,
                url: `https://storage.googleapis.com/derivatives/${photoId}`,
                filename: `${photoId}.jpg`,
              })),
            }),
          } as unknown as Response;
        }

        byteReads.push(url);
        byteReadHeaders.push(
          Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
        );
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          if (opts.gated) await new Promise<void>((resolve) => gates.push(resolve));
          if (opts.failUrl?.(url)) return { ok: false, status: 403 } as unknown as Response;
          return {
            ok: true,
            status: 200,
            blob: async () => new Blob([url], { type: 'image/jpeg' }),
          } as unknown as Response;
        } finally {
          inFlight -= 1;
        }
      }),
    );

    return {
      signCalls,
      byteReads,
      byteReadHeaders,
      peakInFlight: () => peak,
      openGates: () => {
        const pending = gates;
        gates = [];
        for (const g of pending) g();
      },
    };
  }

  beforeEach(() => vi.unstubAllGlobals());

  it('reads bytes straight from the signed GCS URL, never through an /api path', async () => {
    const s = stubBatch();
    await new OriginalsFetcher('ev1').fetch(['p1']);

    expect(s.byteReads).toHaveLength(1);
    expect(s.byteReads[0]!).toMatch(/^https:\/\/storage\.googleapis\.com\//);
    expect(s.byteReads[0]!.startsWith('/api')).toBe(false);
  });

  it('sends no Authorization header on the byte read', async () => {
    // The signed URL carries its own auth and GCS rejects a request presenting
    // both — the failure mode that broke Save-to-Photos on iOS Safari.
    const s = stubBatch();
    await new OriginalsFetcher('ev1').fetch(['p1']);

    const headerNames = Object.keys(s.byteReadHeaders[0] ?? {}).map((h) => h.toLowerCase());
    expect(headerNames).not.toContain('authorization');
  });

  it('url-encodes the event id so it cannot escape the sign path', async () => {
    const s = stubBatch();
    await new OriginalsFetcher('ev/1').fetch(['p1']);
    expect(s.signCalls[0]!.url).toContain('/api/events/ev%2F1/originals/sign');
  });

  it('signs the whole batch in ONE call, not one per photo', async () => {
    const s = stubBatch();
    await new OriginalsFetcher('ev1').fetch(['p1', 'p2', 'p3', 'p4']);

    expect(s.signCalls).toHaveLength(1);
    expect(s.signCalls[0]!.photoIds).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('never transfers a photo twice across repeated calls', async () => {
    const s = stubBatch();
    const f = new OriginalsFetcher('ev1');

    await f.fetch(['p1', 'p2']);
    // The save fallback, then the ZIP, asking for the same selection.
    await f.fetch(['p1', 'p2']);
    await f.fetch(['p1', 'p2']);

    expect(s.byteReads).toHaveLength(2);
    expect(s.signCalls).toHaveLength(1); // no redundant signing either
  });

  it('joins an in-flight transfer instead of starting a second one', async () => {
    const s = stubBatch({ gated: true });
    const f = new OriginalsFetcher('ev1');

    // Prefetch starts; the user taps Save before it finishes.
    const prefetch = f.fetch(['p1']);
    await vi.waitFor(() => expect(s.byteReads).toHaveLength(1));
    const save = f.fetch(['p1']);
    s.openGates();
    const [a, b] = await Promise.all([prefetch, save]);

    expect(s.byteReads).toHaveLength(1); // joined, not duplicated
    expect(a.entries[0]!.blob).toBe(b.entries[0]!.blob); // same bytes, shared
  });

  it('caps how many transfers run at once', async () => {
    const s = stubBatch();
    await new OriginalsFetcher('ev1').fetch(Array.from({ length: 12 }, (_, i) => `p${i}`));

    expect(s.byteReads).toHaveLength(12);
    expect(s.peakInFlight()).toBeLessThanOrEqual(3);
  });

  it('returns entries in the requested order, named by the server', async () => {
    stubBatch();
    const { entries } = await new OriginalsFetcher('ev1').fetch(['p3', 'p1', 'p2']);
    expect(entries.map((e) => e.filename)).toEqual(['p3.jpg', 'p1.jpg', 'p2.jpg']);
  });

  it('reports per-photo failures without sinking the rest', async () => {
    stubBatch({ failUrl: (url) => url.endsWith('p2') });
    const settled: Array<[string, boolean]> = [];

    const res = await new OriginalsFetcher('ev1').fetch(['p1', 'p2', 'p3'], {
      onSettled: (id, entry) => settled.push([id, entry !== null]),
    });

    expect(res.entries).toHaveLength(2);
    expect(res.failed).toBe(1);
    expect(res.sampleErrors).toContain('HTTP 403');
    expect(settled.sort()).toEqual([
      ['p1', true],
      ['p2', false],
      ['p3', true],
    ]);
  });

  it('reports every id as failed when signing itself fails', async () => {
    const s = stubBatch({ signFails: true });
    const res = await new OriginalsFetcher('ev1').fetch(['p1', 'p2']);

    expect(res.entries).toHaveLength(0);
    expect(res.failed).toBe(2);
    expect(s.byteReads).toHaveLength(0);
  });

  it('counts an id the server would not sign as failed, not as pending', async () => {
    // The server drops p2 — deleted, or not part of this event.
    stubBatch({ dropIds: ['p2'] });
    const res = await new OriginalsFetcher('ev1').fetch(['p1', 'p2']);

    expect(res.entries).toHaveLength(1);
    expect(res.failed).toBe(1);
  });

  it('retains only the photos still selected, and refetches a dropped one', async () => {
    const s = stubBatch();
    const f = new OriginalsFetcher('ev1');
    await f.fetch(['p1', 'p2']);

    expect(f.retain(['p1'])).toBe(true);
    expect(f.get('p1')).toBeDefined();
    expect(f.get('p2')).toBeUndefined();
    expect(f.countCached(['p1', 'p2'])).toBe(1);

    await f.fetch(['p2']);
    expect(s.byteReads.filter((u) => u.endsWith('p2'))).toHaveLength(2);
  });

  it('abort() cancels transfers still queued behind the cap', async () => {
    const s = stubBatch({ gated: true });
    const f = new OriginalsFetcher('ev1');

    const pending = f.fetch(['p1', 'p2', 'p3', 'p4', 'p5']);
    await vi.waitFor(() => expect(s.byteReads).toHaveLength(3)); // cap reached
    f.abort();
    s.openGates();
    await pending;

    // The two still queued never started a transfer.
    expect(s.byteReads).toHaveLength(3);
  });
});
