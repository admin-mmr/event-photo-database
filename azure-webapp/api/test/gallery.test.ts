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
        // Chainable query stub: where → orderBy(field) → orderBy(__name__) →
        // [startAfter(val, id)] → limit → get. Tracks the primary order-by
        // field and the cursor's id; sorts by (primary value, id) and slices
        // after the cursor id — mirroring the route's value+__name__ paging.
        const makeQuery = (eventId: string, orderField: string | null, afterId: string | null) => ({
          orderBy: (field: unknown) => {
            const f = typeof field === 'string' ? field : '__name__';
            // First orderBy wins as the primary key; the second is the id tiebreak.
            return makeQuery(eventId, orderField ?? (f === '__name__' ? null : f), afterId);
          },
          startAfter: (...args: unknown[]) =>
            makeQuery(eventId, orderField, String(args[args.length - 1] ?? '')),
          limit: (n: number) => ({
            get: async () => {
              const key = (p: { id: string; data: Record<string, unknown> }) =>
                orderField ? String(p.data[orderField] ?? '') : '';
              const all = fakeDb.photos
                .filter((p) => p.data.eventId === eventId)
                .sort((a, b) => key(a).localeCompare(key(b)) || a.id.localeCompare(b.id));
              const start = afterId ? all.findIndex((p) => p.id === afterId) + 1 : 0;
              const page = all.slice(start, start + n);
              return {
                size: page.length,
                docs: page.map((p) => ({ id: p.id, data: () => p.data })),
              };
            },
          }),
        });
        return {
          where: (_field: string, _op: string, eventId: string) => makeQuery(eventId, null, null),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  }),
}));

vi.mock('../src/services/gcsService.js', () => ({
  signThumbUrls: async (eventId: string, photoIds: string[]) =>
    photoIds.map((photoId) => ({
      photoId,
      thumbUrl: `https://signed.example/${eventId}/thumb/${photoId}.jpg`,
    })),
  signPhotoUrl: async (eventId: string, photoId: string, kind = 'thumb', ext = 'jpg') =>
    `https://signed.example/${eventId}/${kind}/${photoId}.${ext}`,
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
    // The list ships thumbnails only; the full-size `web` URL is signed lazily.
    expect(res.body.photos[0].webUrl).toBeUndefined();
    expect(res.body.nextCursor).toBeNull();
  });

  it('signs a single full-size web url on demand', async () => {
    const res = await request(app)
      .get('/api/events/ev1/photos/p1/web')
      .set('x-test-user', USER);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.photoId).toBe('p1');
    expect(res.body.webUrl).toContain('/ev1/web/p1.jpg');
  });

  it('paginates with limit + cursor and reports nextCursor', async () => {
    fakeDb.photos.length = 0;
    for (let i = 1; i <= 5; i += 1) {
      fakeDb.photos.push({ id: `p${i}`, data: { eventId: 'ev1', name: `IMG_${i}.jpg` } });
    }

    const page1 = await request(app)
      .get('/api/events/ev1/photos?limit=2')
      .set('x-test-user', USER);
    expect(page1.status).toBe(200);
    expect(page1.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['p1', 'p2']);
    expect(page1.body.nextCursor).toBeTruthy(); // opaque cursor

    const page2 = await request(app)
      .get(`/api/events/ev1/photos?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .set('x-test-user', USER);
    expect(page2.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['p3', 'p4']);
    expect(page2.body.nextCursor).toBeTruthy();

    const page3 = await request(app)
      .get(`/api/events/ev1/photos?limit=2&cursor=${encodeURIComponent(page2.body.nextCursor)}`)
      .set('x-test-user', USER);
    expect(page3.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['p5']);
    expect(page3.body.nextCursor).toBeNull();
  });

  it('default sort=time orders by takenAt and returns it', async () => {
    fakeDb.photos.length = 0;
    fakeDb.photos.push(
      { id: 'pA', data: { eventId: 'ev1', name: 'z.jpg', takenAt: '2026-06-20T09:00:00', takenAtSource: 'exif' } },
      { id: 'pB', data: { eventId: 'ev1', name: 'a.jpg', takenAt: '2026-06-20T08:00:00', takenAtSource: 'exif' } },
    );
    const res = await request(app).get('/api/events/ev1/photos').set('x-test-user', USER);
    // Earlier capture time first, regardless of filename.
    expect(res.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pB', 'pA']);
    expect(res.body.photos[0].takenAt).toBe('2026-06-20T08:00:00');
    expect(res.body.photos[0].takenAtSource).toBe('exif');
  });

  it('sort=name orders by filename', async () => {
    fakeDb.photos.length = 0;
    fakeDb.photos.push(
      { id: 'pA', data: { eventId: 'ev1', name: 'z.jpg', takenAt: '2026-06-20T08:00:00' } },
      { id: 'pB', data: { eventId: 'ev1', name: 'a.jpg', takenAt: '2026-06-20T09:00:00' } },
    );
    const res = await request(app).get('/api/events/ev1/photos?sort=name').set('x-test-user', USER);
    expect(res.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pB', 'pA']);
  });
});
