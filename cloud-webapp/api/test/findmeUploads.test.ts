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
  matcherSearch: (...a: unknown[]) => matcherSearch(...(a as [])),
}));

const signReferenceUrl = vi.fn();
const readReference = vi.fn();
vi.mock('../src/services/gcsService.js', () => ({
  signPhotoUrls: async (eventId: string, ids: string[]) =>
    ids.map((photoId) => ({ photoId, thumbUrl: `t/${photoId}`, webUrl: `w/${photoId}` })),
  uploadReference: vi.fn(),
  readReference: (...a: unknown[]) => readReference(...(a as [])),
  signReferenceUrl: (...a: unknown[]) => signReferenceUrl(...(a as [])),
}));

interface Rec {
  uploadId: string;
  uid: string;
  eventId: string;
  gcsPath: string;
  contentType: string;
  mode: 'fused' | 'person';
  subjectIsMinor: boolean;
  createdAt: string;
  expiresAt: string;
}
let store: Rec[] = [];
vi.mock('../src/services/references.js', () => ({
  createReference: vi.fn(),
  getReference: vi.fn(async (id: string) => store.find((r) => r.uploadId === id) ?? null),
  listReferencesForUser: vi.fn(async (uid: string) => store.filter((r) => r.uid === uid)),
}));

const { buildServer } = await import('../src/server.js');

const USER = JSON.stringify({ uid: 'u1', email: 'm@x', emailVerified: true });
const OTHER = JSON.stringify({ uid: 'u2', email: 'o@x', emailVerified: true });

function rec(over: Partial<Rec> = {}): Rec {
  return {
    uploadId: 'up-1',
    uid: 'u1',
    eventId: 'evOld',
    gcsPath: 'find_me_references/u1/up-1.jpg',
    contentType: 'image/jpeg',
    mode: 'fused',
    subjectIsMinor: false,
    createdAt: '2026-06-10T00:00:00.000Z',
    expiresAt: '2026-09-10T00:00:00.000Z',
    ...over,
  };
}

describe('Find Me reference reuse (D7)', () => {
  const app = buildServer();

  beforeEach(() => {
    fakeDb.events.clear();
    fakeDb.added.length = 0;
    matcherSearch.mockReset();
    readReference.mockReset();
    readReference.mockResolvedValue(Buffer.from('stored-selfie-bytes'));
    signReferenceUrl.mockReset();
    signReferenceUrl.mockImplementation(async (p: string) => `https://signed.example/ref?${p}`);
    store = [];
    fakeDb.events.set('evNew', { name: 'New Event' });
  });

  describe('GET /api/findme/uploads', () => {
    it('requires auth', async () => {
      const res = await request(app).get('/api/findme/uploads');
      expect(res.status).toBe(401);
    });

    it("lists the caller's uploads with signed URLs", async () => {
      store = [rec({ uploadId: 'up-1' }), rec({ uploadId: 'up-2', uid: 'u2' })];
      const res = await request(app).get('/api/findme/uploads').set('x-test-user', USER);
      expect(res.status).toBe(200);
      expect(res.body.uploads).toHaveLength(1);
      expect(res.body.uploads[0]).toMatchObject({ uploadId: 'up-1', mode: 'fused' });
      expect(res.body.uploads[0].url).toContain('signed.example');
    });
  });

  describe('POST /api/findme/uploads/:uploadId/search', () => {
    it('404s when the upload belongs to another user', async () => {
      store = [rec({ uploadId: 'up-1', uid: 'u1' })];
      const res = await request(app)
        .post('/api/findme/uploads/up-1/search')
        .set('x-test-user', OTHER)
        .send({ eventId: 'evNew' });
      expect(res.status).toBe(404);
      expect(matcherSearch).not.toHaveBeenCalled();
    });

    it('reuses a stored selfie to search a new event', async () => {
      store = [rec()];
      matcherSearch.mockResolvedValue({
        ok: true,
        eventId: 'evNew',
        mode: 'fused',
        results: [{ photoId: 'p1', score: 0.9, faceScore: 0.9, personScore: null }],
      });
      const res = await request(app)
        .post('/api/findme/uploads/up-1/search')
        .set('x-test-user', USER)
        .send({ eventId: 'evNew' });
      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);
      expect(readReference).toHaveBeenCalledWith('find_me_references/u1/up-1.jpg');
      // The reused image is searched against the NEW event.
      expect(matcherSearch.mock.calls[0]?.[0]).toMatchObject({ eventId: 'evNew' });
      // Consent is re-recorded for this search.
      expect(fakeDb.added.some((a) => a.collection === 'consents')).toBe(true);
    });

    it('enforces the minor/guardian gate on reuse', async () => {
      store = [rec({ subjectIsMinor: true })];
      const res = await request(app)
        .post('/api/findme/uploads/up-1/search')
        .set('x-test-user', USER)
        .send({ eventId: 'evNew', subjectIsMinor: true });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('guardian_required');
      expect(matcherSearch).not.toHaveBeenCalled();
    });

    it('410s when the stored bytes are gone', async () => {
      store = [rec()];
      readReference.mockRejectedValueOnce(new Error('No such object'));
      const res = await request(app)
        .post('/api/findme/uploads/up-1/search')
        .set('x-test-user', USER)
        .send({ eventId: 'evNew' });
      expect(res.status).toBe(410);
      expect(res.body.error).toBe('reference_gone');
    });

    it('400s on a missing eventId', async () => {
      store = [rec()];
      const res = await request(app)
        .post('/api/findme/uploads/up-1/search')
        .set('x-test-user', USER)
        .send({});
      expect(res.status).toBe(400);
    });
  });
});
