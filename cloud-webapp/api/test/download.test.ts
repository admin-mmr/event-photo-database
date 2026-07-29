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

// The download routes never touch photo bytes: both hand back signed URLs so the
// bytes go storage → browser directly, off the Hosting egress line (CLAUDE.md).
// `filename` is recorded so a test can assert the Save-As name is passed RAW —
// the RFC-5987 encoding now happens once, inside the storage adapter.
const signedFor: Array<{ photoId: string; filename?: string | undefined }> = [];
vi.mock('../src/services/gcsService.js', () => ({
  origExtForMime: (m: string | undefined) => (m === 'image/png' ? 'png' : 'jpg'),
  signOrigUrl: async (
    eventId: string,
    photoId: string,
    _m: string | undefined,
    opts?: { filename?: string },
  ) => {
    signedFor.push({ photoId, filename: opts?.filename });
    return `https://storage.example/signed/${eventId}/${photoId}?sig=abc`;
  },
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

  it('passes the Save-As filename RAW, leaving the encoding to the adapter', async () => {
    // This route used to call encodeURIComponent itself. Now that the storage
    // adapter builds the RFC-5987 `filename*`, encoding here too would reach the
    // volunteer as `%E6%B9%98…` — so the contract is "raw name in".
    fakeDb.photos.set('pz', { eventId: 'ev1', name: '湘舍动.jpg', mimeType: 'image/jpeg' });
    signedFor.length = 0;
    await request(app).post('/api/events/ev1/download').set('x-test-user', USER).send({ photoIds: ['pz'] });
    expect(signedFor).toEqual([{ photoId: 'pz', filename: '湘舍动.jpg' }]);
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

  // ?format=json exists so the browser never has to follow a CROSS-ORIGIN
  // redirect to read bytes: that hop taints the origin (GCS CORS lists explicit
  // web origins, not "null") and can carry the first hop's Authorization header
  // into a signed URL that already has its own auth. It broke Save-to-Photos on
  // iOS Safari while the ZIP path, which fetches signed URLs directly, worked.
  it('returns the signed URL as JSON when format=json', async () => {
    const res = await request(app)
      .get('/api/events/ev1/photos/p1/original?format=json')
      .set('x-test-user', USER)
      .redirects(0);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.url).toBe('https://storage.example/signed/ev1/p1?sig=abc');
    expect(res.body.filename).toBe('IMG_001.jpg');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('still enforces auth and event ownership in json mode', async () => {
    expect((await request(app).get('/api/events/ev1/photos/p1/original?format=json')).status).toBe(401);
    const wrongEvent = await request(app)
      .get('/api/events/ev1/photos/px/original?format=json')
      .set('x-test-user', USER);
    expect(wrongEvent.status).toBe(404);
  });

  it('only switches shape for an exact format=json (anything else still redirects)', async () => {
    const res = await request(app)
      .get('/api/events/ev1/photos/p1/original?format=xml')
      .set('x-test-user', USER)
      .redirects(0);
    expect(res.status).toBe(302);
  });
});
