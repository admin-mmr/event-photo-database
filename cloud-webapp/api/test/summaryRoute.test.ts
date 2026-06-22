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

const summarize = vi.fn(async (_sid: string, filter?: { clubName?: string }) => ({
  totals: { sessions: 2, files: 30, sizeMb: 10 },
  byClub: [{ clubName: filter?.clubName ?? 'CHI', sessions: 2, files: 30, sizeMb: 10 }],
}));
vi.mock('../src/services/summaryService.js', () => ({ summarize: (...a: unknown[]) => summarize(...(a as [string, never])) }));

const { buildServer } = await import('../src/server.js');

const SUPER = JSON.stringify({ uid: 's', email: 'boss@x.org', emailVerified: true, role: 'super_admin' });
const CHI = JSON.stringify({ uid: 'c', email: 'ca@x.org', emailVerified: true, role: 'club_admin', clubId: 'CHI' });

describe('GET /api/admin/summary', () => {
  const app = buildServer();
  beforeEach(() => summarize.mockClear());

  it('requires an admin', async () => {
    expect((await request(app).get('/api/admin/summary')).status).toBe(401);
  });

  it('returns totals for a super_admin (all clubs)', async () => {
    const res = await request(app).get('/api/admin/summary?since=2026-06-01').set('x-test-user', SUPER);
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ sessions: 2, files: 30 });
    expect(summarize.mock.calls[0]?.[1]).toMatchObject({ since: '2026-06-01' });
    expect(summarize.mock.calls[0]?.[1]?.clubName).toBeUndefined();
  });

  it('scopes a club_admin to their own club', async () => {
    await request(app).get('/api/admin/summary').set('x-test-user', CHI);
    expect(summarize.mock.calls[0]?.[1]).toMatchObject({ clubName: 'CHI' });
  });
});
