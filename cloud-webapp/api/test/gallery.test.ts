import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

import { fakeStore } from './helpers/fakeDb.js';

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

/**
 * The database is the SHARED in-memory `DocumentStore` (AZ2), not a bespoke
 * query stub.
 *
 * What was here before hand-rolled ~75 lines of Firestore paging — and ordered
 * with `localeCompare`, where Firestore orders by UTF-8 code point. With Chinese
 * filenames in play (this app has plenty) that fake could pass while production
 * paged differently: exactly the code-point-vs-locale trap CLAUDE.md documents
 * for duplicate removal. The shared fake compares by code point, so these paging
 * assertions now mean something.
 */
const store = fakeStore();

/** Side effects outside the database, recorded so tests can assert on them. */
const side = {
  // When true, the Drive trash call throws — exercises the per-photo failure
  // path in the admin delete endpoint.
  failTrash: false,
  trashed: [] as string[],
  deletedDerivatives: [] as string[],
  reindexed: [] as string[],
};

vi.mock('../src/lib/firestore.js', () => ({ firestore: () => store }));

/** Seed photos using the same `{ id, data }` rows the tests already declare. */
function seedPhotos(...rows: Array<{ id: string; data: Record<string, unknown> }>): void {
  store.seed('photos', Object.fromEntries(rows.map((r) => [r.id, r.data])));
}

function seedEvent(id: string, data: Record<string, unknown>): void {
  store.seed('events', { [id]: data });
}

function clearPhotos(): void {
  store.data.get('photos')?.clear();
}

function clearEvents(): void {
  store.data.get('events')?.clear();
}

vi.mock('../src/services/gcsService.js', () => ({
  signThumbUrls: async (eventId: string, photoIds: string[]) =>
    photoIds.map((photoId) => ({
      photoId,
      thumbUrl: `https://signed.example/${eventId}/thumb/${photoId}.jpg`,
    })),
  signPhotoUrl: async (eventId: string, photoId: string, kind = 'thumb', ext = 'jpg') =>
    `https://signed.example/${eventId}/${kind}/${photoId}.${ext}`,
  deletePhotoDerivatives: async (_eventId: string, photoId: string) => {
    side.deletedDerivatives.push(photoId);
  },
}));

vi.mock('../src/services/driveService.js', () => ({
  trashFile: async (fileId: string) => {
    if (side.failTrash) throw new Error('Drive trash 500');
    side.trashed.push(fileId);
  },
}));

vi.mock('../src/services/indexerJob.js', () => ({
  triggerIndexJob: async (eventId: string) => {
    side.reindexed.push(eventId);
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
    clearEvents();
    clearPhotos();
    store.failQueryOnOrderBy.clear();
    side.failTrash = false;
    side.trashed.length = 0;
    side.deletedDerivatives.length = 0;
    side.reindexed.length = 0;
    seedEvent('ev1', { name: 'Spring Run 2026', driveFolderId: 'folder1' });
    seedPhotos(
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
    clearPhotos();
    for (let i = 1; i <= 5; i += 1) {
      // addedAt descends with i so the newest-first default yields p1..p5.
      seedPhotos({
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
    clearPhotos();
    seedPhotos(
      // pNew was uploaded later but TAKEN earlier — proves we sort on upload time.
      { id: 'pOld', data: { eventId: 'ev1', name: 'z.jpg', addedAt: '2026-06-20T08:00:00', takenAt: '2026-06-01T08:00:00' } },
      { id: 'pNew', data: { eventId: 'ev1', name: 'a.jpg', addedAt: '2026-06-20T09:00:00', takenAt: '2026-05-01T08:00:00' } },
    );
    const res = await request(app).get('/api/events/ev1/photos').set('x-test-user', USER);
    expect(res.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pNew', 'pOld']);
    expect(res.body.photos[0].addedAt).toBe('2026-06-20T09:00:00');
  });

  it('sort=taken_asc orders by takenAt ascending', async () => {
    clearPhotos();
    seedPhotos(
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
    clearPhotos();
    seedPhotos(
      { id: 'pEarly', data: { eventId: 'ev1', name: 'a.jpg', takenAt: '2026-06-20T08:00:00' } },
      { id: 'pLate', data: { eventId: 'ev1', name: 'z.jpg', takenAt: '2026-06-20T09:00:00' } },
    );
    const res = await request(app).get('/api/events/ev1/photos?sort=taken_desc').set('x-test-user', USER);
    expect(res.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pLate', 'pEarly']);
  });

  it('sort=added_asc orders by addedAt ascending (upload time, oldest first)', async () => {
    clearPhotos();
    seedPhotos(
      { id: 'pNew', data: { eventId: 'ev1', name: 'z.jpg', addedAt: '2026-06-20T09:00:00' } },
      { id: 'pOld', data: { eventId: 'ev1', name: 'a.jpg', addedAt: '2026-06-20T08:00:00' } },
    );
    const res = await request(app).get('/api/events/ev1/photos?sort=added_asc').set('x-test-user', USER);
    expect(res.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pOld', 'pNew']);
  });

  it('sort=added_desc (and the legacy `recent` alias) order by addedAt, newest first', async () => {
    clearPhotos();
    seedPhotos(
      { id: 'pOld', data: { eventId: 'ev1', name: 'z.jpg', addedAt: '2026-06-20T08:00:00' } },
      { id: 'pNew', data: { eventId: 'ev1', name: 'a.jpg', addedAt: '2026-06-20T09:00:00' } },
    );
    const explicit = await request(app).get('/api/events/ev1/photos?sort=added_desc').set('x-test-user', USER);
    expect(explicit.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pNew', 'pOld']);
    const legacy = await request(app).get('/api/events/ev1/photos?sort=recent').set('x-test-user', USER);
    expect(legacy.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pNew', 'pOld']);
  });

  it('legacy `time` alias still maps to takenAt ascending', async () => {
    clearPhotos();
    seedPhotos(
      { id: 'pA', data: { eventId: 'ev1', name: 'z.jpg', takenAt: '2026-06-20T09:00:00' } },
      { id: 'pB', data: { eventId: 'ev1', name: 'a.jpg', takenAt: '2026-06-20T08:00:00' } },
    );
    const res = await request(app).get('/api/events/ev1/photos?sort=time').set('x-test-user', USER);
    expect(res.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pB', 'pA']);
  });

  it('sort=recent falls back to takenAt desc (no 500) when the addedAt index is missing', async () => {
    store.failQueryOnOrderBy.add('addedAt'); // the composite index does not exist yet
    clearPhotos();
    seedPhotos(
      { id: 'pEarly', data: { eventId: 'ev1', name: 'z.jpg', takenAt: '2026-06-20T08:00:00', addedAt: '2026-06-20T08:00:00' } },
      { id: 'pLate', data: { eventId: 'ev1', name: 'a.jpg', takenAt: '2026-06-20T09:00:00', addedAt: '2026-06-20T09:00:00' } },
    );
    const res = await request(app).get('/api/events/ev1/photos').set('x-test-user', USER);
    expect(res.status).toBe(200);
    // Even though docs HAVE addedAt, the index error forces the takenAt-desc path.
    expect(res.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pLate', 'pEarly']);
  });

  it('sort=recent falls back to takenAt desc when no photo has addedAt', async () => {
    clearPhotos();
    seedPhotos(
      { id: 'pEarly', data: { eventId: 'ev1', name: 'z.jpg', takenAt: '2026-06-20T08:00:00' } },
      { id: 'pLate', data: { eventId: 'ev1', name: 'a.jpg', takenAt: '2026-06-20T09:00:00' } },
    );
    const res = await request(app).get('/api/events/ev1/photos').set('x-test-user', USER);
    // Event not yet backfilled → fall back to capture time, newest first.
    expect(res.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pLate', 'pEarly']);
  });

  it('sort=name orders by filename', async () => {
    clearPhotos();
    seedPhotos(
      { id: 'pA', data: { eventId: 'ev1', name: 'z.jpg', takenAt: '2026-06-20T08:00:00' } },
      { id: 'pB', data: { eventId: 'ev1', name: 'a.jpg', takenAt: '2026-06-20T09:00:00' } },
    );
    const res = await request(app).get('/api/events/ev1/photos?sort=name').set('x-test-user', USER);
    expect(res.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['pB', 'pA']);
  });

  it('orders names by CODE POINT, not by locale', async () => {
    // Firestore (and Cosmos) order strings by UTF-8 code point. A locale collation
    // disagrees on exactly these inputs: `localeCompare` sorts 'a' before 'B'
    // (case-insensitive-ish) and puts most CJK before Latin, where code point puts
    // every uppercase ASCII letter first and CJK last.
    //
    // This test is why the bespoke fake had to go — it hand-rolled paging with
    // localeCompare, so it would have passed on the wrong order while production
    // paged differently. Chinese filenames are routine in this app.
    clearPhotos();
    seedPhotos(
      { id: 'p1', data: { eventId: 'ev1', name: 'apple.jpg' } },
      { id: 'p2', data: { eventId: 'ev1', name: 'Banana.jpg' } },
      { id: 'p3', data: { eventId: 'ev1', name: '湘舍动.jpg' } },
    );
    const res = await request(app).get('/api/events/ev1/photos?sort=name').set('x-test-user', USER);
    expect(res.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['p2', 'p1', 'p3']);
    // Guard the premise: if these ever agree, the test has stopped proving anything.
    expect(['apple.jpg', 'Banana.jpg'].sort((a, b) => a.localeCompare(b))).toEqual([
      'apple.jpg',
      'Banana.jpg',
    ]);
    expect(['apple.jpg', 'Banana.jpg'].sort()).toEqual(['Banana.jpg', 'apple.jpg']);
  });

  it('pages by code point across a cursor boundary', async () => {
    // The cursor is a (name, id) keyset, so a page break in the middle of the
    // collation difference is where a locale-ordered fake and the real thing
    // diverge visibly: page 2 would either repeat or skip a photo.
    clearPhotos();
    seedPhotos(
      { id: 'p1', data: { eventId: 'ev1', name: 'apple.jpg' } },
      { id: 'p2', data: { eventId: 'ev1', name: 'Banana.jpg' } },
      { id: 'p3', data: { eventId: 'ev1', name: '湘舍动.jpg' } },
    );
    const first = await request(app)
      .get('/api/events/ev1/photos?sort=name&limit=2')
      .set('x-test-user', USER);
    expect(first.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['p2', 'p1']);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await request(app)
      .get(`/api/events/ev1/photos?sort=name&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set('x-test-user', USER);
    expect(second.body.photos.map((p: { photoId: string }) => p.photoId)).toEqual(['p3']);
  });

  describe('club / tag filter', () => {
    const ids = (res: { body: { photos: Array<{ photoId: string }> } }): string[] =>
      res.body.photos.map((p) => p.photoId);

    beforeEach(() => {
      clearPhotos();
      seedPhotos(
        { id: 'a1', data: { eventId: 'ev1', name: 'a1.jpg', clubName: 'MMR', tag: '10K', addedAt: '2026-06-20T05:00:00' } },
        { id: 'a2', data: { eventId: 'ev1', name: 'a2.jpg', clubName: 'MMR', tag: '5K', addedAt: '2026-06-20T04:00:00' } },
        { id: 'a3', data: { eventId: 'ev1', name: 'a3.jpg', clubName: 'MMR', tag: '10K', addedAt: '2026-06-20T03:00:00' } },
        { id: 'b1', data: { eventId: 'ev1', name: 'b1.jpg', clubName: 'Harriers', tag: '10K', addedAt: '2026-06-20T02:00:00' } },
        { id: 'r1', data: { eventId: 'ev1', name: 'r1.jpg', clubName: '', tag: '', addedAt: '2026-06-20T01:00:00' } },
        { id: 'x1', data: { eventId: 'other', name: 'x1.jpg', clubName: 'MMR', tag: '10K', addedAt: '2026-06-20T06:00:00' } },
      );
    });

    it('defaults to every photo in the event (all clubs, all tags)', async () => {
      const res = await request(app).get('/api/events/ev1/photos').set('x-test-user', USER);
      expect(ids(res)).toEqual(['a1', 'a2', 'a3', 'b1', 'r1']);
    });

    it('?club= narrows to one club', async () => {
      const res = await request(app).get('/api/events/ev1/photos?club=MMR').set('x-test-user', USER);
      expect(ids(res)).toEqual(['a1', 'a2', 'a3']);
    });

    it('?club=&tag= narrows to one club + tag, and pages within it', async () => {
      const page1 = await request(app)
        .get('/api/events/ev1/photos?club=MMR&tag=10K&limit=1')
        .set('x-test-user', USER);
      expect(ids(page1)).toEqual(['a1']);
      const page2 = await request(app)
        .get(`/api/events/ev1/photos?club=MMR&tag=10K&limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
        .set('x-test-user', USER);
      expect(ids(page2)).toEqual(['a3']);
    });

    it('ignores a tag without a club (tag names repeat across clubs)', async () => {
      const res = await request(app).get('/api/events/ev1/photos?tag=10K').set('x-test-user', USER);
      expect(ids(res)).toEqual(['a1', 'a2', 'a3', 'b1', 'r1']);
    });

    it('handles non-ASCII club names', async () => {
      seedPhotos({ id: 'z1', data: { eventId: 'ev1', name: 'z1.jpg', clubName: '湘舍动', tag: 'ALL', addedAt: '2026-06-20T00:00:00' } });
      const res = await request(app)
        .get(`/api/events/ev1/photos?club=${encodeURIComponent('湘舍动')}`)
        .set('x-test-user', USER);
      expect(ids(res)).toEqual(['z1']);
    });

    it("returns the event's folders for the menus, dropping malformed entries", async () => {
      seedEvent('ev1', {
        name: 'Spring Run 2026',
        galleryFolders: [
          { clubName: 'Harriers', tag: '10K', count: 1 },
          { clubName: 'MMR', tag: '10K', count: 2 },
          { clubName: '', tag: 'ALL', count: 4 },
          { tag: 'nope' },
        ],
      });
      const res = await request(app).get('/api/events/ev1/photos').set('x-test-user', USER);
      expect(res.body.folders).toEqual([
        { clubName: 'Harriers', tag: '10K', count: 1 },
        { clubName: 'MMR', tag: '10K', count: 2 },
      ]);
    });

    it('returns no folders for an event indexed before they were recorded', async () => {
      const res = await request(app).get('/api/events/ev1/photos').set('x-test-user', USER);
      expect(res.body.folders).toEqual([]);
    });
  });
});

describe('POST /api/events/:id/photos/delete (admin)', () => {
  const app = buildServer();

  beforeEach(() => {
    clearEvents();
    clearPhotos();
    side.failTrash = false;
    side.trashed.length = 0;
    side.deletedDerivatives.length = 0;
    side.reindexed.length = 0;
    seedEvent('ev1', { name: 'Spring Run 2026', driveFolderId: 'folder1' });
    seedPhotos(
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
    expect(side.trashed).toEqual([]); // nothing touched
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
    expect(side.trashed.sort()).toEqual(['p1', 'p2']);
    expect(side.deletedDerivatives.sort()).toEqual(['p1', 'p2']);
    expect(store.peek('photos', 'p1')).toBeUndefined();
    expect(store.peek('photos', 'p2')).toBeUndefined();
    expect(side.reindexed).toEqual(['ev1']);
    expect(res.body.reindexSkipped).toBeUndefined();
    // The guarded trigger's claim is what stamps `queued`.
    expect(store.peek('events', 'ev1')?.indexState).toMatchObject({ status: 'queued' });
    // The event isn't a different one's photo: px untouched.
    expect(store.peek('photos', 'px')).toBeTruthy();
  });

  it('does not stack a second indexer run when one is already in flight', async () => {
    const running = { status: 'running', updatedAt: new Date().toISOString(), processed: 40, total: 900 };
    seedEvent('ev1', { name: 'Spring Run 2026', driveFolderId: 'folder1', indexState: running });
    const res = await request(app)
      .post('/api/events/ev1/photos/delete')
      .set('x-test-user', USER)
      .send({ photoIds: ['p1'] });
    expect(res.status).toBe(200);
    // The delete itself still happens in full.
    expect(res.body.deleted).toEqual(['p1']);
    expect(side.trashed).toEqual(['p1']);
    expect(store.peek('photos', 'p1')).toBeUndefined();
    // But no new execution, and the live run's state is left alone.
    expect(side.reindexed).toEqual([]);
    expect(res.body.reindex).toBeNull();
    expect(res.body.reindexSkipped).toBe('already_running');
    expect(store.peek('events', 'ev1')?.indexState).toEqual(running);
  });

  it('re-indexes when the in-flight state is stale (a dead run)', async () => {
    const stale = { status: 'running', updatedAt: '2026-01-01T00:00:00Z' };
    seedEvent('ev1', { name: 'Spring Run 2026', driveFolderId: 'folder1', indexState: stale });
    const res = await request(app)
      .post('/api/events/ev1/photos/delete')
      .set('x-test-user', USER)
      .send({ photoIds: ['p1'] });
    expect(res.status).toBe(200);
    expect(side.reindexed).toEqual(['ev1']);
    expect(res.body.reindex).toContain('photo-indexer');
    expect(store.peek('events', 'ev1')?.indexState).toMatchObject({ status: 'queued' });
  });

  it('reports photos not in this event as failed (and does not trash them)', async () => {
    const res = await request(app)
      .post('/api/events/ev1/photos/delete')
      .set('x-test-user', USER)
      .send({ photoIds: ['p1', 'px', 'ghost'] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual(['p1']);
    expect(res.body.failed.map((f: { photoId: string }) => f.photoId).sort()).toEqual(['ghost', 'px']);
    expect(side.trashed).toEqual(['p1']);
  });

  it('collects a Drive failure as failed without aborting and skips re-index when nothing deleted', async () => {
    side.failTrash = true;
    const res = await request(app)
      .post('/api/events/ev1/photos/delete')
      .set('x-test-user', USER)
      .send({ photoIds: ['p1'] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual([]);
    expect(res.body.failed[0].photoId).toBe('p1');
    expect(res.body.reindex).toBeNull();
    expect(side.reindexed).toEqual([]);
    // The index doc survives a failed trash (we delete it only after Drive succeeds).
    expect(store.peek('photos', 'p1')).toBeTruthy();
  });
});
