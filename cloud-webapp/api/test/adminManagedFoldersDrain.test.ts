/**
 * POST /api/admin/folders/rebuild-drain while managed folders are switched OFF
 * (`event-scale.sh up` sets MANAGED_FOLDERS_ENABLED=false for a big event).
 *
 * The `findme-folder-rebuild` scheduler keeps ticking every 2 minutes. When this
 * route answered 503, each tick was an ERROR log line — 720 a day from
 * 2026-10-31 — and the api's ERROR alert emailed every 5 minutes, burying real
 * alerts. Switched off, the drain must be a quiet 200 no-op; the human-facing
 * routes keep their 503 so an admin still hears the feature is off.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

// Must be set before config.ts is imported by the server.
process.env.SYNC_TRIGGER_TOKEN = 'cron-secret';
process.env.MASTER_SPREADSHEET_ID = 'sheet1';
process.env.MANAGED_FOLDERS_ENABLED = 'false';

vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers['x-test-user'];
    if (!raw) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    req.user = JSON.parse(String(raw));
    next();
  },
}));
vi.mock('../src/middleware/rbac.js', () => ({
  attachRole: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAnyAdmin: (req: Request, res: Response, next: NextFunction) =>
    req.user?.role === 'super_admin' ? next() : res.status(403).json({ ok: false, error: 'forbidden' }),
  requireOwner: (_req: Request, res: Response) => res.status(403).json({ ok: false, error: 'forbidden' }),
  requireSuperAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireClubScope: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const drainRebuildQueue = vi.fn();
vi.mock('../src/services/folderRebuildQueue.js', () => ({
  drainRebuildQueue: () => drainRebuildQueue(),
  enqueueRebuild: vi.fn(),
  enqueueFullRebuild: vi.fn(),
  getBatch: vi.fn(),
  latestBatch: vi.fn(),
}));

const { buildServer } = await import('../src/server.js');
const { env } = await import('../src/lib/config.js');

const ADMIN = JSON.stringify({ uid: 's', email: 'boss@x.org', emailVerified: true, role: 'super_admin' });
const DRAIN = '/api/admin/folders/rebuild-drain';

beforeEach(() => {
  drainRebuildQueue.mockReset();
  drainRebuildQueue.mockResolvedValue({ drained: true, processed: 2, failed: 0, remaining: 0, finished: true });
  (env as { MANAGED_FOLDERS_ENABLED: string }).MANAGED_FOLDERS_ENABLED = 'false';
});

describe('rebuild-drain with managed folders switched off', () => {
  const app = buildServer();

  it('the scheduler tick is a 200 no-op that touches no queue', async () => {
    const res = await request(app).post(DRAIN).set('X-Sync-Token', 'cron-secret').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, skipped: 'not_enabled', drained: false, processed: 0 });
    expect(drainRebuildQueue).not.toHaveBeenCalled();
  });

  it('still rejects a caller without the machine token or an admin login', async () => {
    const res = await request(app).post(DRAIN).send({});
    expect(res.status).toBe(401);
  });

  it('a person starting a rebuild still gets a 503 not_enabled', async () => {
    const res = await request(app).post('/api/admin/folders/rebuild-photos').set('x-test-user', ADMIN).send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('not_enabled');
  });

  it('switched back on, the drain works as before', async () => {
    (env as { MANAGED_FOLDERS_ENABLED: string }).MANAGED_FOLDERS_ENABLED = 'true';
    const res = await request(app).post(DRAIN).set('X-Sync-Token', 'cron-secret').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, drained: true, processed: 2 });
    expect(drainRebuildQueue).toHaveBeenCalledTimes(1);
  });
});
