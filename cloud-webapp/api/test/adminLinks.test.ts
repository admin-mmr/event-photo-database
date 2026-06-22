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

const recordAudit = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../src/services/auditStore.js', () => ({ recordAudit: (...a: unknown[]) => recordAudit(...a) }));

interface L {
  linkId: string;
  eventId: string;
  clubName: string;
  token: string;
  version: number;
  tag: string;
  status: string;
  revokedReason?: string;
}
let links: L[] = [];
const listLinks = vi.fn(async (_sid: string, filter?: { eventId?: string; clubName?: string; status?: string }) => {
  let arr = [...links];
  if (filter?.eventId !== undefined) arr = arr.filter((l) => l.eventId === filter.eventId);
  if (filter?.clubName !== undefined) arr = arr.filter((l) => l.clubName === filter.clubName);
  if (filter?.status !== undefined) arr = arr.filter((l) => l.status === filter.status);
  return arr;
});
const generateLink = vi.fn(async (_sid: string, input: { eventId: string; clubName: string; tag?: string }) => ({
  linkId: 'new', eventId: input.eventId, clubName: input.clubName, token: 'tok', version: 1, tag: input.tag ?? 'ALL', status: 'active',
}));
const revokeLink = vi.fn(async (_sid: string, linkId: string) => ({
  ...links.find((l) => l.linkId === linkId)!, status: 'inactive', revokedReason: 'r',
}));
const rotateLink = vi.fn(async (_sid: string, linkId: string) => ({
  ...links.find((l) => l.linkId === linkId)!, linkId: 'rotated', version: 2, status: 'active',
}));
vi.mock('../src/services/linkStore.js', () => ({
  listLinks: (...a: unknown[]) => listLinks(...(a as [string, never])),
  generateLink: (...a: unknown[]) => generateLink(...(a as [string, never])),
  revokeLink: (...a: unknown[]) => revokeLink(...(a as [string, never])),
  rotateLink: (...a: unknown[]) => rotateLink(...(a as [string, never])),
}));

const { buildServer } = await import('../src/server.js');

const SUPER = JSON.stringify({ uid: 's', email: 'boss@x.org', emailVerified: true, role: 'super_admin', clubId: '' });
const CHI = JSON.stringify({ uid: 'c', email: 'ca@x.org', emailVerified: true, role: 'club_admin', clubId: 'CHI' });

describe('admin links routes', () => {
  const app = buildServer();

  beforeEach(() => {
    links = [
      { linkId: 'l-chi', eventId: 'ev1', clubName: 'CHI', token: 't1', version: 1, tag: 'ALL', status: 'active' },
      { linkId: 'l-nyc', eventId: 'ev1', clubName: 'NYC', token: 't2', version: 1, tag: 'ALL', status: 'active' },
    ];
    recordAudit.mockClear();
    listLinks.mockClear();
    generateLink.mockClear();
    revokeLink.mockClear();
    rotateLink.mockClear();
  });

  it('GET requires admin; club_admin is scoped to their club', async () => {
    expect((await request(app).get('/api/admin/links')).status).toBe(401);
    const res = await request(app).get('/api/admin/links').set('x-test-user', CHI);
    expect(res.status).toBe(200);
    expect(res.body.links.every((l: L) => l.clubName === 'CHI')).toBe(true);
  });

  it('generate: club_admin can create for own club, not another', async () => {
    const own = await request(app).post('/api/admin/links').set('x-test-user', CHI).send({ eventId: 'ev1', clubName: 'CHI' });
    expect(own.status).toBe(201);
    expect(recordAudit.mock.calls[0]?.[1]).toMatchObject({ action: 'LINK_GENERATED' });

    const other = await request(app).post('/api/admin/links').set('x-test-user', CHI).send({ eventId: 'ev1', clubName: 'NYC' });
    expect(other.status).toBe(403);
    expect(generateLink).toHaveBeenCalledTimes(1);
  });

  it('revoke: out-of-scope 403, unknown 404, own club ok + audit', async () => {
    expect((await request(app).post('/api/admin/links/l-nyc/revoke').set('x-test-user', CHI).send({})).status).toBe(403);
    expect((await request(app).post('/api/admin/links/ghost/revoke').set('x-test-user', CHI).send({})).status).toBe(404);
    const ok = await request(app).post('/api/admin/links/l-chi/revoke').set('x-test-user', CHI).send({ reason: 'leaked' });
    expect(ok.status).toBe(200);
    expect(ok.body.link.status).toBe('inactive');
    expect(recordAudit.mock.calls.at(-1)?.[1]).toMatchObject({ action: 'LINK_REVOKED' });
  });

  it('rotate: super_admin any club, audited', async () => {
    const res = await request(app).post('/api/admin/links/l-nyc/rotate').set('x-test-user', SUPER);
    expect(res.status).toBe(200);
    expect(res.body.link.version).toBe(2);
    expect(recordAudit.mock.calls.at(-1)?.[1]).toMatchObject({ action: 'LINK_ROTATED' });
  });
});
