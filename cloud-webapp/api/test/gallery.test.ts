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
  photos: [] as Array<{ id: string; data: Record<string, unknown> }>,
};

vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: (name: string) => {
      if (name === 'events') {
        return {
          doc: (id: string) => ({
            get: async () => ({ exists: fakeDb.events.has(id), data: () => fakeDb.events.get(id) }),
          }),
        };
      }
      if (name === 'photos') {
        return {
          where: (_field: string, _op: string, eventId: string) => ({
            limit: (n: number) => ({
              get: async () => ({
                docs: fakeDb.photos
                  .filter((p) => p.data.eventId === eventId)
                  .slice(0, n)
                  .map((p) => ({ id: p.id, data: () => p.data })),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  }),
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

const USER = JSON.stringify({ uid: 'u1', email: 'member@mmrunners.org', emailVerified: true });

describe('GET /api/events/:id/photos', () => {
  const app = buildServer();

  beforeEach(() => {
    fakeDb.events.clear();
    fakeDb.photos.length = 0;
    fakeDb.events.set('ev1', { name: 'Spring Run 2026' });
    fakeDb.photos.push(
      { id: 'p1', data: { eventId: 'ev1', name: 'IMG_001.jpg' } },
      { id: 'p2', data: { eventId: 'ev1', name: 'IMG_002.jpg' } },
      { id: 'px', data: { eventId: 'other', name: 'IMG_999.jpg' } },
    );
  });

  it('requires auth', async () => {
    const res = await request(app).get('/api/events/ev1/photos');
    expect(res.status).toBe(401);
  });

  it('404s on unknown event', async () => {
    const res = await request(app).get('/api/events/nope/photos').set('x-test-user', USER);
    expect(res.status).toBe(404);
  });

  it('lists only the event photos with signed urls', async () => {
    const res = await request(app).get('/api/events/ev1/photos').set('x-test-user', USER);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.photos).toHaveLength(2);
    expect(res.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['p1', 'p2']);
    expect(res.body.photos[0].thumbUrl).toContain('/ev1/thumb/p1.jpg');
    expect(res.body.photos[0].webUrl).toContain('/ev1/web/p1.jpg');
  });
});
