import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

// requireAuth mocked to read x-test-user; requireAdmin is the REAL middleware
// (checks ADMIN_EMAILS, default admin@mmrunners.org) so we exercise the gate.
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

// Minimal firestore: capture admin_audit writes so we can assert auditing.
const audits: Array<Record<string, unknown>> = [];
vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: (name: string) => ({
      add: async (data: Record<string, unknown>) => {
        if (name === 'admin_audit') audits.push(data);
        return { id: `${name}-1` };
      },
    }),
  }),
}));

interface Rec {
  uploadId: string;
  uid: string;
  email: string | null;
  name: string | null;
  eventId: string;
  gcsPath: string;
  contentType: string;
  mode: 'fused' | 'person' | null;
  outcome?: string;
  subjectIsMinor: boolean;
  createdAt: string;
  expiresAt: string;
}
let store: Rec[] = [];

const listAllReferences = vi.fn(async () => store);
const getReference = vi.fn(async (id: string) => store.find((r) => r.uploadId === id) ?? null);
vi.mock('../src/services/references.js', () => ({
  listAllReferences: (...a: unknown[]) => listAllReferences(...(a as [])),
  getReference: (...a: unknown[]) => getReference(...(a as [string])),
}));

const matcherSearch = vi.fn();
vi.mock('../src/services/matcherClient.js', () => ({
  matcherSearch: (...a: unknown[]) => matcherSearch(...(a as [])),
}));

const readReference = vi.fn();
vi.mock('../src/services/gcsService.js', () => ({
  signReferenceUrl: async (p: string) => `https://signed.example/ref?${encodeURIComponent(p)}`,
  readReference: (...a: unknown[]) => readReference(...(a as [])),
  signPhotoUrls: async (eventId: string, ids: string[]) =>
    ids.map((photoId) => ({ photoId, thumbUrl: `t/${eventId}/${photoId}`, webUrl: `w/${photoId}` })),
}));

const { buildServer } = await import('../src/server.js');

const ADMIN = JSON.stringify({ uid: 'a1', email: 'admin@mmrunners.org', emailVerified: true });
const MEMBER = JSON.stringify({ uid: 'u1', email: 'member@mmrunners.org', emailVerified: true });

function rec(over: Partial<Rec> = {}): Rec {
  return {
    uploadId: 'up-1',
    uid: 'u1',
    email: 'guest@x',
    name: 'Jamie Lee',
    eventId: 'ev1',
    gcsPath: 'find_me_references/u1/up-1.jpg',
    contentType: 'image/jpeg',
    mode: 'fused',
    outcome: 'matched',
    subjectIsMinor: false,
    createdAt: '2026-06-10T00:00:00.000Z',
    expiresAt: '2026-09-10T00:00:00.000Z',
    ...over,
  };
}

describe('admin Find Me inspection + repro', () => {
  const app = buildServer();

  beforeEach(() => {
    store = [];
    audits.length = 0;
    listAllReferences.mockClear();
    getReference.mockClear();
    matcherSearch.mockReset();
    readReference.mockReset();
    readReference.mockResolvedValue(Buffer.from('stored-selfie'));
  });

  describe('GET /api/admin/findme/uploads', () => {
    it('requires auth', async () => {
      const res = await request(app).get('/api/admin/findme/uploads');
      expect(res.status).toBe(401);
    });

    it('forbids non-admins', async () => {
      const res = await request(app).get('/api/admin/findme/uploads').set('x-test-user', MEMBER);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    });

    it('lists references with signed image URLs and audits the access', async () => {
      store = [rec(), rec({ uploadId: 'up-2', outcome: 'no_usable_face', mode: null })];
      const res = await request(app)
        .get('/api/admin/findme/uploads?eventId=ev1')
        .set('x-test-user', ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.references[0]).toMatchObject({ uploadId: 'up-1', name: 'Jamie Lee', outcome: 'matched' });
      expect(res.body.references[0].imageUrl).toContain('signed.example');
      expect(res.body.references[1]).toMatchObject({ outcome: 'no_usable_face', mode: null });
      expect(audits.some((a) => a.action === 'findme_list')).toBe(true);
    });
  });

  describe('GET /api/admin/findme/uploads/:uploadId/image', () => {
    it('302-redirects to a signed URL and audits the view', async () => {
      store = [rec()];
      const res = await request(app)
        .get('/api/admin/findme/uploads/up-1/image')
        .set('x-test-user', ADMIN)
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('signed.example');
      expect(audits.some((a) => a.action === 'findme_view_selfie' && a.uploadId === 'up-1')).toBe(true);
    });

    it('404s for an unknown uploadId', async () => {
      const res = await request(app)
        .get('/api/admin/findme/uploads/nope/image')
        .set('x-test-user', ADMIN)
        .redirects(0);
      expect(res.status).toBe(404);
    });

    it('forbids non-admins', async () => {
      store = [rec()];
      const res = await request(app)
        .get('/api/admin/findme/uploads/up-1/image')
        .set('x-test-user', MEMBER)
        .redirects(0);
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/admin/findme/uploads/:uploadId/reproduce', () => {
    it('reproduces a successful match with signed thumbs', async () => {
      store = [rec()];
      matcherSearch.mockResolvedValue({
        ok: true,
        eventId: 'ev1',
        mode: 'fused',
        modelVersion: 'm1',
        results: [{ photoId: 'p1', score: 0.92, faceScore: 0.9, personScore: null }],
      });
      const res = await request(app)
        .post('/api/admin/findme/uploads/up-1/reproduce')
        .set('x-test-user', ADMIN)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ outcome: 'matched', status: 200, resultCount: 1 });
      expect(res.body.results[0]).toMatchObject({ photoId: 'p1', thumbUrl: 't/ev1/p1' });
      expect(readReference).toHaveBeenCalledWith('find_me_references/u1/up-1.jpg');
      expect(audits.some((a) => a.action === 'findme_reproduce')).toBe(true);
    });

    it('reproduces a no_usable_face failure verbatim', async () => {
      store = [rec({ outcome: 'no_usable_face', mode: null })];
      matcherSearch.mockResolvedValue({
        ok: false,
        status: 422,
        error: 'no_usable_face',
        message: 'no usable face',
      });
      const res = await request(app)
        .post('/api/admin/findme/uploads/up-1/reproduce')
        .set('x-test-user', ADMIN)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ outcome: 'no_usable_face', status: 422, resultCount: 0 });
      expect(res.body.message).toBe('no usable face');
      // It must NOT default the (null) stored mode into the matcher as null.
      expect(matcherSearch.mock.calls[0]?.[0]).toMatchObject({ mode: 'fused', eventId: 'ev1' });
    });

    it('404s for an unknown uploadId', async () => {
      const res = await request(app)
        .post('/api/admin/findme/uploads/nope/reproduce')
        .set('x-test-user', ADMIN)
        .send({});
      expect(res.status).toBe(404);
      expect(matcherSearch).not.toHaveBeenCalled();
    });

    it('410s when the stored selfie is gone', async () => {
      store = [rec()];
      readReference.mockRejectedValueOnce(new Error('No such object'));
      const res = await request(app)
        .post('/api/admin/findme/uploads/up-1/reproduce')
        .set('x-test-user', ADMIN)
        .send({});
      expect(res.status).toBe(410);
      expect(res.body.error).toBe('reference_gone');
    });

    it('forbids non-admins', async () => {
      store = [rec()];
      const res = await request(app)
        .post('/api/admin/findme/uploads/up-1/reproduce')
        .set('x-test-user', MEMBER)
        .send({});
      expect(res.status).toBe(403);
      expect(matcherSearch).not.toHaveBeenCalled();
    });
  });
});
