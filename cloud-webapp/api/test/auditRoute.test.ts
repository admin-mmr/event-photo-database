import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

process.env.MASTER_SPREADSHEET_ID = 'sheet1';

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
vi.mock('../src/middleware/rbac.js', () => {
  const deny = (res: Response) => res.status(403).json({ ok: false, error: 'forbidden' });
  return {
    attachRole: (_req: Request, _res: Response, next: NextFunction) => next(),
    requireSuperAdmin: (req: Request, res: Response, next: NextFunction) =>
      req.user?.role === 'super_admin' ? next() : deny(res),
    requireAnyAdmin: (req: Request, res: Response, next: NextFunction) =>
      req.user?.role === 'super_admin' || req.user?.role === 'club_admin' ? next() : deny(res),
    requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
    requireClubScope: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  };
});

const listAudit = vi.fn(async (_sid: string, _filter: unknown) => [
  { auditId: 'a1', timestamp: '2026-06-20T00:00:00Z', actorEmail: 'boss@x.org', action: 'USER_CREATED', resourceType: 'user', resourceId: 'u@x.org', details: '', linkId: '', ip: '', reason: '' },
]);
vi.mock('../src/services/auditStore.js', () => ({ listAudit: (...a: unknown[]) => listAudit(...(a as [string, unknown])) }));

const { buildServer } = await import('../src/server.js');

const SUPER = JSON.stringify({ uid: 's', email: 'boss@x.org', emailVerified: true, role: 'super_admin' });
const CLUB = JSON.stringify({ uid: 'c', email: 'ca@x.org', emailVerified: true, role: 'club_admin', clubId: 'CHI' });

describe('GET /api/admin/audit', () => {
  const app = buildServer();
  beforeEach(() => listAudit.mockClear());

  it('is super-admin only', async () => {
    expect((await request(app).get('/api/admin/audit')).status).toBe(401);
    expect((await request(app).get('/api/admin/audit').set('x-test-user', CLUB)).status).toBe(403);
  });

  it('returns records and passes filters through', async () => {
    const res = await request(app)
      .get('/api/admin/audit?actor=boss@x.org&type=user&action=USER&since=2026-06-01')
      .set('x-test-user', SUPER);
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.total).toBe(1);
    const filter = listAudit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(filter).toMatchObject({ actorEmail: 'boss@x.org', resourceType: 'user', action: 'USER', since: '2026-06-01' });
  });

  it('ignores an unknown resource type', async () => {
    await request(app).get('/api/admin/audit?type=bogus').set('x-test-user', SUPER);
    const filter = listAudit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(filter.resourceType).toBeUndefined();
  });
});
