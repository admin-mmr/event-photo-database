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
  // When true, querying by `addedAt` throws — simulates the composite index not
  // existing yet (Firestore FAILED_PRECONDITION) so we can test the fallback.
  failAddedAt: false,
  // When true, the Drive trash call throws — exercises the per-photo failure
  // path in the admin delete endpoint.
  failTrash: false,
  // Records calls so a test can assert the side effects of admin delete.
  trashed: [] as string[],
  deletedDerivatives: [] as string[],
  reindexed: [] as string[],
};

vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: (name: string) => {
      if (name === 'events') {
        return {
          doc: (id: string) => ({
            get: async () => ({ exists: fakeDb.events.has(id), data: () => fakeDb.events.get(id) }),
            // merge-set used by the delete endpoint to flag indexState=queued.
            set: async (patch: Record<string, unknown>) => {
              fakeDb.events.set(id, { ...(fakeDb.events.get(id) ?? {}), ...patch });
            },
          }),
        };
      }
      if (name === 'photos') {
        // Chainable query stub: where → orderBy(field) → orderBy(__name__) →
        // [startAfter(val, id)] → limit → get. Tracks the primary order-by
        // field and the cursor's id; sorts by (primary value, id) and slices
        // after the cursor id — mirroring the route's value+__name__ paging.
        const makeQuery = (
          eventId: string,
          orderField: string | null,
          orderDir: 'asc' | 'desc',
          afterId: string | null,
        ) => ({
          orderBy: (field: unknown, dir?: unknown) => {
            const f = typeof field === 'string' ? field : '__name__';
            // First string orderBy wins as the primary key + direction; the
            // __name__ tiebreak and any later orderBy leave it unchanged.
            if (orderField === null && f !== '__name__') {
              return makeQuery(eventId, f, dir === 'desc' ? 'desc' : 'asc', afterId);
            }
            return makeQuery(eventId, orderField, orderDir, afterId);
          },
          startAfter: (...args: unknown[]) =>
            makeQuery(eventId, orderField, orderDir, String(args[args.length - 1] ?? '')),
          limit: (n: number) => ({
            get: async () => {
              if (orderField === 'addedAt' && fakeDb.failAddedAt) {
                throw new Error('9 FAILED_PRECONDITION: The query requires an index');
              }
              const key = (p: { id: string; data: Record<string, unknown> }) =>
                orderField ? String(p.data[orderField] ?? '') : '';
              let all = fakeDb.photos.filter((p) => p.data.eventId === eventId);
              // Firestore excludes docs that lack the orderBy field.
              if (orderField) all = all.filter((p) => p.data[orderField] != null);
              all = all.sort((a, b) => key(a).localeCompare(key(b)) || a.id.localeCompare(b.id));
              if (orderDir === 'desc') all.reverse();
              const start = afterId ? all.findIndex((p) => p.id === afterId) + 1 : 0;
              const page = all.slice(start, start + n);
              return {
                size: page.length,
                empty: page.length === 0,
                docs: page.map((p) => ({ id: p.id, data: () => p.data })),
              };
            },
          }),
        });
        return {
          where: (_field: string, _op: string, eventId: string) =>
            makeQuery(eventId, null, 'asc', null),
          // doc(id).get()/delete() back the admin delete + download lookups.
          doc: (id: string) => ({
            get: async () => {
              const hit = fakeDb.photos.find((p) => p.id === id);
              return { exists: Boolean(hit), id, data: () => hit?.data };
            },
            delete: async () => {
              const i = fakeDb.photos.findIndex((p) => p.id === id);
              if (i >= 0) fakeDb.photos.splice(i, 1);
            },
          }),
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
  deletePhotoDerivatives: async (_eventId: string, photoId: string) => {
    fakeDb.deletedDerivatives.push(photoId);
  },
}));

vi.mock('../src/services/driveService.js', () => ({
  trashFile: async (fileId: string) => {
    if (fakeDb.failTrash) throw new Error('Drive trash 500');
    fakeDb.trashed.push(fileId);
  },
}));

vi.mock('../src/services/indexerJob.js', () => ({
  triggerIndexJob: async (eventId: string) => {
    fakeDb.reindexed.push(eventId);
    return { execution: `projects/p/locations/us-central1/jobs/photo-indexer/executions/${eventId}` };
  },
}));

// requireAdmin reads ADMIN_EMAILS (parsed once at config load), so set it before
// importing the server. The default admin (member@) matches USER below.
process.env.ADMIN_EMAILS = 'member@mmrunners.org';

const { buildServer } = await import('../src/server.js');

const USER = JSON.stringify({ uid: 'u1', email: 'member@mmrunners.org', emailVerified: true });
const NON_ADMIN = JSON.stringify({ uid: 'u2', email: 'rando@mmrunners.org', emailVerified: true });

describe('GET /api/events/:id/photos', () => {
  const app = buildServer();

  beforeEach(() => {
    fakeDb.events.clear();
    fakeDb.photos.length = 0;
    fakeDb.failAddedAt = false;
    fakeDb.failTrash = false;
    fakeDb.trashed.length = 0;
    fakeDb.deletedDerivatives.length = 0;
    fakeDb.reindexed.length = 0;
    fakeDb.events.set('ev1', { name: 'Spring Run 2026', driveFolderId: 'folder1' });
    fakeDb.photos.push(
      { id: 'p1', data: { eventId: 'ev1', name: 'IMG_001.jpg', addedAt: '2026-06-20T10:00:00' } },
      { id: 'p2', data: { eventId: 'ev1', name: 'IMG_002.jpg', addedAt: '2026-06-20T09:00:00' } },
      { id: 'px', data: { eventId: 'other', name: 'IMG_999.jpg', addedAt: '2026-06-20T11:00:00' } },
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
      // addedAt descends with i so the newest-first default yields p1..p5.
      fakeDb.photos.push({
        id: `p${i}`,
        data: { eventId: 'ev1', name: `IMG_${i}.jpg`, addedAt: `2026-06-${String(30 - i).padStart(2, '0')}T00:00:00` },
      });
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

  it('default sort=recent orders by addedAt, newest first', async () => {
    fakeDb.photos.length = 0;
    fakeDb.photos.push(
      // pNew was uploaded later but TAKEN earlier — proves we sort on upload time.
      { id: 'pOld', data: { eventId: 'ev1', name: 'z.jpg', addedAt: '2026-06-20T08:00:00', takenAt: '2026-06-01T08:00:00' } },
      { id: 'pNew', data: { eventId: 'ev1', name: 'a.jpg', addedAt: '2026-06-20T09:00:00', takenAt: '2026-05-01T08:00:00' } },
    );
    const res = await request(app).get('/api/events/ev1/photos').set('x-test-user', USER);
    expect(res.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pNew', 'pOld']);
    expect(res.body.photos[0].addedAt).toBe('2026-06-20T09:00:00');
  });

  it('sort=taken_asc orders by takenAt ascending', async () => {
    fakeDb.photos.length = 0;
    fakeDb.photos.push(
      { id: 'pA', data: { eventId: 'ev1', name: 'z.jpg', takenAt: '2026-06-20T09:00:00', takenAtSource: 'exif' } },
      { id: 'pB', data: { eventId: 'ev1', name: 'a.jpg', takenAt: '2026-06-20T08:00:00', takenAtSource: 'exif' } },
    );
    const res = await request(app).get('/api/events/ev1/photos?sort=taken_asc').set('x-test-user', USER);
    // Earlier capture time first, regardless of filename.
    expect(res.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pB', 'pA']);
    expect(res.body.photos[0].takenAt).toBe('2026-06-20T08:00:00');
    expect(res.body.photos[0].takenAtSource).toBe('exif');
  });

  it('sort=taken_desc orders by takenAt descending', async () => {
    fakeDb.photos.length = 0;
    fakeDb.photos.push(
      { id: 'pEarly', data: { eventId: 'ev1', name: 'a.jpg', takenAt: '2026-06-20T08:00:00' } },
      { id: 'pLate', data: { eventId: 'ev1', name: 'z.jpg', takenAt: '2026-06-20T09:00:00' } },
    );
    const res = await request(app).get('/api/events/ev1/photos?sort=taken_desc').set('x-test-user', USER);
    expect(res.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pLate', 'pEarly']);
  });

  it('sort=added_asc orders by addedAt ascending (upload time, oldest first)', async () => {
    fakeDb.photos.length = 0;
    fakeDb.photos.push(
      { id: 'pNew', data: { eventId: 'ev1', name: 'z.jpg', addedAt: '2026-06-20T09:00:00' } },
      { id: 'pOld', data: { eventId: 'ev1', name: 'a.jpg', addedAt: '2026-06-20T08:00:00' } },
    );
    const res = await request(app).get('/api/events/ev1/photos?sort=added_asc').set('x-test-user', USER);
    expect(res.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pOld', 'pNew']);
  });

  it('sort=added_desc (and the legacy `recent` alias) order by addedAt, newest first', async () => {
    fakeDb.photos.length = 0;
    fakeDb.photos.push(
      { id: 'pOld', data: { eventId: 'ev1', name: 'z.jpg', addedAt: '2026-06-20T08:00:00' } },
      { id: 'pNew', data: { eventId: 'ev1', name: 'a.jpg', addedAt: '2026-06-20T09:00:00' } },
    );
    const explicit = await request(app).get('/api/events/ev1/photos?sort=added_desc').set('x-test-user', USER);
    expect(explicit.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pNew', 'pOld']);
    const legacy = await request(app).get('/api/events/ev1/photos?sort=recent').set('x-test-user', USER);
    expect(legacy.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pNew', 'pOld']);
  });

  it('legacy `time` alias still maps to takenAt ascending', async () => {
    fakeDb.photos.length = 0;
    fakeDb.photos.push(
      { id: 'pA', data: { eventId: 'ev1', name: 'z.jpg', takenAt: '2026-06-20T09:00:00' } },
      { id: 'pB', data: { eventId: 'ev1', name: 'a.jpg', takenAt: '2026-06-20T08:00:00' } },
    );
    const res = await request(app).get('/api/events/ev1/photos?sort=time').set('x-test-user', USER);
    expect(res.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pB', 'pA']);
  });

  it('sort=recent falls back to takenAt desc (no 500) when the addedAt index is missing', async () => {
    fakeDb.failAddedAt = true; // simulate Firestore FAILED_PRECONDITION
    fakeDb.photos.length = 0;
    fakeDb.photos.push(
      { id: 'pEarly', data: { eventId: 'ev1', name: 'z.jpg', takenAt: '2026-06-20T08:00:00', addedAt: '2026-06-20T08:00:00' } },
      { id: 'pLate', data: { eventId: 'ev1', name: 'a.jpg', takenAt: '2026-06-20T09:00:00', addedAt: '2026-06-20T09:00:00' } },
    );
    const res = await request(app).get('/api/events/ev1/photos').set('x-test-user', USER);
    expect(res.status).toBe(200);
    // Even though docs HAVE addedAt, the index error forces the takenAt-desc path.
    expect(res.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pLate', 'pEarly']);
  });

  it('sort=recent falls back to takenAt desc when no photo has addedAt', async () => {
    fakeDb.photos.length = 0;
    fakeDb.photos.push(
      { id: 'pEarly', data: { eventId: 'ev1', name: 'z.jpg', takenAt: '2026-06-20T08:00:00' } },
      { id: 'pLate', data: { eventId: 'ev1', name: 'a.jpg', takenAt: '2026-06-20T09:00:00' } },
    );
    const res = await request(app).get('/api/events/ev1/photos').set('x-test-user', USER);
    // Event not yet backfilled → fall back to capture time, newest first.
    expect(res.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pLate', 'pEarly']);
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

describe('POST /api/events/:id/photos/delete (admin)', () => {
  const app = buildServer();

  beforeEach(() => {
    fakeDb.events.clear();
    fakeDb.photos.length = 0;
    fakeDb.failTrash = false;
    fakeDb.trashed.length = 0;
    fakeDb.deletedDerivatives.length = 0;
    fakeDb.reindexed.length = 0;
    fakeDb.events.set('ev1', { name: 'Spring Run 2026', driveFolderId: 'folder1' });
    fakeDb.photos.push(
      { id: 'p1', data: { eventId: 'ev1', name: 'IMG_001.jpg', mimeType: 'image/jpeg' } },
      { id: 'p2', data: { eventId: 'ev1', name: 'IMG_002.jpg', mimeType: 'image/jpeg' } },
      { id: 'px', data: { eventId: 'other', name: 'IMG_999.jpg', mimeType: 'image/jpeg' } },
    );
  });

  it('requires auth', async () => {
    const res = await request(app).post('/api/events/ev1/photos/delete').send({ photoIds: ['p1'] });
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin with 403', async () => {
    const res = await request(app)
      .post('/api/events/ev1/photos/delete')
      .set('x-test-user', NON_ADMIN)
      .send({ photoIds: ['p1'] });
    expect(res.status).toBe(403);
    expect(fakeDb.trashed).toEqual([]); // nothing touched
  });

  it('400s when photoIds is missing/empty', async () => {
    const res = await request(app)
      .post('/api/events/ev1/photos/delete')
      .set('x-test-user', USER)
      .send({ photoIds: [] });
    expect(res.status).toBe(400);
  });

  it('404s on unknown event', async () => {
    const res = await request(app)
      .post('/api/events/nope/photos/delete')
      .set('x-test-user', USER)
      .send({ photoIds: ['p1'] });
    expect(res.status).toBe(404);
  });

  it('trashes the Drive original, clears derivatives + index doc, and re-indexes', async () => {
    const res = await request(app)
      .post('/api/events/ev1/photos/delete')
      .set('x-test-user', USER)
      .send({ photoIds: ['p1', 'p2'] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted.sort()).toEqual(['p1', 'p2']);
    expect(res.body.failed).toEqual([]);
    expect(res.body.reindex).toContain('photo-indexer');
    // Side effects: both originals trashed, derivatives cleared, docs gone.
    expect(fakeDb.trashed.sort()).toEqual(['p1', 'p2']);
    expect(fakeDb.deletedDerivatives.sort()).toEqual(['p1', 'p2']);
    expect(fakeDb.photos.find((p) => p.id === 'p1')).toBeUndefined();
    expect(fakeDb.photos.find((p) => p.id === 'p2')).toBeUndefined();
    expect(fakeDb.reindexed).toEqual(['ev1']);
    // The event isn't a different one's photo: px untouched.
    expect(fakeDb.photos.find((p) => p.id === 'px')).toBeTruthy();
  });

  it('reports photos not in this event as failed (and does not trash them)', async () => {
    const res = await request(app)
      .post('/api/events/ev1/photos/delete')
      .set('x-test-user', USER)
      .send({ photoIds: ['p1', 'px', 'ghost'] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual(['p1']);
    expect(res.body.failed.map((f: { photoId: string }) => f.photoId).sort()).toEqual(['ghost', 'px']);
    expect(fakeDb.trashed).toEqual(['p1']);
  });

  it('collects a Drive failure as failed without aborting and skips re-index when nothing deleted', async () => {
    fakeDb.failTrash = true;
    const res = await request(app)
      .post('/api/events/ev1/photos/delete')
      .set('x-test-user', USER)
      .send({ photoIds: ['p1'] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual([]);
    expect(res.body.failed[0].photoId).toBe('p1');
    expect(res.body.reindex).toBeNull();
    expect(fakeDb.reindexed).toEqual([]);
    // The index doc survives a failed trash (we delete it only after Drive succeeds).
    expect(fakeDb.photos.find((p) => p.id === 'p1')).toBeTruthy();
  });
});
