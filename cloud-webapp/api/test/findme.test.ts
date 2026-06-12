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
    }),
  }),
}));

const matcherSearch = vi.fn();
vi.mock('../src/services/matcherClient.js', () => ({
  matcherSearch: (...args: unknown[]) => matcherSearch(...(args as [])),
}));

vi.mock('../src/services/gcsService.js', () => ({
  signPhotoUrls: async (eventId: string, photoIds: string[]) =>
    photoIds.map((photoId) => ({
      photoId,
      thumbUrl: `https://signed.example/${eventId}/thumb/${photoId}.jpg`,
      webUrl: `https://signed.example/${eventId}/web/${photoId}.jpg`,
    })),
}));

const { buildServer } = await import('../src/server.js');

// ── helpers ──────────────────────────────────────────────────────────────────

const USER = JSON.stringify({ uid: 'u1', email: 'member@mmrunners.org', emailVerified: true });
const JPEG = Buffer.from('fake-jpeg-bytes');

function search(app: ReturnType<typeof buildServer>, fields: Record<string, string>, withFile = true) {
  let req = request(app).post('/api/findme/search').set('x-test-user', USER);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  if (withFile) req = req.attach('file', JPEG, { filename: 'selfie.jpg', contentType: 'image/jpeg' });
  return req;
}

describe('POST /api/findme/search', () => {
  const app = buildServer();

  beforeEach(() => {
    fakeDb.events.clear();
    fakeDb.added.length = 0;
    matcherSearch.mockReset();
    fakeDb.events.set('ev1', { name: 'Spring Run 2026' });
  });

  it('requires auth', async () => {
    const res = await request(app).post('/api/findme/search');
    expect(res.status).toBe(401);
  });

  it('rejects missing file', async () => {
    const res = await search(app, { eventId: 'ev1', consent: 'true' }, false);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_file');
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

    const consents = fakeDb.added.filter((a) => a.collection === 'consents');
    expect(consents).toHaveLength(1);
    expect(consents[0]?.data).toMatchObject({ uid: 'u1', eventId: 'ev1', action: 'findme_search' });
    expect(consents[0]?.data.policyVersion).toBeTruthy();

    const runs = fakeDb.added.filter((a) => a.collection === 'match_runs');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.data).toMatchObject({ uid: 'u1', eventId: 'ev1', resultPhotoIds: ['p1', 'p2'] });
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
});
