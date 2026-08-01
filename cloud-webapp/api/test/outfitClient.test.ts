import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * outfitClient talks to a service that deploys independently of the api, so its
 * contract is: never let a missing or surprising field throw mid-request, and
 * never silently pretend the service is configured when it isn't. These cover
 * that, plus the form fields the service actually reads.
 *
 * The ID-token mint and the HTTP call are stubbed — no network.
 */

const env: { OUTFIT_URL: string } = { OUTFIT_URL: 'http://localhost:8082' };

vi.mock('../src/lib/config.js', () => ({ env }));
vi.mock('../src/lib/googleCredentials.js', () => ({
  getIdTokenHeaders: async () => ({}),
}));

const { outfitDetect, outfitStatus } = await import('../src/services/outfitClient.js');

interface SentRequest {
  url: string;
  init: RequestInit | undefined;
}

/** Stub fetch and capture the request the client made. */
function reply(status: number, body: unknown): SentRequest[] {
  const calls: SentRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

function firstCall(calls: SentRequest[]): SentRequest {
  const call = calls[0];
  if (!call) throw new Error('expected the client to have called fetch');
  return call;
}

function sentForm(calls: SentRequest[]): FormData {
  return firstCall(calls).init?.body as FormData;
}

describe('outfitDetect', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    env.OUTFIT_URL = 'http://localhost:8082';
  });

  it('sends the query fields the service reads', async () => {
    const calls = reply(200, { results: [] });
    await outfitDetect({
      eventId: 'ev1',
      text: 'orange singlet',
      textWeight: 0.4,
      samplePhotoIds: ['p1', 'p2'],
      region: 'head',
      topK: 25,
      minScore: 2.5,
      includeSmall: true,
    });

    expect(firstCall(calls).url).toBe('http://localhost:8082/detect');
    const form = sentForm(calls);
    expect(form.get('event_id')).toBe('ev1');
    expect(form.get('text')).toBe('orange singlet');
    expect(form.get('text_weight')).toBe('0.4');
    expect(form.get('sample_photo_ids')).toBe('p1,p2');
    expect(form.get('region')).toBe('head');
    expect(form.get('top_k')).toBe('25');
    expect(form.get('min_score')).toBe('2.5');
    expect(form.get('include_small')).toBe('1');
  });

  it('omits optional fields that were not supplied', async () => {
    const calls = reply(200, { results: [] });
    await outfitDetect({ eventId: 'ev1', text: 'kit' });
    const form = sentForm(calls);
    expect(form.get('text_weight')).toBeNull();
    expect(form.get('min_score')).toBeNull();
    expect(form.get('include_small')).toBeNull();
    expect(form.get('sample_photo_ids')).toBeNull();
  });

  it('uploads sample images as repeated file fields', async () => {
    const calls = reply(200, { results: [] });
    await outfitDetect({
      eventId: 'ev1',
      samples: [
        { image: Buffer.from('a'), filename: 'a.jpg', contentType: 'image/jpeg' },
        { image: Buffer.from('b'), filename: 'b.jpg', contentType: 'image/jpeg' },
      ],
    });
    const form = sentForm(calls);
    expect(form.getAll('file')).toHaveLength(2);
  });

  it('parses a full response', async () => {
    reply(200, {
      eventId: 'ev1',
      modelVersion: 'siglip@o1',
      region: 'head',
      scoreUnit: 'zscore',
      textWeight: 0.35,
      sampleCount: 2,
      samplePhotoIds: ['p1'],
      unknownPhotoIds: ['ghost'],
      cohortSize: 120,
      textAdvisory: 'the description mentions headphone',
      results: [
        { photoId: 'p9', score: 3.2, region: 'head', box: [1, 2, 3, 4], sampleScore: 3.0, textScore: 1.1 },
      ],
    });
    const res = await outfitDetect({ eventId: 'ev1', text: 'x' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.modelVersion).toBe('siglip@o1');
    expect(res.cohortSize).toBe(120);
    expect(res.unknownPhotoIds).toEqual(['ghost']);
    expect(res.textAdvisory).toContain('headphone');
    expect(res.results[0]?.photoId).toBe('p9');
  });

  it('tolerates a response missing every optional field', async () => {
    // The outfit-tagger deploys separately from the api; an older revision that
    // omits these must degrade to defaults, not throw mid-request.
    reply(200, {});
    const res = await outfitDetect({ eventId: 'ev1', text: 'x', region: 'person' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.eventId).toBe('ev1');
    expect(res.region).toBe('person');
    expect(res.scoreUnit).toBe('zscore');
    expect(res.textWeight).toBeNull();
    expect(res.sampleCount).toBe(0);
    expect(res.samplePhotoIds).toEqual([]);
    expect(res.results).toEqual([]);
    expect(res.textAdvisory).toBeUndefined();
  });

  it('ignores a results field of the wrong shape rather than throwing', async () => {
    reply(200, { results: 'nope' });
    const res = await outfitDetect({ eventId: 'ev1', text: 'x' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.results).toEqual([]);
  });

  it('surfaces an upstream error with its error string preserved', async () => {
    reply(404, { error: 'event_not_prepared', detail: 'run the prepare job' });
    const res = await outfitDetect({ eventId: 'ev1', text: 'x' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(404);
    expect(res.error).toBe('event_not_prepared');
    expect(res.message).toBe('run the prepare job');
  });

  it('falls back to a generic message when the upstream body is unhelpful', async () => {
    reply(500, {});
    const res = await outfitDetect({ eventId: 'ev1', text: 'x' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('outfit_error');
    expect(res.message).toContain('500');
  });

  it('reports an unreachable service as 502, not a thrown error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const res = await outfitDetect({ eventId: 'ev1', text: 'x' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(502);
    expect(res.error).toBe('outfit_unreachable');
    expect(res.message).toContain('ECONNREFUSED');
  });

  it('503s without calling out when OUTFIT_URL is unset', async () => {
    env.OUTFIT_URL = '';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await outfitDetect({ eventId: 'ev1', text: 'x' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(503);
    expect(res.error).toBe('outfit_unconfigured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a query with no samples, ids, or text before calling out', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await outfitDetect({ eventId: 'ev1' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('missing_query');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats whitespace-only text as no text', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await outfitDetect({ eventId: 'ev1', text: '   ' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('missing_query');
  });

  it('strips a trailing slash from the base URL', async () => {
    env.OUTFIT_URL = 'http://localhost:8082/';
    const calls = reply(200, { results: [] });
    await outfitDetect({ eventId: 'ev1', text: 'x' });
    expect(firstCall(calls).url).toBe('http://localhost:8082/detect');
  });
});

describe('outfitStatus', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    env.OUTFIT_URL = 'http://localhost:8082';
  });

  it('url-encodes the event id', async () => {
    const calls = reply(200, { prepared: false });
    await outfitStatus('ev 1/2');
    expect(firstCall(calls).url).toBe('http://localhost:8082/status?event_id=ev%201%2F2');
  });

  it('reports an unprepared event as prepared: false, not an error', async () => {
    reply(200, { eventId: 'ev1', prepared: false });
    const res = await outfitStatus('ev1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.prepared).toBe(false);
    expect(res.crops).toBeUndefined();
  });

  it('parses a prepared event', async () => {
    reply(200, {
      eventId: 'ev1',
      prepared: true,
      crops: 3200,
      regions: { person: 1700, head: 1500 },
      photos: 1600,
      modelVersion: 'siglip@o1',
      sourceModelVersion: 'm1',
      skipped: 4,
    });
    const res = await outfitStatus('ev1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.crops).toBe(3200);
    expect(res.regions).toEqual({ person: 1700, head: 1500 });
    expect(res.sourceModelVersion).toBe('m1');
    expect(res.skipped).toBe(4);
  });

  it('503s when OUTFIT_URL is unset', async () => {
    env.OUTFIT_URL = '';
    const res = await outfitStatus('ev1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('outfit_unconfigured');
  });
});
