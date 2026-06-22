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
    requireRole:
      (...roles: string[]) =>
      (req: Request, res: Response, next: NextFunction) =>
        roles.includes(req.user?.role as string) ? next() : deny(res),
    requireClubScope: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  };
});

const recordAudit = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../src/services/auditStore.js', () => ({ recordAudit: (...a: unknown[]) => recordAudit(...a) }));

interface C {
  displayName: string;
  normalizedName: string;
  status: string;
  addedAt: string;
  addedBy: string;
}
const clubs = new Map<string, C>();
class ClubStoreError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ClubStoreError';
  }
}
const NORM_RE = /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$/;
vi.mock('../src/services/clubStore.js', () => ({
  ClubStoreError,
  NORMALIZED_NAME_RE: NORM_RE,
  listClubs: async () => [...clubs.values()],
  getClub: async (_sid: string, n: string) => clubs.get(n) ?? null,
  createClub: async (_sid: string, input: { displayName: string; normalizedName: string }, actorEmail: string) => {
    if (!NORM_RE.test(input.normalizedName)) throw new ClubStoreError('invalid', 'bad name');
    if (clubs.has(input.normalizedName)) throw new ClubStoreError('duplicate', 'dup');
    const c: C = { displayName: input.displayName, normalizedName: input.normalizedName, status: 'active', addedAt: 't', addedBy: actorEmail };
    clubs.set(c.normalizedName, c);
    return c;
  },
  updateClub: async (_sid: string, n: string, patch: { displayName: string }) => {
    const c = clubs.get(n);
    if (!c) throw new ClubStoreError('not_found', 'nf');
    c.displayName = patch.displayName;
    return c;
  },
  setClubStatus: async (_sid: string, n: string, status: string) => {
    const c = clubs.get(n);
    if (!c) throw new ClubStoreError('not_found', 'nf');
    c.status = status;
    return c;
  },
}));

const { buildServer } = await import('../src/server.js');

const SUPER = JSON.stringify({ uid: 's', email: 'boss@x.org', emailVerified: true, role: 'super_admin', clubId: '' });
const CLUB = JSON.stringify({ uid: 'c', email: 'ca@x.org', emailVerified: true, role: 'club_admin', clubId: 'CHI' });

describe('admin clubs routes', () => {
  const app = buildServer();

  beforeEach(() => {
    clubs.clear();
    recordAudit.mockClear();
    clubs.set('CHI', { displayName: 'Chicago', normalizedName: 'CHI', status: 'active', addedAt: 't', addedBy: 'boss@x.org' });
  });

  it('lists clubs for any admin', async () => {
    const res = await request(app).get('/api/admin/clubs').set('x-test-user', CLUB);
    expect(res.status).toBe(200);
    expect(res.body.clubs).toHaveLength(1);
  });

  it('create: super_admin only, validates name, audits, rejects dupes', async () => {
    expect((await request(app).post('/api/admin/clubs').set('x-test-user', CLUB).send({ displayName: 'X', normalizedName: 'NYC' })).status).toBe(403);

    const ok = await request(app).post('/api/admin/clubs').set('x-test-user', SUPER).send({ displayName: 'New York', normalizedName: 'NYC' });
    expect(ok.status).toBe(201);
    expect(recordAudit.mock.calls[0]?.[1]).toMatchObject({ action: 'CLUB_CREATED', resourceType: 'club' });

    const bad = await request(app).post('/api/admin/clubs').set('x-test-user', SUPER).send({ displayName: 'X', normalizedName: 'bad name' });
    expect(bad.status).toBe(400);

    const dup = await request(app).post('/api/admin/clubs').set('x-test-user', SUPER).send({ displayName: 'Chi', normalizedName: 'CHI' });
    expect(dup.status).toBe(409);
  });

  it('rename + deactivate audit; unknown → 404', async () => {
    const r = await request(app).patch('/api/admin/clubs/CHI').set('x-test-user', SUPER).send({ displayName: 'Chicago Runners' });
    expect(r.body.club.displayName).toBe('Chicago Runners');
    expect(recordAudit.mock.calls[0]?.[1]).toMatchObject({ action: 'CLUB_UPDATED' });

    const d = await request(app).post('/api/admin/clubs/CHI/deactivate').set('x-test-user', SUPER);
    expect(d.body.club.status).toBe('inactive');

    const nf = await request(app).patch('/api/admin/clubs/NOPE').set('x-test-user', SUPER).send({ displayName: 'x' });
    expect(nf.status).toBe(404);
  });
});
