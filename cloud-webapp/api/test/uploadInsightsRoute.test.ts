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
    requireOwner: (req: Request, res: Response, next: NextFunction) =>
      req.user?.role === 'owner' ? next() : res.status(403).json({ ok: false, error: 'forbidden' }),
    requireSuperAdmin: (req: Request, res: Response, next: NextFunction) =>
      req.user?.role === 'super_admin' ? next() : deny(res),
    requireAnyAdmin: (req: Request, res: Response, next: NextFunction) =>
      req.user?.role === 'super_admin' || req.user?.role === 'club_admin' ? next() : deny(res),
    requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
    requireClubScope: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  };
});

const loadUploadInsights = vi.fn(async (eventId: string, _opts: unknown) => ({
  ok: true,
  eventId,
  generatedAt: '2026-11-02T12:00:00.000Z',
  indexCountsAt: null,
  stagingListed: true,
  truncated: false,
  warnings: [],
  totals: {},
  groups: [],
}));
vi.mock('../src/services/uploadInsightsService.js', () => ({
  loadUploadInsights: (...a: unknown[]) => loadUploadInsights(...(a as [string, unknown])),
}));

const { buildServer } = await import('../src/server.js');

const SUPER = JSON.stringify({ uid: 's', email: 'boss@x.org', emailVerified: true, role: 'super_admin' });
const CHI = JSON.stringify({ uid: 'c', email: 'ca@x.org', emailVerified: true, role: 'club_admin', clubId: 'CHI' });
const MEMBER = JSON.stringify({ uid: 'm', email: 'm@x.org', emailVerified: true, role: 'member' });

describe('GET /api/admin/upload-insights/:eventId', () => {
  const app = buildServer();
  beforeEach(() => loadUploadInsights.mockClear());

  it('requires a signed-in admin', async () => {
    expect((await request(app).get('/api/admin/upload-insights/ev1')).status).toBe(401);
    expect((await request(app).get('/api/admin/upload-insights/ev1').set('x-test-user', MEMBER)).status).toBe(403);
    expect(loadUploadInsights).not.toHaveBeenCalled();
  });

  it('gives a super_admin every club', async () => {
    const res = await request(app).get('/api/admin/upload-insights/ev1').set('x-test-user', SUPER);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, eventId: 'ev1' });
    expect(loadUploadInsights.mock.calls[0]?.[1]).toMatchObject({ spreadsheetId: 'sheet1', clubScope: undefined });
  });

  it('scopes a club_admin to their own club', async () => {
    await request(app).get('/api/admin/upload-insights/ev1').set('x-test-user', CHI);
    expect(loadUploadInsights.mock.calls[0]?.[1]).toMatchObject({ clubScope: 'CHI' });
  });

  it('a masquerading super_admin sees only the masqueraded club', async () => {
    await request(app)
      .get('/api/admin/upload-insights/ev1')
      .set('x-test-user', SUPER)
      .set('X-Masquerade-Club', 'Harriers');
    expect(loadUploadInsights.mock.calls[0]?.[1]).toMatchObject({ clubScope: 'Harriers' });
  });
});
