import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

// Gate the pilot to ev1 BEFORE config is parsed (server import below triggers it).
process.env.FINDME_EVENT_ALLOWLIST = 'ev1';

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
  uploadReference: vi.fn().mockResolvedValue('find_me_references/u1/up-1.jpg'),
  readReference: vi.fn(),
  signReferenceUrl: vi.fn(),
}));

vi.mock('../src/services/references.js', () => ({
  createReference: vi.fn().mockResolvedValue(undefined),
  getReference: vi.fn(),
  listReferencesForUser: vi.fn(),
}));

const { buildServer } = await import('../src/server.js');

const USER = JSON.stringify({ uid: 'u1', email: 'member@mmrunners.org', emailVerified: true });
const JPEG = Buffer.from('fake-jpeg-bytes');

function search(app: ReturnType<typeof buildServer>, eventId: string) {
  return request(app)
    .post('/api/findme/search')
    .set('x-test-user', USER)
    .field('eventId', eventId)
    .field('name', 'Test Runner')
    .field('consent', 'true')
    .attach('file', JPEG, { filename: 'selfie.jpg', contentType: 'image/jpeg' });
}

describe('Find Me pilot feature flag (M6.1)', () => {
  const app = buildServer();

  beforeEach(() => {
    fakeDb.events.clear();
    fakeDb.added.length = 0;
    matcherSearch.mockReset();
    fakeDb.events.set('ev1', { name: 'Pilot Event' });
    fakeDb.events.set('ev2', { name: 'Other Event' });
    matcherSearch.mockResolvedValue({
      ok: true,
      mode: 'fused',
      modelVersion: 'm1',
      results: [{ photoId: 'p1', score: 0.9, faceScore: 0.9, personScore: 0.8 }],
    });
  });

  it('refuses search for an event outside the pilot allowlist, before any work', async () => {
    const res = await search(app, 'ev2');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('feature_unavailable');
    expect(matcherSearch).not.toHaveBeenCalled();
    expect(fakeDb.added).toHaveLength(0); // no consent / run recorded
  });

  it('allows search for the allowlisted pilot event', async () => {
    const res = await search(app, 'ev1');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(matcherSearch).toHaveBeenCalledTimes(1);
  });
});
