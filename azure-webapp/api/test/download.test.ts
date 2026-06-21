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
}));

const { buildServer } = await import('../src/server.js');

const USER = JSON.stringify({ uid: 'u1', email: 'member@mmrunners.org', emailVerified: true });

// Accumulate the binary response body so we can inspect ZIP bytes. Typed
// loosely because superagent's `.parse()` parameter is an overloaded union.
function binaryParser(
  res: NodeJS.ReadableStream,
  cb: (err: Error | null, body: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
  res.on('error', (e) => cb(e as Error, Buffer.alloc(0)));
}

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

  it('streams a ZIP of the original bytes for photos in the event', async () => {
    const res = await request(app)
      .post('/api/events/ev1/download')
      .set('x-test-user', USER)
      .send({ photoIds: ['p1', 'p2', 'px'] }) // px belongs to another event → excluded
      .buffer(true)
      .parse(binaryParser as unknown as () => void);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toContain('Spring Run 2026-photos.zip');

    const zip = res.body as Buffer;
    expect(zip.length).toBeGreaterThan(0);
    expect(zip.subarray(0, 2).toString('latin1')).toBe('PK'); // local-file-header magic
    // Stored uncompressed (level 0) → original bytes appear verbatim in the ZIP.
    expect(zip.includes(ORIG_BYTES.p1)).toBe(true);
    expect(zip.includes(ORIG_BYTES.p2)).toBe(true);
    // Filenames are present as ZIP entry names.
    expect(zip.includes(Buffer.from('IMG_001.jpg'))).toBe(true);
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

  it('streams the original bytes as an attachment', async () => {
    const res = await request(app)
      .get('/api/events/ev1/photos/p1/original')
      .set('x-test-user', USER)
      .buffer(true)
      .parse(binaryParser as unknown as () => void);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('IMG_001.jpg');
    expect((res.body as Buffer).equals(ORIG_BYTES.p1)).toBe(true);
  });
});
