import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

vi.mock('../src/lib/config.js', () => ({
  env: { ADMIN_EMAILS: 'boss@x.org,root@x.org', OWNER_EMAILS: 'root@x.org', MASTER_SPREADSHEET_ID: 'sid' },
  isProd: false,
  isTest: true,
}));

const { getUserByEmail } = vi.hoisted(() => ({ getUserByEmail: vi.fn() }));
vi.mock('../src/services/userStore.js', () => ({ getUserByEmail }));

const { attachRole, requireRole, requireClubScope, requireSuperAdmin, requireAnyAdmin, requireOwner } = await import(
  '../src/middleware/rbac.js'
);
const { effectiveClubScope } = await import('../src/routes/adminShared.js');

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

  it('grants owner from OWNER_EMAILS, ahead of the bootstrap super_admin list', async () => {
    const req = { user: { uid: '0', email: 'Root@X.org', emailVerified: true } } as Partial<Request>;
    await run(attachRole, req, makeRes());
    expect(req.user!.role).toBe('owner');
    expect(req.user!.clubId).toBe('');
    expect(getUserByEmail).not.toHaveBeenCalled();
  });

  it('never grants owner from a Users row — a super_admin editing the Sheet cannot self-promote', async () => {
    // userStore maps an unknown cell to club_admin; even if a raw 'owner'
    // slipped through, attachRole must not honour it.
    getUserByEmail.mockResolvedValue({ role: 'owner', clubId: '', status: 'active' });
    const req = { user: { uid: '5', email: 'sneaky@x.org', emailVerified: true } } as Partial<Request>;
    await run(attachRole, req, makeRes());
    expect(req.user!.role).not.toBe('owner');
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

describe('class nesting: owner ⊇ super_admin ⊇ club_admin', () => {
  const as = (role: string) => ({ user: { email: 'a', emailVerified: true, role } }) as Partial<Request>;

  it('owner passes every guard', async () => {
    for (const g of [requireOwner, requireSuperAdmin, requireAnyAdmin]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await run(g, as('owner'), makeRes())).toBe(true);
    }
  });

  it('only the owner passes requireOwner — super_admin and club_admin are 403', async () => {
    for (const role of ['super_admin', 'club_admin', 'api_client']) {
      const res = makeRes();
      // eslint-disable-next-line no-await-in-loop
      expect(await run(requireOwner, as(role), res)).toBe(false);
      expect(res.statusCode).toBe(403);
    }
  });
});

describe('effectiveClubScope', () => {
  const req = (role: string, masq?: string) =>
    ({
      user: { role, clubId: role === 'club_admin' ? 'CHI' : '' },
      header: (h: string) => (h === 'X-Masquerade-Club' ? masq : undefined),
    }) as unknown as Request;

  it('owner and super_admin see every club (and every link) unless masquerading', () => {
    expect(effectiveClubScope(req('owner'))).toBeUndefined();
    expect(effectiveClubScope(req('super_admin'))).toBeUndefined();
    expect(effectiveClubScope(req('super_admin', 'NYC'))).toBe('NYC');
  });

  it('club_admin is pinned to their club and cannot widen it with the header', () => {
    expect(effectiveClubScope(req('club_admin', 'NYC'))).toBe('CHI');
  });
});

describe('requireClubScope', () => {
  const getClubId = (req: Request) => (req.params as Record<string, string>)?.clubId;

  it('super_admin and owner pass for any club', async () => {
    for (const role of ['super_admin', 'owner']) {
      const req = { user: { role }, params: { clubId: 'CHI' } } as unknown as Partial<Request>;
      // eslint-disable-next-line no-await-in-loop
      expect(await run(requireClubScope(getClubId), req, makeRes())).toBe(true);
    }
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
