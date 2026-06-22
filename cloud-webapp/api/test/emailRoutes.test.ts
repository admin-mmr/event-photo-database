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
// Machine/admin gate for the digest: passthrough.
vi.mock('../src/middleware/cronAuth.js', () => ({
  allowCronOrAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const prefs = { email: 'ca@x.org', userCreated: true, userRoleChanged: true, userDeactivated: true, securityEvent: true, eventCreated: true, dailyReport: false, weeklyReport: false, updatedAt: 't' };
const getPrefs = vi.fn(async () => prefs);
const setPrefs = vi.fn(async (_sid: string, _email: string, patch: Record<string, boolean>) => ({ ...prefs, ...patch }));
const optedInAmong = vi.fn(async () => ['a@x.org']);
vi.mock('../src/services/emailPrefsStore.js', () => ({
  getPrefs: (...a: unknown[]) => getPrefs(...(a as [])),
  setPrefs: (...a: unknown[]) => setPrefs(...(a as [string, string, Record<string, boolean>])),
  optedInAmong: (...a: unknown[]) => optedInAmong(...(a as [])),
}));

const listAudit = vi.fn(async () => [{ action: 'EVENT_CREATED', resourceId: 'ev1', actorEmail: 'boss@x.org' }]);
vi.mock('../src/services/auditStore.js', () => ({ listAudit: (...a: unknown[]) => listAudit(...(a as [])) }));

const listUsers = vi.fn(async () => [{ email: 'a@x.org', role: 'club_admin', status: 'active' }]);
vi.mock('../src/services/userStore.js', () => ({ listUsers: (...a: unknown[]) => listUsers(...(a as [])) }));

const sendToMany = vi.fn(async (recipients: string[]) => recipients.length);
vi.mock('../src/services/emailService.js', () => ({ sendToMany: (...a: unknown[]) => sendToMany(...(a as [string[]])) }));

const { buildServer } = await import('../src/server.js');

const CLUB = JSON.stringify({ uid: 'c', email: 'ca@x.org', emailVerified: true, role: 'club_admin', clubId: 'CHI' });

describe('email prefs routes', () => {
  const app = buildServer();
  beforeEach(() => {
    getPrefs.mockClear();
    setPrefs.mockClear();
  });

  it('GET returns the caller’s own prefs', async () => {
    const res = await request(app).get('/api/admin/email-prefs').set('x-test-user', CLUB);
    expect(res.status).toBe(200);
    expect(res.body.prefs.email).toBe('ca@x.org');
  });

  it('PATCH updates and validates', async () => {
    const ok = await request(app).patch('/api/admin/email-prefs').set('x-test-user', CLUB).send({ dailyReport: true });
    expect(ok.status).toBe(200);
    expect(ok.body.prefs.dailyReport).toBe(true);
    const bad = await request(app).patch('/api/admin/email-prefs').set('x-test-user', CLUB).send({});
    expect(bad.status).toBe(400);
  });

  it('requires auth', async () => {
    expect((await request(app).get('/api/admin/email-prefs')).status).toBe(401);
  });
});

describe('POST /api/admin/email/daily', () => {
  const app = buildServer();
  beforeEach(() => {
    listAudit.mockClear();
    optedInAmong.mockClear();
    sendToMany.mockClear();
  });

  it('summarizes 24h of audit and sends to opted-in admins', async () => {
    const res = await request(app).post('/api/admin/email/daily').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, changes: 1, recipients: 1, sent: 1 });
    expect(sendToMany).toHaveBeenCalledTimes(1);
  });
});
