import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { Readable } from 'node:stream';
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
  photos: new Map<string, Record<string, unknown>>(),
};

vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const store = name === 'events' ? fakeDb.events : fakeDb.photos;
          return { exists: store.has(id), id, data: () => store.get(id) };
        },
      }),
    }),
  }),
}));

// origFile returns a handle whose createReadStream yields fixed bytes per id,
// so we can assert the ZIP contains the *original* bytes (stored uncompressed).
const ORIG_BYTES = {
  p1: Buffer.from('ORIGINAL-BYTES-FOR-P1'),
  p2: Buffer.from('ORIGINAL-BYTES-FOR-P2'),
};

vi.mock('../src/services/gcsService.js', () => ({
  origFile: (_eventId: string, photoId: string) => ({
    createReadStream: () =>
      Readable.from([(ORIG_BYTES as Record<string, Buffer>)[photoId] ?? Buffer.from('')]),
  }),
  origExtForMime: (m: string | undefined) => (m === 'image/png' ? 'png' : 'jpg'),
  // The single-original route now 302s to a signed URL instead of streaming, so
  // the bytes go GCS → browser directly (off the Hosting egress line).
  signOrigUrl: async (eventId: string, photoId: string, _m: string | undefined) =>
    `https://storage.example/signed/${eventId}/${photoId}?sig=abc`,
}));

const { buildServer } = await import('../src/server.js');

const USER = JSON.stringify({ uid: 'u1', email: 'member@mmrunners.org', emailVerified: true });

describe('POST /api/events/:id/download (B1)', () => {
  const app = buildServer();

  beforeEach(() => {
    fakeDb.events.clear();
    fakeDb.photos.clear();
    fakeDb.events.set('ev1', { name: 'Spring Run 2026' });
    fakeDb.photos.set('p1', { eventId: 'ev1', name: 'IMG_001.jpg', mimeType: 'image/jpeg' });
    fakeDb.photos.set('p2', { eventId: 'ev1', name: 'IMG_002.jpg', mimeType: 'image/jpeg' });
    fakeDb.photos.set('px', { eventId: 'other', name: 'NOPE.jpg', mimeType: 'image/jpeg' });
  });

  it('requires auth', async () => {
    const res = await request(app).post('/api/events/ev1/download').send({ photoIds: ['p1'] });
    expect(res.status).toBe(401);
  });

  it('400s on an empty/invalid photoIds list', async () => {
    const res = await request(app)
      .post('/api/events/ev1/download')
      .set('x-test-user', USER)
      .send({ photoIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('404s on an unknown event', async () => {
    const res = await request(app)
      .post('/api/events/nope/download')
      .set('x-test-user', USER)
      .send({ photoIds: ['p1'] });
    expect(res.status).toBe(404);
  });

  it('404s when none of the photos belong to the event', async () => {
    const res = await request(app)
      .post('/api/events/ev1/download')
      .set('x-test-user', USER)
      .send({ photoIds: ['px'] });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_photos');
  });

  it('returns signed URLs (not bytes) for photos in the event', async () => {
    const res = await request(app)
      .post('/api/events/ev1/download')
      .set('x-test-user', USER)
      .send({ photoIds: ['p1', 'p2', 'px'] }); // px belongs to another event → excluded

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body.ok).toBe(true);

    const files = res.body.files as Array<{ photoId: string; url: string; filename: string }>;
    // px excluded (other event); only p1 + p2 signed.
    expect(files.map((f) => f.photoId).sort()).toEqual(['p1', 'p2']);
    for (const f of files) {
      expect(f.url).toMatch(/^https:\/\/storage\.example\/signed\//);
    }
    expect(files.find((f) => f.photoId === 'p1')?.filename).toBe('IMG_001.jpg');
  });
});

describe('GET /api/events/:id/photos/:photoId/original (individual download)', () => {
  const app = buildServer();

  beforeEach(() => {
    fakeDb.events.clear();
    fakeDb.photos.clear();
    fakeDb.events.set('ev1', { name: 'Spring Run 2026' });
    fakeDb.photos.set('p1', { eventId: 'ev1', name: 'IMG_001.jpg', mimeType: 'image/jpeg' });
    fakeDb.photos.set('px', { eventId: 'other', name: 'NOPE.jpg', mimeType: 'image/jpeg' });
  });

  it('requires auth', async () => {
    const res = await request(app).get('/api/events/ev1/photos/p1/original');
    expect(res.status).toBe(401);
  });

  it('404s when the photo belongs to another event', async () => {
    const res = await request(app).get('/api/events/ev1/photos/px/original').set('x-test-user', USER);
    expect(res.status).toBe(404);
  });

  it('404s for an unknown photo', async () => {
    const res = await request(app).get('/api/events/ev1/photos/nope/original').set('x-test-user', USER);
    expect(res.status).toBe(404);
  });

  it('302-redirects to a signed GCS URL instead of streaming bytes', async () => {
    const res = await request(app)
      .get('/api/events/ev1/photos/p1/original')
      .set('x-test-user', USER)
      .redirects(0); // assert the redirect itself, don't follow it

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('https://storage.example/signed/ev1/p1?sig=abc');
    // No photo bytes flow through the service / Hosting rewrite.
    expect(res.headers['cache-control']).toContain('no-store');
  });
});
