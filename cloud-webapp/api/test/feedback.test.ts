import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

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

const added: Array<{ collection: string; doc: Record<string, unknown> }> = [];
// match_runs docs the run-algo lookup can resolve, keyed by runId.
const runs: Record<string, Record<string, unknown>> = {};

vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: (name: string) => ({
      add: async (doc: Record<string, unknown>) => {
        added.push({ collection: name, doc });
        return { id: `fb-${added.length}` };
      },
      doc: (id: string) => ({
        get: async () => ({
          data: () => (name === 'match_runs' ? runs[id] : undefined),
        }),
      }),
    }),
  }),
}));

const { buildServer } = await import('../src/server.js');

const USER = JSON.stringify({ uid: 'u1', email: 'member@mmrunners.org', emailVerified: true });

describe('POST /api/feedback (B7)', () => {
  const app = buildServer();

  beforeEach(() => {
    added.length = 0;
    for (const k of Object.keys(runs)) delete runs[k];
  });

  it('requires auth', async () => {
    const res = await request(app).post('/api/feedback').send({
      eventId: 'ev1',
      photoId: 'p1',
      verdict: 'not_me',
    });
    expect(res.status).toBe(401);
  });

  it('400s on an invalid verdict', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .set('x-test-user', USER)
      .send({ eventId: 'ev1', photoId: 'p1', verdict: 'maybe' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('records a not_me vote into match_feedback', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .set('x-test-user', USER)
      .send({ eventId: 'ev1', photoId: 'p1', verdict: 'not_me', runId: 'run-7' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, feedbackId: 'fb-1' });
    expect(added).toHaveLength(1);
    expect(added[0]!.collection).toBe('match_feedback');
    expect(added[0]!.doc).toMatchObject({
      uid: 'u1',
      eventId: 'ev1',
      photoId: 'p1',
      verdict: 'not_me',
      runId: 'run-7',
    });
  });

  it('accepts a confirmed vote without a runId', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .set('x-test-user', USER)
      .send({ eventId: 'ev1', photoId: 'p2', verdict: 'confirmed' });
    expect(res.status).toBe(201);
    expect(added[0]!.doc).toMatchObject({ verdict: 'confirmed', runId: null });
    // No run to resolve → algorithm snapshot is null, but the vote still records.
    expect(added[0]!.doc).toMatchObject({ searchVersion: null, algo: null });
  });

  it("stamps the run's algorithm generation onto the vote at click time", async () => {
    runs['run-7'] = {
      algo: {
        version: '2026.07-tnorm-multiref-prf',
        tnorm: true,
        prf: false,
        prfCount: 0,
        numReferences: 2,
      },
    };
    const res = await request(app)
      .post('/api/feedback')
      .set('x-test-user', USER)
      .send({ eventId: 'ev1', photoId: 'p1', verdict: 'not_me', runId: 'run-7' });
    expect(res.status).toBe(201);
    expect(added[0]!.doc).toMatchObject({
      searchVersion: '2026.07-tnorm-multiref-prf',
      algo: { version: '2026.07-tnorm-multiref-prf', tnorm: true, numReferences: 2 },
    });
  });

  it('records the vote with a null snapshot when the run has no algo (older run)', async () => {
    runs['run-old'] = { modelVersion: 'm-2026-06' }; // pre-versioning run
    const res = await request(app)
      .post('/api/feedback')
      .set('x-test-user', USER)
      .send({ eventId: 'ev1', photoId: 'p1', verdict: 'confirmed', runId: 'run-old' });
    expect(res.status).toBe(201);
    expect(added[0]!.doc).toMatchObject({ runId: 'run-old', searchVersion: null, algo: null });
  });
});

describe('POST /api/feedback/batch ("all me" / "all not me")', () => {
  const app = buildServer();

  beforeEach(() => {
    added.length = 0;
    for (const k of Object.keys(runs)) delete runs[k];
  });

  function batch(body: unknown, user: string | null = USER) {
    const req = request(app).post('/api/feedback/batch');
    if (user) req.set('x-test-user', user);
    return req.send(body as object);
  }

  it('requires auth', async () => {
    const res = await batch({ eventId: 'ev1', photoIds: ['p1'], verdict: 'confirmed' }, null);
    expect(res.status).toBe(401);
  });

  it('records one immutable doc per photo, exactly like the clicks it replaces', async () => {
    const res = await batch({
      eventId: 'ev1',
      photoIds: ['p1', 'p2', 'p3'],
      verdict: 'not_me',
      runId: 'run-1',
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, recorded: 3 });
    expect(added).toHaveLength(3);
    expect(added.map((a) => a.doc.photoId)).toEqual(['p1', 'p2', 'p3']);
    for (const a of added) {
      expect(a.collection).toBe('match_feedback');
      expect(a.doc).toMatchObject({ uid: 'u1', eventId: 'ev1', verdict: 'not_me', runId: 'run-1' });
    }
  });

  it('resolves the run algorithm ONCE for the whole batch', async () => {
    runs['run-7'] = { algo: { version: '2026.07-x', tnorm: true, prf: false, prfCount: 0, numReferences: 1 } };
    const res = await batch({
      eventId: 'ev1',
      photoIds: ['p1', 'p2', 'p3', 'p4'],
      verdict: 'confirmed',
      runId: 'run-7',
    });
    expect(res.status).toBe(201);
    // Every vote still carries the snapshot — the saving is the lookup, not the label.
    for (const a of added) {
      expect(a.doc.searchVersion).toBe('2026.07-x');
      expect(a.doc.algo).toMatchObject({ tnorm: true });
    }
  });

  it('collapses duplicate photoIds within one request', async () => {
    const res = await batch({ eventId: 'ev1', photoIds: ['p1', 'p1', 'p2'], verdict: 'confirmed' });
    expect(res.body.recorded).toBe(2);
    expect(added.map((a) => a.doc.photoId)).toEqual(['p1', 'p2']);
  });

  it('rejects an empty list and a batch past the page-size cap', async () => {
    expect((await batch({ eventId: 'ev1', photoIds: [], verdict: 'confirmed' })).status).toBe(400);
    const tooMany = Array.from({ length: 201 }, (_, i) => `p${i}`);
    expect((await batch({ eventId: 'ev1', photoIds: tooMany, verdict: 'confirmed' })).status).toBe(400);
    expect(added).toHaveLength(0);
  });

  it('rejects an unknown verdict', async () => {
    const res = await batch({ eventId: 'ev1', photoIds: ['p1'], verdict: 'maybe' });
    expect(res.status).toBe(400);
    expect(added).toHaveLength(0);
  });

  it('writes a full page without dropping any', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `p${i}`);
    const res = await batch({ eventId: 'ev1', photoIds: ids, verdict: 'not_me' });
    expect(res.status).toBe(201);
    expect(res.body.recorded).toBe(200);
    expect(added).toHaveLength(200);
  });
});
