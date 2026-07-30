import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

// ── mocks (must precede the server import) ──────────────────────────────────

vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers['x-test-user'];
    if (!raw) {
      res.status(401).json({ ok: false, error: 'unauthorized', message: 'Missing bearer token' });
      return;
    }
    req.user = JSON.parse(String(raw));
    next();
  },
}));

const fakeDb = {
  events: new Map<string, Record<string, unknown>>(),
  added: [] as Array<{ collection: string; data: Record<string, unknown> }>,
  // match_feedback rows, queried by confirmedPhotoIdsForUser (PRF §1.2).
  feedback: [] as Array<Record<string, unknown>>,
};

vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => ({ exists: fakeDb.events.has(id), data: () => fakeDb.events.get(id) }),
      }),
      add: async (data: Record<string, unknown>) => {
        fakeDb.added.push({ collection: name, data });
        return { id: `${name}-doc-${fakeDb.added.length}` };
      },
      where: (field: string, _op: string, value: unknown) => ({
        get: async () => ({
          docs: (name === 'match_feedback' ? fakeDb.feedback : [])
            .filter((d) => d[field] === value)
            .map((d) => ({ data: () => d })),
        }),
      }),
    }),
  }),
}));

const matcherSearch = vi.fn();
const matcherQualityCheck = vi.fn();
vi.mock('../src/services/matcherClient.js', () => ({
  matcherSearch: (...args: unknown[]) => matcherSearch(...(args as [])),
  matcherQualityCheck: (...args: unknown[]) => matcherQualityCheck(...(args as [])),
}));

vi.mock('../src/services/gcsService.js', () => ({
  signPhotoUrls: async (eventId: string, photoIds: string[]) =>
    photoIds.map((photoId) => ({
      photoId,
      thumbUrl: `https://signed.example/${eventId}/thumb/${photoId}.jpg`,
      webUrl: `https://signed.example/${eventId}/web/${photoId}.jpg`,
    })),
  uploadReference: vi.fn().mockResolvedValue('find_me_references/u1/up-1.jpg'),
  readReference: vi.fn(),
  signReferenceUrl: vi.fn(),
}));

const createReference = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/services/references.js', () => ({
  createReference: (...a: unknown[]) => createReference(...(a as [])),
  getReference: vi.fn(),
  listReferencesForUser: vi.fn(),
}));

const { buildServer } = await import('../src/server.js');

// ── helpers ──────────────────────────────────────────────────────────────────

const USER = JSON.stringify({ uid: 'u1', email: 'member@mmrunners.org', emailVerified: true });
const JPEG = Buffer.from('fake-jpeg-bytes');

function search(
  app: ReturnType<typeof buildServer>,
  fields: Record<string, string>,
  opts: { withFile?: boolean; withName?: boolean } = {},
) {
  const { withFile = true, withName = true } = opts;
  let req = request(app).post('/api/findme/search').set('x-test-user', USER);
  const all = { ...(withName ? { name: 'Test Runner' } : {}), ...fields };
  for (const [k, v] of Object.entries(all)) req = req.field(k, v);
  if (withFile) req = req.attach('file', JPEG, { filename: 'selfie.jpg', contentType: 'image/jpeg' });
  return req;
}

describe('POST /api/findme/search', () => {
  const app = buildServer();

  beforeEach(() => {
    fakeDb.events.clear();
    fakeDb.added.length = 0;
    fakeDb.feedback.length = 0;
    matcherSearch.mockReset();
    createReference.mockClear();
    fakeDb.events.set('ev1', { name: 'Spring Run 2026' });
  });

  it('requires auth', async () => {
    const res = await request(app).post('/api/findme/search');
    expect(res.status).toBe(401);
  });

  it('rejects missing file', async () => {
    const res = await search(app, { eventId: 'ev1', consent: 'true' }, { withFile: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_file');
  });

  it('requires a non-empty name and records nothing', async () => {
    const res = await search(app, { eventId: 'ev1', consent: 'true', name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('name_required');
    expect(fakeDb.added).toHaveLength(0);
    expect(matcherSearch).not.toHaveBeenCalled();
  });

  it('rejects missing eventId', async () => {
    const res = await search(app, { consent: 'true' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_event_id');
  });

  it('blocks search without consent and records nothing', async () => {
    const res = await search(app, { eventId: 'ev1' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('consent_required');
    expect(fakeDb.added).toHaveLength(0);
    expect(matcherSearch).not.toHaveBeenCalled();
  });

  it('404s on unknown event', async () => {
    const res = await search(app, { eventId: 'nope', consent: 'true' });
    expect(res.status).toBe(404);
    expect(matcherSearch).not.toHaveBeenCalled();
  });

  it('rejects unsupported mime types', async () => {
    const res = await request(app)
      .post('/api/findme/search')
      .set('x-test-user', USER)
      .field('eventId', 'ev1')
      .field('consent', 'true')
      .attach('file', Buffer.from('gif'), { filename: 'x.gif', contentType: 'image/gif' });
    expect(res.status).toBe(415);
    expect(res.body.error).toBe('unsupported_format');
  });

  it('happy path: records consent + run, returns signed results', async () => {
    matcherSearch.mockResolvedValue({
      ok: true,
      eventId: 'ev1',
      mode: 'fused',
      modelVersion: 'scrfd+arcface+osnet@1',
      results: [
        { photoId: 'p1', score: 0.91, faceScore: 0.93, personScore: 0.7 },
        { photoId: 'p2', score: 0.62, faceScore: 0.62, personScore: null },
      ],
    });

    const res = await search(app, { eventId: 'ev1', consent: 'true' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].thumbUrl).toBe('https://signed.example/ev1/thumb/p1.jpg');
    expect(res.body.results[0].webUrl).toBe('https://signed.example/ev1/web/p1.jpg');
    expect(res.body.runId).toBeDefined();
    // The retrieval-algorithm descriptor is returned and reflects this request
    // (single selfie, no PRF, matcher reported no normalization).
    expect(res.body.algo).toMatchObject({ tnorm: false, prf: false, prfCount: 0, numReferences: 1 });
    expect(res.body.algo.version).toBeTruthy();

    const consents = fakeDb.added.filter((a) => a.collection === 'consents');
    expect(consents).toHaveLength(1);
    expect(consents[0]?.data).toMatchObject({ uid: 'u1', eventId: 'ev1', action: 'findme_search' });
    expect(consents[0]?.data.policyVersion).toBeTruthy();

    const runs = fakeDb.added.filter((a) => a.collection === 'match_runs');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.data).toMatchObject({ uid: 'u1', eventId: 'ev1', resultPhotoIds: ['p1', 'p2'] });
    // Run carries the algorithm descriptor so votes can be attributed to it later.
    expect(runs[0]?.data.algo).toMatchObject({ tnorm: false, prf: false, numReferences: 1 });

    // Fresh uploads are persisted for reuse (D7) with the searcher name + outcome.
    expect(createReference).toHaveBeenCalledTimes(1);
    expect(createReference.mock.calls[0]?.[0]).toMatchObject({
      uid: 'u1',
      eventId: 'ev1',
      mode: 'fused',
      outcome: 'matched',
      name: 'Test Runner',
      email: 'member@mmrunners.org',
    });
    // The captured name is recorded on the consent doc too.
    expect(consents[0]?.data).toMatchObject({ name: 'Test Runner', isGuest: false });
  });

  it('persists per-modality scores so a reviewed batch can be diagnosed', async () => {
    matcherSearch.mockResolvedValue({
      ok: true,
      eventId: 'ev1',
      mode: 'fused',
      anchorPhotoIds: [],
      anchorSuggestion: null,
      faceQualityWeight: 0,
      results: [
        { photoId: 'p1', score: 0.91, faceScore: 0.93, personScore: 0.7 },
        { photoId: 'p2', score: 0.62, faceScore: 0.62, personScore: null },
      ],
    });

    await search(app, { eventId: 'ev1', consent: 'true' });
    const run = fakeDb.added.find((a) => a.collection === 'match_runs')?.data;
    expect(run?.scores).toEqual({ p1: 0.91, p2: 0.62 });
    expect(run?.faceScores).toEqual({ p1: 0.93, p2: 0.62 });
    // p2 had no outfit score at all — recorded as absent, not as zero.
    expect(run?.personScores).toEqual({ p1: 0.7 });
  });

  it('passes an anchor photo through and reports what the matcher applied', async () => {
    matcherSearch.mockResolvedValue({
      ok: true,
      eventId: 'ev1',
      mode: 'fused',
      // The matcher dropped 'ghost' (not in the index) and kept 'p5'.
      anchorPhotoIds: ['p5'],
      anchorSuggestion: null,
      faceQualityWeight: 0,
      results: [{ photoId: 'p5', score: 0.9, faceScore: 0.9, personScore: 0.8 }],
    });

    const res = await search(app, {
      eventId: 'ev1',
      consent: 'true',
      anchorPhotoId: 'p5, ghost , p5',
    });
    expect(res.status).toBe(200);
    // De-duplicated and trimmed on the way in.
    expect(matcherSearch.mock.calls[0]?.[0]).toMatchObject({ anchorPhotoIds: ['p5', 'ghost'] });
    // Recorded from the matcher's report, not from the request.
    expect(res.body.algo.anchorCount).toBe(1);
    expect(res.body.anchorPhotoIds).toEqual(['p5']);
    const run = fakeDb.added.find((a) => a.collection === 'match_runs')?.data;
    expect(run?.anchorPhotoIds).toEqual(['p5']);
  });

  it('returns the suggested anchor and records its photoId on the run', async () => {
    matcherSearch.mockResolvedValue({
      ok: true,
      eventId: 'ev1',
      mode: 'fused',
      anchorPhotoIds: [],
      anchorSuggestion: {
        photoId: 'p1',
        suitability: 0.93,
        faceScore: 8.2,
        faceCount: 1,
        facePx: 420,
        frontality: 0.95,
        faceFrac: 0.24,
        qualityKnown: true,
      },
      faceQualityWeight: 0,
      results: [{ photoId: 'p1', score: 0.9, faceScore: 0.9, personScore: null }],
    });

    const res = await search(app, { eventId: 'ev1', consent: 'true' });
    expect(res.body.anchorSuggestion).toMatchObject({ photoId: 'p1', faceCount: 1 });
    // The suggestion is always one of the returned results, so the client can
    // reuse that entry's signed thumbnail.
    expect(res.body.results.some((r: { photoId: string }) => r.photoId === 'p1')).toBe(true);
    const run = fakeDb.added.find((a) => a.collection === 'match_runs')?.data;
    expect(run?.anchorSuggestionPhotoId).toBe('p1');
  });

  it('omits anchorPhotoIds when none was requested', async () => {
    matcherSearch.mockResolvedValue({ ok: true, eventId: 'ev1', mode: 'fused', results: [] });
    await search(app, { eventId: 'ev1', consent: 'true' });
    expect(matcherSearch.mock.calls[0]?.[0].anchorPhotoIds).toBeUndefined();
  });

  it('survives a matcher that predates anchor support', async () => {
    // The api and matcher deploy separately: an older matcher omits the anchor
    // fields entirely and the search must still succeed.
    matcherSearch.mockResolvedValue({
      ok: true,
      eventId: 'ev1',
      mode: 'fused',
      results: [{ photoId: 'p1', score: 0.9, faceScore: 0.9, personScore: null }],
    });
    const res = await search(app, { eventId: 'ev1', consent: 'true' });
    expect(res.status).toBe(200);
    expect(res.body.anchorSuggestion).toBeNull();
    expect(res.body.anchorPhotoIds).toEqual([]);
    expect(res.body.algo).toMatchObject({ anchorCount: 0, faceQualityWeight: 0 });
  });

  it('relays the reference face census so the client can warn about a group shot', async () => {
    matcherSearch.mockResolvedValue({
      ok: true,
      eventId: 'ev1',
      mode: 'fused',
      referenceFaces: [{ faces: 3, usableFaces: 2, selectedFace: [0.1, 0.2, 0.3, 0.4] }],
      results: [{ photoId: 'p1', score: 0.91, faceScore: 0.93, personScore: 0.7 }],
    });

    const res = await search(app, { eventId: 'ev1', consent: 'true' });
    expect(res.status).toBe(200);
    expect(res.body.referenceFaces).toEqual([
      { faces: 3, usableFaces: 2, selectedFace: [0.1, 0.2, 0.3, 0.4] },
    ]);
  });

  it('omits the face census when the matcher does not report one', async () => {
    matcherSearch.mockResolvedValue({ ok: true, eventId: 'ev1', mode: 'fused', results: [] });
    const res = await search(app, { eventId: 'ev1', consent: 'true' });
    expect(res.status).toBe(200);
    expect(res.body.referenceFaces).toBeUndefined();
  });

  it('sends several selfies to the matcher as one centroid query', async () => {
    matcherSearch.mockResolvedValue({ ok: true, eventId: 'ev1', mode: 'fused', results: [] });
    const res = await request(app)
      .post('/api/findme/search')
      .set('x-test-user', USER)
      .field('name', 'Test Runner')
      .field('eventId', 'ev1')
      .field('consent', 'true')
      .attach('file', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' })
      .attach('file', JPEG, { filename: 'b.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    const arg = matcherSearch.mock.calls[0]?.[0];
    expect(arg.images).toHaveLength(2);
    // Only the first selfie is persisted for reuse.
    expect(createReference).toHaveBeenCalledTimes(1);
  });

  it('folds only this user\'s confirmed photos for this event into PRF', async () => {
    fakeDb.feedback.push(
      { uid: 'u1', eventId: 'ev1', photoId: 'p9', verdict: 'confirmed', createdAt: '2026-07-02T00:00:00Z' },
      { uid: 'u1', eventId: 'ev1', photoId: 'p8', verdict: 'not_me', createdAt: '2026-07-03T00:00:00Z' },
      { uid: 'u1', eventId: 'other', photoId: 'p7', verdict: 'confirmed', createdAt: '2026-07-04T00:00:00Z' },
      { uid: 'u2', eventId: 'ev1', photoId: 'p6', verdict: 'confirmed', createdAt: '2026-07-05T00:00:00Z' },
    );
    matcherSearch.mockResolvedValue({ ok: true, eventId: 'ev1', mode: 'fused', results: [] });

    const res = await search(app, { eventId: 'ev1', consent: 'true' });
    expect(res.status).toBe(200);
    // p8 is not_me, p7 is a different event, p6 is a different user → only p9.
    expect(matcherSearch.mock.calls[0]?.[0]).toMatchObject({ prfPhotoIds: ['p9'] });
  });

  it('omits prfPhotoIds when the user has no confirmations', async () => {
    matcherSearch.mockResolvedValue({ ok: true, eventId: 'ev1', mode: 'fused', results: [] });
    await search(app, { eventId: 'ev1', consent: 'true' });
    expect(matcherSearch.mock.calls[0]?.[0].prfPhotoIds).toBeUndefined();
    expect(matcherSearch.mock.calls[0]?.[0].normalize).toBe(true); // T-norm on by default (2026-07-23 judged sweep)
  });

  it('maps no_usable_face to a friendly 422', async () => {
    matcherSearch.mockResolvedValue({
      ok: false,
      status: 422,
      error: 'no_usable_face',
      message: 'no usable face',
    });
    const res = await search(app, { eventId: 'ev1', consent: 'true' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('no_usable_face');
    // No diagnostics from the matcher → the generic message stands alone.
    expect(res.body.reasons).toBeUndefined();
    expect(res.body.message).toBeTruthy();
  });

  it('relays WHY the photo was rejected so the UI can say what to fix', async () => {
    matcherSearch.mockResolvedValue({
      ok: false,
      status: 422,
      error: 'no_usable_face',
      message: 'no usable face',
      faceReasons: ['too_small', 'too_blurry'],
    });
    const res = await search(app, { eventId: 'ev1', consent: 'true' });
    expect(res.status).toBe(422);
    expect(res.body.reasons).toEqual(['too_small', 'too_blurry']);
  });

  it('persists the selfie even on a failed search, so admins can reproduce it', async () => {
    matcherSearch.mockResolvedValue({
      ok: false,
      status: 422,
      error: 'no_usable_face',
      message: 'no usable face',
    });
    const res = await search(app, { eventId: 'ev1', consent: 'true' });
    expect(res.status).toBe(422);
    // The reference is stored with mode=null and the failure outcome.
    expect(createReference).toHaveBeenCalledTimes(1);
    expect(createReference.mock.calls[0]?.[0]).toMatchObject({
      uid: 'u1',
      eventId: 'ev1',
      mode: null,
      outcome: 'no_usable_face',
      name: 'Test Runner',
    });
    // A failed search records no match_runs doc (nothing to feed the eval loop).
    expect(fakeDb.added.filter((a) => a.collection === 'match_runs')).toHaveLength(0);
  });

  it('maps event_not_indexed to 409', async () => {
    matcherSearch.mockResolvedValue({
      ok: false,
      status: 404,
      error: 'event_not_indexed',
      message: 'not indexed',
    });
    const res = await search(app, { eventId: 'ev1', consent: 'true' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('event_not_indexed');
  });

  it('surfaces matcher unavailability as 502 with the upstream error', async () => {
    matcherSearch.mockResolvedValue({
      ok: false,
      status: 503,
      error: 'matcher_unconfigured',
      message: 'MATCHER_URL is not set',
    });
    const res = await search(app, { eventId: 'ev1', consent: 'true' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('matcher_unconfigured');
  });

  // ── minor / guardian gate (3.2 / PRD §8.3) ───────────────────────────────
  it('blocks a minor-subject search without guardian attestation', async () => {
    const res = await search(app, { eventId: 'ev1', consent: 'true', subjectIsMinor: 'true' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('guardian_required');
    expect(fakeDb.added).toHaveLength(0);
    expect(matcherSearch).not.toHaveBeenCalled();
  });

  it('allows a minor-subject search with guardian attestation and records it', async () => {
    matcherSearch.mockResolvedValue({ ok: true, eventId: 'ev1', mode: 'fused', results: [] });
    const res = await search(app, {
      eventId: 'ev1',
      consent: 'true',
      subjectIsMinor: 'true',
      guardianAttested: 'true',
    });
    expect(res.status).toBe(200);
    const consents = fakeDb.added.filter((a) => a.collection === 'consents');
    expect(consents[0]?.data).toMatchObject({ subjectIsMinor: true, guardianAttested: true });
  });

  it('records subjectIsMinor=false by default', async () => {
    matcherSearch.mockResolvedValue({ ok: true, eventId: 'ev1', mode: 'fused', results: [] });
    await search(app, { eventId: 'ev1', consent: 'true' });
    const consents = fakeDb.added.filter((a) => a.collection === 'consents');
    expect(consents[0]?.data).toMatchObject({ subjectIsMinor: false, guardianAttested: false });
  });

  // ── outfit-only fallback (FR-7) ──────────────────────────────────────────
  it('passes mode=person through to the matcher (outfit-only fallback)', async () => {
    matcherSearch.mockResolvedValue({ ok: true, eventId: 'ev1', mode: 'person', results: [] });
    const res = await search(app, { eventId: 'ev1', consent: 'true', mode: 'person' });
    expect(res.status).toBe(200);
    expect(matcherSearch.mock.calls[0]?.[0]).toMatchObject({ mode: 'person' });
  });

  it('defaults to fused mode when mode is omitted or unknown', async () => {
    matcherSearch.mockResolvedValue({ ok: true, eventId: 'ev1', mode: 'fused', results: [] });
    await search(app, { eventId: 'ev1', consent: 'true', mode: 'bogus' });
    expect(matcherSearch.mock.calls[0]?.[0]).toMatchObject({ mode: 'fused' });
  });
});

describe('POST /api/findme/selfie-check', () => {
  const app = buildServer();

  const GOOD = {
    index: 0,
    filename: 'a.jpg',
    usable: true,
    reasons: [],
    advisories: [],
    selfieScore: 0.92,
    faceCount: 1,
    faceScore: 0.96,
    frontality: 0.94,
    faceFrac: 0.28,
    facePx: 480,
    blur: 210.5,
  };

  beforeEach(() => {
    fakeDb.added.length = 0;
    matcherQualityCheck.mockReset();
    matcherSearch.mockReset();  // shared with the search suite above
    createReference.mockClear();
  });

  function check(fields: Record<string, string>, files = 1) {
    let req = request(app).post('/api/findme/selfie-check').set('x-test-user', USER);
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    for (let i = 0; i < files; i++) {
      req = req.attach('file', JPEG, { filename: `s${i}.jpg`, contentType: 'image/jpeg' });
    }
    return req;
  }

  it('requires auth', async () => {
    expect((await request(app).post('/api/findme/selfie-check')).status).toBe(401);
  });

  it('rejects missing file', async () => {
    const res = await check({ consent: 'true' }, 0);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_file');
  });

  it('requires consent before running a detector over the photo', async () => {
    const res = await check({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('consent_required');
    expect(matcherQualityCheck).not.toHaveBeenCalled();
  });

  it('rejects unsupported mime types', async () => {
    const res = await request(app)
      .post('/api/findme/selfie-check')
      .set('x-test-user', USER)
      .field('consent', 'true')
      .attach('file', Buffer.from('gif'), { filename: 'x.gif', contentType: 'image/gif' });
    expect(res.status).toBe(415);
  });

  it('grades the picks without an eventId and without a search', async () => {
    matcherQualityCheck.mockResolvedValue({
      ok: true,
      files: [GOOD, { ...GOOD, index: 1, selfieScore: 0.41, advisories: ['not_frontal'] }],
      bestIndex: 0,
      anyUsable: true,
    });

    const res = await check({ consent: 'true' }, 2);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.bestIndex).toBe(0);
    expect(res.body.files[1].advisories).toEqual(['not_frontal']);
    expect(matcherSearch).not.toHaveBeenCalled();
  });

  it('writes nothing: no consent row, no run, no stored reference', async () => {
    matcherQualityCheck.mockResolvedValue({ ok: true, files: [GOOD], bestIndex: 0, anyUsable: true });
    await check({ consent: 'true' });
    expect(fakeDb.added).toHaveLength(0);
    expect(createReference).not.toHaveBeenCalled();
  });

  it('reports an unusable pick as a 200 verdict, not an error', async () => {
    matcherQualityCheck.mockResolvedValue({
      ok: true,
      files: [{ ...GOOD, usable: false, reasons: ['no_face'], selfieScore: 0, faceCount: 0 }],
      bestIndex: null,
      anyUsable: false,
    });
    const res = await check({ consent: 'true' });
    expect(res.status).toBe(200);
    expect(res.body.anyUsable).toBe(false);
    expect(res.body.bestIndex).toBeNull();
    expect(res.body.files[0].reasons).toEqual(['no_face']);
  });

  it('passes the multi-face refusal and the face box through untouched', async () => {
    // The api is a relay here: the reject decision and the crop box are the
    // matcher's, and the client acts on both, so the hop must not drop them.
    matcherQualityCheck.mockResolvedValue({
      ok: true,
      files: [
        {
          ...GOOD,
          usable: false,
          reasons: ['multiple_faces'],
          faceCount: 2,
          faceBox: [0.1, 0.2, 0.3, 0.45],
        },
      ],
      bestIndex: null,
      anyUsable: false,
    });
    const res = await check({ consent: 'true' });
    expect(res.status).toBe(200);
    expect(res.body.anyUsable).toBe(false);
    expect(res.body.bestIndex).toBeNull();
    expect(res.body.files[0].reasons).toEqual(['multiple_faces']);
    expect(res.body.files[0].faceBox).toEqual([0.1, 0.2, 0.3, 0.45]);
  });

  it('tolerates a matcher too old to report a face box', async () => {
    matcherQualityCheck.mockResolvedValue({
      ok: true,
      files: [GOOD],
      bestIndex: 0,
      anyUsable: true,
    });
    const res = await check({ consent: 'true' });
    expect(res.status).toBe(200);
    expect(res.body.files[0].faceBox).toBeUndefined();
    expect(res.body.anyUsable).toBe(true);
  });

  it('surfaces a matcher failure as 502 so the client can skip the hint', async () => {
    matcherQualityCheck.mockResolvedValue({
      ok: false,
      status: 502,
      error: 'matcher_unreachable',
      message: 'connect ECONNREFUSED',
    });
    const res = await check({ consent: 'true' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('matcher_unreachable');
  });
});
