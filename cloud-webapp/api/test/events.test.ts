import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

// Config is parsed from process.env at import time — set the cron secret before
// importing the server so the machine-caller (X-Sync-Token) path is enabled.
process.env.SYNC_TRIGGER_TOKEN = 'cron-secret';

// ── mocks (must precede the server import) ──────────────────────────────────

// Fake auth: trusts an `x-test-user` header instead of verifying Firebase
// tokens (the real middleware initializes firebase-admin at import time).
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
  sets: [] as Array<{ id: string; data: Record<string, unknown> }>,
};

vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: (name: string) => {
      if (name !== 'events') throw new Error(`unexpected collection ${name}`);
      return {
        get: async () => ({
          docs: [...fakeDb.events.entries()].map(([id, data]) => ({ id, data: () => data })),
        }),
        doc: (id: string) => ({
          get: async () => ({ exists: fakeDb.events.has(id), data: () => fakeDb.events.get(id) }),
          set: async (data: Record<string, unknown>) => {
            fakeDb.sets.push({ id, data });
            fakeDb.events.set(id, { ...fakeDb.events.get(id), ...data });
          },
        }),
      };
    },
  }),
}));

const triggerIndexJob = vi.fn(async () => ({
  execution: 'projects/p/locations/us-central1/jobs/photo-indexer/executions/exec-1',
}));
vi.mock('../src/services/indexerJob.js', () => ({
  triggerIndexJob: (...args: unknown[]) => triggerIndexJob(...(args as [])),
}));

const { buildServer } = await import('../src/server.js');

// ── helpers ──────────────────────────────────────────────────────────────────

const ADMIN = JSON.stringify({ uid: 'u1', email: 'admin@mmrunners.org', emailVerified: true });
const MEMBER = JSON.stringify({ uid: 'u2', email: 'member@mmrunners.org', emailVerified: true });
const UNVERIFIED = JSON.stringify({ uid: 'u3', email: 'admin@mmrunners.org', emailVerified: false });

describe('events routes', () => {
  const app = buildServer();

  beforeEach(() => {
    fakeDb.events.clear();
    fakeDb.sets.length = 0;
    triggerIndexJob.mockClear();
    fakeDb.events.set('ev1', {
      name: 'Spring Run 2026',
      driveFolderId: 'folder123',
      indexState: { status: 'done', photoCount: 42 },
      legacyGasAppField: 'should be stripped',
    });
    fakeDb.events.set('ev2', { name: 'No-folder event' });
  });

  describe('GET /api/events', () => {
    it('requires auth', async () => {
      const res = await request(app).get('/api/events');
      expect(res.status).toBe(401);
    });

    it('lists events with unknown fields stripped', async () => {
      const res = await request(app).get('/api/events').set('x-test-user', MEMBER);
      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(2);
      const ev1 = res.body.events.find((e: { id: string }) => e.id === 'ev1');
      expect(ev1.indexState.photoCount).toBe(42);
      expect(ev1.legacyGasAppField).toBeUndefined();
    });
  });

  describe('POST /api/events/:id/index', () => {
    it('403s for non-admins and unverified admins', async () => {
      for (const user of [MEMBER, UNVERIFIED]) {
        const res = await request(app).post('/api/events/ev1/index').set('x-test-user', user);
        expect(res.status).toBe(403);
      }
      expect(triggerIndexJob).not.toHaveBeenCalled();
    });

    it('triggers the job and marks the event queued', async () => {
      const res = await request(app).post('/api/events/ev1/index').set('x-test-user', ADMIN);
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ ok: true, eventId: 'ev1' });
      expect(res.body.execution).toContain('executions/exec-1');
      expect(triggerIndexJob).toHaveBeenCalledWith('ev1', { force: false });
      const queued = fakeDb.sets.find((s) => s.id === 'ev1');
      expect(queued?.data).toMatchObject({ indexState: { status: 'queued' } });
      expect((queued?.data.indexState as { updatedAt?: string }).updatedAt).toBeTruthy();
    });

    it('passes force through', async () => {
      await request(app)
        .post('/api/events/ev1/index')
        .set('x-test-user', ADMIN)
        .send({ force: true });
      expect(triggerIndexJob).toHaveBeenCalledWith('ev1', { force: true });
    });

    it('404s on unknown event', async () => {
      const res = await request(app).post('/api/events/nope/index').set('x-test-user', ADMIN);
      expect(res.status).toBe(404);
    });

    it('409s when the event has no driveFolderId', async () => {
      const res = await request(app).post('/api/events/ev2/index').set('x-test-user', ADMIN);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('no_drive_folder');
    });

    it('409s when a run is already in progress (unless forced)', async () => {
      fakeDb.events.set('ev1', { driveFolderId: 'f', indexState: { status: 'running' } });
      const res = await request(app).post('/api/events/ev1/index').set('x-test-user', ADMIN);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('already_running');

      const forced = await request(app)
        .post('/api/events/ev1/index')
        .set('x-test-user', ADMIN)
        .send({ force: true });
      expect(forced.status).toBe(202);
    });

    it('accepts the machine X-Sync-Token path (no Firebase user)', async () => {
      const res = await request(app).post('/api/events/ev1/index').set('X-Sync-Token', 'cron-secret');
      expect(res.status).toBe(202);
      expect(triggerIndexJob).toHaveBeenCalledWith('ev1', { force: false });
    });

    it('rejects a wrong token with 401 (falls through to auth)', async () => {
      const res = await request(app).post('/api/events/ev1/index').set('X-Sync-Token', 'nope');
      expect(res.status).toBe(401);
      expect(triggerIndexJob).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/admin/index-scan', () => {
    it('requires the cron token or an admin', async () => {
      const res = await request(app).post('/api/admin/index-scan');
      expect(res.status).toBe(401);
      expect(triggerIndexJob).not.toHaveBeenCalled();
    });

    it('triggers indexable events and skips folderless ones', async () => {
      const res = await request(app).post('/api/admin/index-scan').set('X-Sync-Token', 'cron-secret');
      expect(res.status).toBe(200);
      expect(res.body.triggered).toEqual(['ev1']); // ev2 has no driveFolderId
      expect(res.body.skipped).toContainEqual({ eventId: 'ev2', reason: 'no_drive_folder' });
      expect(triggerIndexJob).toHaveBeenCalledWith('ev1');
      const queued = fakeDb.sets.find((s) => s.id === 'ev1');
      expect(queued?.data).toMatchObject({ indexState: { status: 'queued' } });
    });

    it('skips events already running/queued', async () => {
      fakeDb.events.set('ev1', { driveFolderId: 'f', indexState: { status: 'running' } });
      const res = await request(app).post('/api/admin/index-scan').set('X-Sync-Token', 'cron-secret');
      expect(res.status).toBe(200);
      expect(res.body.triggered).toEqual([]);
      expect(res.body.skipped).toContainEqual({ eventId: 'ev1', reason: 'already_running' });
    });

    it('skips events outside the active window', async () => {
      fakeDb.events.set('ev1', { driveFolderId: 'f', date: '2000-01-01' });
      const res = await request(app)
        .post('/api/admin/index-scan?activeWithinDays=7')
        .set('X-Sync-Token', 'cron-secret');
      expect(res.body.skipped).toContainEqual({ eventId: 'ev1', reason: 'outside_active_window' });
    });
  });
});
