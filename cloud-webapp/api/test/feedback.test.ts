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
