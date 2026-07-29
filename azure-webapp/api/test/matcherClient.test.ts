import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * matcherClient's job on the response side is to turn the matcher's untyped
 * JSON into typed diagnostics WITHOUT ever letting a shape surprise break a
 * search: the ranking is the payload, the face census and rejection reasons are
 * only there so the UI can talk to the searcher. These cover that contract.
 *
 * The ID-token mint and the HTTP call are stubbed — no network.
 */

vi.mock('../src/lib/config.js', () => ({
  env: { MATCHER_URL: 'http://localhost:8081' },
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getIdTokenClient() {
      return Promise.resolve({ getRequestHeaders: async () => ({}) });
    }
  },
}));

const { matcherSearch } = await import('../src/services/matcherClient.js');

const IMAGE = { image: Buffer.from('jpeg'), filename: 'a.jpg', contentType: 'image/jpeg' };

function reply(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe('matcherSearch — reference face census', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('passes a well-formed census through', async () => {
    reply(200, {
      results: [],
      referenceFaces: [
        {
          faces: 2,
          usableFaces: 1,
          selectedFace: [0.1, 0.2, 0.3, 0.4],
          selectedWarnings: ['not_frontal'],
          blockingReasons: [],
        },
      ],
    });
    const res = await matcherSearch({ ...IMAGE, eventId: 'ev1' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.referenceFaces).toEqual([
      {
        faces: 2,
        usableFaces: 1,
        selectedFace: [0.1, 0.2, 0.3, 0.4],
        selectedWarnings: ['not_frontal'],
        blockingReasons: [],
      },
    ]);
  });

  it('drops codes it has no wording for instead of failing the search', async () => {
    reply(200, {
      results: [{ photoId: 'p1', score: 0.9, faceScore: 0.9, personScore: null }],
      referenceFaces: [
        {
          faces: 1,
          usableFaces: 1,
          selectedFace: null,
          selectedWarnings: ['not_frontal', 'wearing_a_hat'],
        },
      ],
    });
    const res = await matcherSearch({ ...IMAGE, eventId: 'ev1' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.referenceFaces?.[0]?.selectedWarnings).toEqual(['not_frontal']);
    expect(res.results).toHaveLength(1); // the ranking is untouched
  });

  it('omits the census entirely when the matcher predates it', async () => {
    reply(200, { results: [] });
    const res = await matcherSearch({ ...IMAGE, eventId: 'ev1' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.referenceFaces).toBeUndefined();
  });

  it('degrades a malformed census to "no census" and still returns results', async () => {
    reply(200, {
      results: [{ photoId: 'p1', score: 0.9, faceScore: 0.9, personScore: null }],
      referenceFaces: [{ faces: 'two' }],
    });
    const res = await matcherSearch({ ...IMAGE, eventId: 'ev1' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.referenceFaces).toBeUndefined();
    expect(res.results).toHaveLength(1);
  });
});

describe('matcherSearch — no_usable_face reasons', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('dedupes the rejection reasons across faces', async () => {
    reply(422, {
      error: 'no_usable_face',
      faces: [
        { box: [0, 0, 10, 10], quality: { reasons: ['too_small', 'too_blurry'] } },
        { box: [0, 0, 10, 10], quality: { reasons: ['too_small'] } },
      ],
    });
    const res = await matcherSearch({ ...IMAGE, eventId: 'ev1' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('no_usable_face');
    expect([...(res.faceReasons ?? [])].sort()).toEqual(['too_blurry', 'too_small']);
  });

  it('reports no_face_detected when the detector found nothing', async () => {
    reply(422, { error: 'no_usable_face', faces: [] });
    const res = await matcherSearch({ ...IMAGE, eventId: 'ev1' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.faceReasons).toEqual(['no_face_detected']);
  });

  it('leaves reasons unset when the matcher sends no diagnostics', async () => {
    reply(422, { error: 'no_usable_face' });
    const res = await matcherSearch({ ...IMAGE, eventId: 'ev1' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.faceReasons).toBeUndefined();
  });

  it('ignores an unrecognized reason code', async () => {
    reply(422, {
      error: 'no_usable_face',
      faces: [{ box: [0, 0, 10, 10], quality: { reasons: ['sunglasses'] } }],
    });
    const res = await matcherSearch({ ...IMAGE, eventId: 'ev1' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.faceReasons).toBeUndefined();
  });
});
