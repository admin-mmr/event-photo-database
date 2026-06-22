import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

vi.mock('../src/lib/config.js', () => ({
  env: { ADMIN_EMAILS: 'boss@x.org', MASTER_SPREADSHEET_ID: 'sid' },
  isProd: false,
  isTest: true,
}));

const { getUserByEmail } = vi.hoisted(() => ({ getUserByEmail: vi.fn() }));
vi.mock('../src/services/userStore.js', () => ({ getUserByEmail }));

const { attachRole, requireRole, requireClubScope, requireSuperAdmin } = await import('../src/middleware/rbac.js');

interface FakeRes {
  statusCode: number;
  body: unknown;
  status: (c: number) => FakeRes;
  json: (b: unknown) => FakeRes;
}
function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    body: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  return res;
}
const run = async (mw: unknown, req: Partial<Request>, res: FakeRes) => {
  let nexted = false;
  await (mw as (r: unknown, s: unknown, n: () => void) => unknown)(req, res, () => {
    nexted = true;
  });
  return nexted;
};

beforeEach(() => getUserByEmail.mockReset());

describe('attachRole', () => {
  it('treats the bootstrap allowlist as super_admin without a sheet lookup', async () => {
    const req = { user: { uid: '1', email: 'boss@x.org', emailVerified: true } } as Partial<Request>;
    const nexted = await run(attachRole, req, makeRes());
    expect(nexted).toBe(true);
    expect(req.user!.role).toBe('super_admin');
    expect(req.user!.clubId).toBe('');
    expect(getUserByEmail).not.toHaveBeenCalled();
  });

  it('resolves an active club_admin from the sheet', async () => {
    getUserByEmail.mockResolvedValue({ role: 'club_admin', clubId: 'CHI', status: 'active' });
    const req = { user: { uid: '2', email: 'ca@x.org', emailVerified: true } } as Partial<Request>;
    await run(attachRole, req, makeRes());
    expect(req.user!.role).toBe('club_admin');
    expect(req.user!.clubId).toBe('CHI');
  });

  it('grants no role to an inactive user', async () => {
    getUserByEmail.mockResolvedValue({ role: 'club_admin', clubId: 'CHI', status: 'inactive' });
    const req = { user: { uid: '3', email: 'x@x.org', emailVerified: true } } as Partial<Request>;
    await run(attachRole, req, makeRes());
    expect(req.user!.role).toBeUndefined();
  });

  it('fails open (no role, still next) when the user has no Users row', async () => {
    getUserByEmail.mockResolvedValue(null);
    const req = { user: { uid: '4', email: 'y@x.org', emailVerified: true } } as Partial<Request>;
    const nexted = await run(attachRole, req, makeRes());
    expect(nexted).toBe(true);
    expect(req.user!.role).toBeUndefined();
  });
});

describe('requireRole / requireSuperAdmin', () => {
  it('passes a matching role and 403s otherwise', async () => {
    const ok = { user: { email: 'a', emailVerified: true, role: 'club_admin' } } as Partial<Request>;
    expect(await run(requireRole('club_admin', 'super_admin'), ok, makeRes())).toBe(true);

    const res = makeRes();
    const bad = { user: { email: 'a', emailVerified: true, role: 'club_admin' } } as Partial<Request>;
    expect(await run(requireSuperAdmin, bad, res)).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('403s an unverified email even with a role', async () => {
    const res = makeRes();
    const req = { user: { email: 'a', emailVerified: false, role: 'super_admin' } } as Partial<Request>;
    expect(await run(requireSuperAdmin, req, res)).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});

describe('requireClubScope', () => {
  const getClubId = (req: Request) => (req.params as Record<string, string>)?.clubId;

  it('super_admin passes for any club', async () => {
    const req = { user: { role: 'super_admin' }, params: { clubId: 'CHI' } } as unknown as Partial<Request>;
    expect(await run(requireClubScope(getClubId), req, makeRes())).toBe(true);
  });

  it('club_admin passes only for their own club', async () => {
    const own = { user: { role: 'club_admin', clubId: 'CHI' }, params: { clubId: 'CHI' } } as unknown as Partial<Request>;
    expect(await run(requireClubScope(getClubId), own, makeRes())).toBe(true);

    const res = makeRes();
    const other = { user: { role: 'club_admin', clubId: 'CHI' }, params: { clubId: 'NYC' } } as unknown as Partial<Request>;
    expect(await run(requireClubScope(getClubId), other, res)).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('fails closed when the target club is missing', async () => {
    const res = makeRes();
    const req = { user: { role: 'club_admin', clubId: 'CHI' }, params: {} } as unknown as Partial<Request>;
    expect(await run(requireClubScope(getClubId), req, res)).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});
