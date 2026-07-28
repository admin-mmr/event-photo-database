import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

// requireAuth mocked to read x-test-user; the role gate is the REAL middleware
// (checks ADMIN_EMAILS, default admin@mmrunners.org) so we exercise it.
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

// ── In-memory Firestore ──────────────────────────────────────────────────────
// Enough of the query surface for this feature: one orderBy+limit scan over
// match_feedback, an equality query on runId, doc reads on match_runs, the
// uid equality references.ts uses, and add() so admin_audit writes land.
interface Row {
  id: string;
  data: Record<string, unknown>;
}
const db: Record<string, Row[]> = {};
const rows = (name: string): Row[] => (db[name] ??= []);

interface Where {
  field: string;
  value: unknown;
}

function query(name: string, wheres: Where[], order: string | null, cap: number) {
  return {
    where: (field: string, _op: string, value: unknown) =>
      query(name, [...wheres, { field, value }], order, cap),
    orderBy: (field: string) => query(name, wheres, field, cap),
    limit: (n: number) => query(name, wheres, order, n),
    doc: (id: string) => ({
      get: async () => {
        const row = rows(name).find((r) => r.id === id);
        return { exists: Boolean(row), data: () => row?.data };
      },
    }),
    add: async (data: Record<string, unknown>) => {
      const id = `${name}-${rows(name).length + 1}`;
      rows(name).push({ id, data });
      return { id };
    },
    get: async () => {
      let out = rows(name).filter((r) => wheres.every((w) => r.data[w.field] === w.value));
      // Only descending order is used (newest first).
      if (order) {
        out = [...out].sort((a, b) => String(b.data[order]).localeCompare(String(a.data[order])));
      }
      const docs = out.slice(0, cap).map((r) => ({ id: r.id, data: () => r.data }));
      return { docs };
    },
  };
}

vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({ collection: (name: string) => query(name, [], null, Number.MAX_SAFE_INTEGER) }),
}));

vi.mock('../src/services/gcsService.js', () => ({
  signReferenceUrl: async (p: string) => `https://signed.example/ref?${encodeURIComponent(p)}`,
  signThumbUrls: async (eventId: string, ids: string[]) =>
    ids.map((photoId) => ({ photoId, thumbUrl: `t/${eventId}/${photoId}` })),
}));

const { buildServer } = await import('../src/server.js');

const ADMIN = JSON.stringify({ uid: 'a1', email: 'admin@mmrunners.org', emailVerified: true });
const MEMBER = JSON.stringify({ uid: 'u1', email: 'member@mmrunners.org', emailVerified: true });

function vote(
  id: string,
  over: Partial<Record<string, unknown>> = {},
): Row {
  return {
    id,
    data: {
      eventId: 'ev1',
      photoId: 'p1',
      verdict: 'not_me',
      runId: 'run-1',
      uid: 'u1',
      email: 'runner@x',
      createdAt: '2026-06-10T00:00:00.000Z',
      ...over,
    },
  };
}

function seed(): void {
  for (const k of Object.keys(db)) delete db[k];
  // Batch run-1 (event ev1, three verdicts) — the searcher marked two wrong and
  // one right out of five results.
  rows('match_feedback').push(
    vote('f1', { photoId: 'pA', verdict: 'not_me', createdAt: '2026-06-10T10:00:00.000Z' }),
    vote('f2', { photoId: 'pB', verdict: 'confirmed', createdAt: '2026-06-10T10:01:00.000Z' }),
    vote('f3', { photoId: 'pC', verdict: 'not_me', createdAt: '2026-06-10T10:02:00.000Z' }),
    // Batch run-2 on a different event, marked later → listed first.
    vote('f4', {
      runId: 'run-2',
      eventId: 'ev2',
      photoId: 'pZ',
      verdict: 'confirmed',
      uid: 'u2',
      email: null,
      createdAt: '2026-06-11T09:00:00.000Z',
    }),
    // A vote with no runId belongs to no batch — counted, never grouped.
    vote('f5', { runId: null, photoId: 'pQ', createdAt: '2026-06-11T12:00:00.000Z' }),
  );
  rows('match_runs').push(
    {
      id: 'run-1',
      data: {
        uid: 'u1',
        eventId: 'ev1',
        mode: 'fused',
        modelVersion: 'm-1',
        algo: { version: 'v3', tnorm: false, prf: true, prfCount: 2, numReferences: 3 },
        uploadId: 'up-1',
        searcherName: 'Jamie Lee',
        resultPhotoIds: ['pB', 'pC', 'pA', 'pD', 'pE'],
        scores: { pA: 0.71, pB: 0.93, pC: 0.75 },
        createdAt: '2026-06-10T09:55:00.000Z',
      },
    },
    {
      // Legacy run: no uploadId, so the selfie must be recovered by joining
      // find_me_uploads on (uid, eventId, exact createdAt).
      id: 'run-2',
      data: {
        uid: 'u2',
        eventId: 'ev2',
        mode: 'person',
        resultPhotoIds: ['pZ'],
        createdAt: '2026-06-11T08:59:00.000Z',
      },
    },
  );
  rows('find_me_uploads').push(
    {
      id: 'up-1',
      data: {
        uploadId: 'up-1',
        uid: 'u1',
        eventId: 'ev1',
        gcsPath: 'refs/u1/up-1.jpg',
        name: 'Jamie Lee',
        createdAt: '2026-06-10T09:55:00.000Z',
      },
    },
    {
      id: 'up-2',
      data: {
        uploadId: 'up-2',
        uid: 'u2',
        eventId: 'ev2',
        gcsPath: 'refs/u2/up-2.jpg',
        name: 'Alex Roe',
        createdAt: '2026-06-11T08:59:00.000Z',
      },
    },
    {
      // Same user, different search — must NOT be matched to run-2.
      id: 'up-3',
      data: {
        uploadId: 'up-3',
        uid: 'u2',
        eventId: 'ev2',
        gcsPath: 'refs/u2/up-3.jpg',
        name: 'Alex Roe',
        createdAt: '2026-06-01T08:00:00.000Z',
      },
    },
  );
}

describe('admin verdict-batch review', () => {
  const app = buildServer();
  beforeEach(seed);

  describe('GET /api/admin/verdict-batches', () => {
    it('requires auth', async () => {
      const res = await request(app).get('/api/admin/verdict-batches');
      expect(res.status).toBe(401);
    });

    it('forbids non-admins', async () => {
      const res = await request(app).get('/api/admin/verdict-batches').set('x-test-user', MEMBER);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    });

    it('groups verdicts into batches, newest-marked first', async () => {
      const res = await request(app).get('/api/admin/verdict-batches').set('x-test-user', ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.batches.map((b: { runId: string }) => b.runId)).toEqual(['run-2', 'run-1']);
      // Votes with no runId can't be attributed to a search.
      expect(res.body.unattributed).toBe(1);
      expect(res.body.capped).toBe(false);

      const run1 = res.body.batches[1];
      expect(run1).toMatchObject({
        eventId: 'ev1',
        uid: 'u1',
        email: 'runner@x',
        name: 'Jamie Lee',
        mode: 'fused',
        modelVersion: 'm-1',
        searchVersion: 'v3',
        markedAt: '2026-06-10T10:02:00.000Z',
        searchedAt: '2026-06-10T09:55:00.000Z',
        // Three of five results were judged.
        resultCount: 5,
        counts: { not_me: 2, confirmed: 1 },
        total: 3,
      });
      expect(run1.selfieUrl).toContain('refs%2Fu1%2Fup-1.jpg');
    });

    it('recovers the selfie for a run that predates the run→selfie link', async () => {
      const res = await request(app).get('/api/admin/verdict-batches').set('x-test-user', ADMIN);
      const run2 = res.body.batches[0];
      // Joined on the exact createdAt runSearch stamped on both records — the
      // user's other selfie (up-3) must not be picked.
      expect(run2.selfieUploadId).toBe('up-2');
      expect(run2.selfieUrl).toContain('refs%2Fu2%2Fup-2.jpg');
      expect(run2.name).toBe('Alex Roe');
    });

    it('filters by event before grouping', async () => {
      const res = await request(app)
        .get('/api/admin/verdict-batches?eventId=ev2')
        .set('x-test-user', ADMIN);
      expect(res.body.total).toBe(1);
      expect(res.body.batches[0].runId).toBe('run-2');
      expect(res.body.unattributed).toBe(0);
    });

    it('filters by searcher email, case-insensitively', async () => {
      const res = await request(app)
        .get('/api/admin/verdict-batches?email=RUNNER@X')
        .set('x-test-user', ADMIN);
      expect(res.body.total).toBe(1);
      expect(res.body.batches[0].runId).toBe('run-1');
    });

    it('clamps the page size and audits the access', async () => {
      const res = await request(app)
        .get('/api/admin/verdict-batches?limit=1')
        .set('x-test-user', ADMIN);
      expect(res.body.total).toBe(1);
      expect(res.body.batches[0].runId).toBe('run-2');

      const audit = rows('admin_audit').at(-1)!.data;
      expect(audit).toMatchObject({ action: 'verdict_batch_list', adminEmail: 'admin@mmrunners.org' });
    });
  });

  describe('GET /api/admin/verdict-batches/:runId', () => {
    it('returns the selfie and every verdict in the batch, in result order', async () => {
      const res = await request(app)
        .get('/api/admin/verdict-batches/run-1')
        .set('x-test-user', ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.batch.counts).toEqual({ not_me: 2, confirmed: 1 });
      expect(res.body.batch.selfieUrl).toContain('refs%2Fu1%2Fup-1.jpg');
      // Ordered by the run's own ranking (pB, pC, pA), not by vote time.
      expect(res.body.batch.votes.map((v: { photoId: string }) => v.photoId)).toEqual([
        'pB',
        'pC',
        'pA',
      ]);
      expect(res.body.batch.votes[0]).toMatchObject({
        feedbackId: 'f2',
        verdict: 'confirmed',
        score: 0.93,
        rank: 1,
        thumbUrl: 't/ev1/pB',
      });
      expect(res.body.batch.votes[2]).toMatchObject({ photoId: 'pA', rank: 3, score: 0.71 });
    });

    it('audits the view with the selfie owner and event', async () => {
      await request(app).get('/api/admin/verdict-batches/run-1').set('x-test-user', ADMIN);
      const audit = rows('admin_audit').at(-1)!.data;
      expect(audit).toMatchObject({
        action: 'verdict_batch_view',
        uploadId: 'up-1',
        targetUid: 'u1',
        eventId: 'ev1',
      });
    });

    it('404s for a batch with no verdicts and no run', async () => {
      const res = await request(app)
        .get('/api/admin/verdict-batches/run-nope')
        .set('x-test-user', ADMIN);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    });

    it('still describes a run whose verdicts were erased', async () => {
      db.match_feedback = [];
      const res = await request(app)
        .get('/api/admin/verdict-batches/run-1')
        .set('x-test-user', ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.batch).toMatchObject({
        eventId: 'ev1',
        uid: 'u1',
        total: 0,
        counts: { not_me: 0, confirmed: 0 },
      });
      expect(res.body.batch.votes).toEqual([]);
    });

    it('forbids non-admins', async () => {
      const res = await request(app)
        .get('/api/admin/verdict-batches/run-1')
        .set('x-test-user', MEMBER);
      expect(res.status).toBe(403);
    });
  });
});
