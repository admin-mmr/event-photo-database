import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

// Config is parsed from process.env at import time — set before importing the
// server so the sync route sees a configured spreadsheet + cron secret.
process.env.MASTER_SPREADSHEET_ID = 'sheet-123';
process.env.SYNC_TRIGGER_TOKEN = 'cron-secret';

// Fake auth: trusts an `x-test-user` header instead of verifying Firebase tokens.
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

const reconcile = vi.fn(async () => ({
  spreadsheetId: 'sheet-123',
  scanned: 2,
  created: 1,
  updated: 0,
  unchanged: 1,
  tagsLinked: 3,
  orphans: ['ev_gone'],
  events: [{ eventId: 'ev1', name: 'Spring Run', action: 'created' as const, tags: ['finish_line'] }],
  durationMs: 5,
}));
vi.mock('../src/services/reconcileService.js', () => ({
  reconcile: (...args: unknown[]) => reconcile(...(args as [])),
}));

const { buildServer } = await import('../src/server.js');

const ADMIN = JSON.stringify({ uid: 'u1', email: 'admin@mmrunners.org', emailVerified: true });
const MEMBER = JSON.stringify({ uid: 'u2', email: 'member@mmrunners.org', emailVerified: true });

describe('POST /api/admin/sync', () => {
  const app = buildServer();

  beforeEach(() => reconcile.mockClear());

  it('401s without auth or a cron token', async () => {
    const res = await request(app).post('/api/admin/sync');
    expect(res.status).toBe(401);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('403s for a non-admin Firebase user', async () => {
    const res = await request(app).post('/api/admin/sync').set('x-test-user', MEMBER);
    expect(res.status).toBe(403);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('runs the reconcile for a Firebase admin and returns the report', async () => {
    const res = await request(app).post('/api/admin/sync').set('x-test-user', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, scanned: 2, created: 1, unchanged: 1, tagsLinked: 3 });
    expect(res.body.orphans).toEqual(['ev_gone']);
    expect(reconcile).toHaveBeenCalledWith('sheet-123');
  });

  it('accepts a valid cron token in place of a Firebase admin', async () => {
    const res = await request(app).post('/api/admin/sync').set('x-sync-token', 'cron-secret');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('rejects a wrong cron token (falls back to auth → 401)', async () => {
    const res = await request(app).post('/api/admin/sync').set('x-sync-token', 'nope');
    expect(res.status).toBe(401);
    expect(reconcile).not.toHaveBeenCalled();
  });
});
