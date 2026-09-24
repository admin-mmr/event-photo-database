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

const runs = new Map<string, Record<string, unknown>>();
const updates: Array<{ id: string; data: Record<string, unknown> }> = [];

vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: (_name: string) => ({
      doc: (id: string) => ({
        get: async () => ({ exists: runs.has(id), data: () => runs.get(id) }),
        update: async (data: Record<string, unknown>) => {
          updates.push({ id, data });
          runs.set(id, { ...runs.get(id), ...data });
        },
      }),
    }),
  }),
}));

vi.mock('../src/services/gcsService.js', () => ({
  signPhotoUrls: async (eventId: string, photoIds: string[]) =>
    photoIds.map((photoId) => ({
      photoId,
      thumbUrl: `https://signed.example/${eventId}/thumb/${photoId}.jpg`,
      webUrl: `https://signed.example/${eventId}/web/${photoId}.jpg`,
    })),
  uploadReference: vi.fn(),
  readReference: vi.fn(),
  signReferenceUrl: vi.fn(),
  deleteReferenceObject: vi.fn(),
}));

const { buildServer } = await import('../src/server.js');
const { expansionCandidates, parseNearMisses } = await import('../src/services/expandResults.js');

const OWNER = JSON.stringify({ uid: 'u1', email: 'member@mmrunners.org', emailVerified: true });
const OTHER = JSON.stringify({ uid: 'u2', email: 'other@mmrunners.org', emailVerified: true });

function tnormRun(nearMisses: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: 'u1',
    eventId: 'ev1',
    resultPhotoIds: ['p1'],
    algo: { version: 'test', tnorm: true, prf: false, prfCount: 0, numReferences: 1, cutoff: 4.5 },
    nearMisses,
    ...extra,
  };
}

// ── the pure step ───────────────────────────────────────────────────────────

describe('expansionCandidates', () => {
  const band = parseNearMisses([
    { photoId: 'a', score: 4.4, faceScore: 4.6, personScore: 2 },
    { photoId: 'b', score: 4.0, faceScore: 4.1, personScore: null },
    { photoId: 'c', score: 3.99, faceScore: 4.0, personScore: 1 },
    { photoId: 'd', score: 4.2, faceScore: 4.2, personScore: 1 },
    { junk: true },
  ]);

  it('reveals only photos within one step of the cutoff, best first', () => {
    const got = expansionCandidates(band, { cutoff: 4.5, step: 0.5, max: 20, exclude: new Set() });
    expect(got.map((h) => h.photoId)).toEqual(['a', 'd', 'b']); // c is 0.01 past the step
  });

  it('caps the step and never repeats a photo already shown', () => {
    const got = expansionCandidates(band, { cutoff: 4.5, step: 0.5, max: 1, exclude: new Set(['a']) });
    expect(got.map((h) => h.photoId)).toEqual(['d']);
  });

  it('offers nothing when the run recorded no cutoff', () => {
    expect(expansionCandidates(band, { cutoff: null, step: 0.5, max: 20, exclude: new Set() })).toEqual([]);
  });

  it('drops malformed band rows instead of throwing', () => {
    expect(parseNearMisses('nope')).toEqual([]);
    expect(band).toHaveLength(4);
  });
});

// ── the endpoint ────────────────────────────────────────────────────────────

describe('POST /api/findme/runs/:runId/more', () => {
  const app = buildServer();

  beforeEach(() => {
    runs.clear();
    updates.length = 0;
  });

  it('returns the one bounded step, tagged expanded, and logs the use on the run', async () => {
    runs.set(
      'r1',
      tnormRun([
        { photoId: 'p2', score: 4.3, faceScore: 4.6, personScore: 2.6 },
        { photoId: 'p3', score: 2.9, faceScore: 3.1, personScore: 1.8 },
      ]),
    );
    const res = await request(app).post('/api/findme/runs/r1/more').set('x-test-user', OWNER);
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      expect.objectContaining({ photoId: 'p2', score: 4.3, tier: 'expanded', thumbUrl: 'https://signed.example/ev1/thumb/p2.jpg' }),
    ]);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.data.expandedPhotoIds).toEqual(['p2']);
    expect(typeof updates[0]?.data.expandedAt).toBe('string');
  });

  it('is one step per search: a second call returns the same photos and writes nothing', async () => {
    runs.set('r1', tnormRun([{ photoId: 'p2', score: 4.3, faceScore: 4.6, personScore: 2.6 }]));
    await request(app).post('/api/findme/runs/r1/more').set('x-test-user', OWNER);
    const again = await request(app).post('/api/findme/runs/r1/more').set('x-test-user', OWNER);
    expect(again.body.results.map((r: { photoId: string }) => r.photoId)).toEqual(['p2']);
    expect(updates).toHaveLength(1);
  });

  it("404s someone else's search exactly like a missing one", async () => {
    runs.set('r1', tnormRun([{ photoId: 'p2', score: 4.3, faceScore: 4.6, personScore: 2.6 }]));
    const other = await request(app).post('/api/findme/runs/r1/more').set('x-test-user', OTHER);
    const missing = await request(app).post('/api/findme/runs/nope/more').set('x-test-user', OWNER);
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(other.body).toEqual(missing.body);
    expect(updates).toHaveLength(0);
  });

  it('returns an empty step for a run logged before the band existed', async () => {
    runs.set('old', { uid: 'u1', eventId: 'ev1', resultPhotoIds: ['p1'], algo: { version: 'x', tnorm: true, prf: false, prfCount: 0, numReferences: 1 } });
    const res = await request(app).post('/api/findme/runs/old/more').set('x-test-user', OWNER);
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('requires auth', async () => {
    const res = await request(app).post('/api/findme/runs/r1/more');
    expect(res.status).toBe(401);
  });
});
