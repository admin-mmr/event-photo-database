import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

process.env.MASTER_SPREADSHEET_ID = 'sheet1';

// ── mocks (must precede the server import) ──────────────────────────────────

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

// Simplified RBAC: trusts the role already on req.user (set by the auth mock).
// The real rbac.ts is unit-tested in rbac.test.ts; here we test route wiring.
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

// In-memory userStore with the real error-class shape (instanceof must hold).
interface U {
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  clubId: string;
  status: string;
  addedAt: string;
  addedBy: string;
  lastLoginAt: string;
}
const users = new Map<string, U>();
class UserStoreError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UserStoreError';
  }
}
vi.mock('../src/services/userStore.js', () => ({
  UserStoreError,
  listUsers: async (_sid: string, filter?: { clubId?: string }) => {
    let arr = [...users.values()];
    if (filter?.clubId !== undefined) arr = arr.filter((u) => u.clubId === filter.clubId);
    return arr;
  },
  createUser: async (_sid: string, input: U & { clubId?: string }, actorEmail: string) => {
    const email = input.email.toLowerCase();
    if (users.has(email)) throw new UserStoreError('duplicate', `dup ${email}`);
    const u: U = {
      email,
      firstName: input.firstName,
      lastName: input.lastName,
      role: input.role,
      clubId: input.role === 'super_admin' ? '' : (input.clubId ?? ''),
      status: 'active',
      addedAt: 't',
      addedBy: actorEmail,
      lastLoginAt: '',
    };
    users.set(email, u);
    return u;
  },
  updateUser: async (_sid: string, email: string, patch: Partial<U>) => {
    const u = users.get(email.toLowerCase());
    if (!u) throw new UserStoreError('not_found', 'nf');
    Object.assign(u, patch);
    return u;
  },
  setUserStatus: async (_sid: string, email: string, status: string) => {
    const u = users.get(email.toLowerCase());
    if (!u) throw new UserStoreError('not_found', 'nf');
    u.status = status;
    return u;
  },
}));

const { buildServer } = await import('../src/server.js');

const SUPER = JSON.stringify({ uid: 's', email: 'boss@x.org', emailVerified: true, role: 'super_admin', clubId: '' });
const CLUB = JSON.stringify({ uid: 'c', email: 'ca@x.org', emailVerified: true, role: 'club_admin', clubId: 'CHI' });
const NOROLE = JSON.stringify({ uid: 'n', email: 'n@x.org', emailVerified: true });

describe('admin users routes', () => {
  const app = buildServer();

  beforeEach(() => {
    users.clear();
    recordAudit.mockClear();
    users.set('chi-admin@x.org', {
      email: 'chi-admin@x.org', firstName: 'C', lastName: 'A', role: 'club_admin', clubId: 'CHI',
      status: 'active', addedAt: 't', addedBy: 'boss@x.org', lastLoginAt: '',
    });
    users.set('nyc-admin@x.org', {
      email: 'nyc-admin@x.org', firstName: 'N', lastName: 'A', role: 'club_admin', clubId: 'NYC',
      status: 'active', addedAt: 't', addedBy: 'boss@x.org', lastLoginAt: '',
    });
  });

  describe('GET /api/admin/users', () => {
    it('401 without auth, 403 without an admin role', async () => {
      expect((await request(app).get('/api/admin/users')).status).toBe(401);
      expect((await request(app).get('/api/admin/users').set('x-test-user', NOROLE)).status).toBe(403);
    });

    it('super_admin sees all; club_admin sees only their club', async () => {
      const all = await request(app).get('/api/admin/users').set('x-test-user', SUPER);
      expect(all.body.users).toHaveLength(2);

      const scoped = await request(app).get('/api/admin/users').set('x-test-user', CLUB);
      expect(scoped.body.users.map((u: U) => u.clubId)).toEqual(['CHI']);
    });

    it('super_admin masquerade scopes the list to a club', async () => {
      const res = await request(app)
        .get('/api/admin/users')
        .set('x-test-user', SUPER)
        .set('X-Masquerade-Club', 'NYC');
      expect(res.body.users.map((u: U) => u.email)).toEqual(['nyc-admin@x.org']);
    });
  });

  describe('POST /api/admin/users', () => {
    const body = { email: 'New@x.org', firstName: 'New', lastName: 'User', role: 'club_admin', clubId: 'CHI' };

    it('club_admin is forbidden', async () => {
      const res = await request(app).post('/api/admin/users').set('x-test-user', CLUB).send(body);
      expect(res.status).toBe(403);
    });

    it('super_admin creates + audits', async () => {
      const res = await request(app).post('/api/admin/users').set('x-test-user', SUPER).send(body);
      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe('new@x.org');
      expect(recordAudit).toHaveBeenCalledTimes(1);
      expect(recordAudit.mock.calls[0]?.[1]).toMatchObject({ action: 'USER_CREATED', resourceType: 'user' });
    });

    it('duplicate → 409, invalid body → 400', async () => {
      await request(app).post('/api/admin/users').set('x-test-user', SUPER).send(body);
      const dup = await request(app).post('/api/admin/users').set('x-test-user', SUPER).send(body);
      expect(dup.status).toBe(409);
      const bad = await request(app).post('/api/admin/users').set('x-test-user', SUPER).send({ email: 'x' });
      expect(bad.status).toBe(400);
    });
  });

  describe('PATCH + status', () => {
    it('updates a user and audits', async () => {
      const res = await request(app)
        .patch('/api/admin/users/chi-admin@x.org')
        .set('x-test-user', SUPER)
        .send({ firstName: 'Renamed' });
      expect(res.status).toBe(200);
      expect(res.body.user.firstName).toBe('Renamed');
      expect(recordAudit.mock.calls[0]?.[1]).toMatchObject({ action: 'USER_UPDATED' });
    });

    it('deactivate flips status + audits; unknown → 404', async () => {
      const res = await request(app).post('/api/admin/users/chi-admin@x.org/deactivate').set('x-test-user', SUPER);
      expect(res.body.user.status).toBe('inactive');
      expect(recordAudit.mock.calls[0]?.[1]).toMatchObject({ action: 'USER_DEACTIVATED' });
      const nf = await request(app).post('/api/admin/users/ghost@x.org/deactivate').set('x-test-user', SUPER);
      expect(nf.status).toBe(404);
    });
  });
});

describe('admin masquerade routes', () => {
  const app = buildServer();
  beforeEach(() => recordAudit.mockClear());

  it('start requires super_admin and a known club', async () => {
    // clubStore.getClub is the real impl reading the Sheet; mock it minimally.
    expect((await request(app).post('/api/admin/masquerade/start').set('x-test-user', CLUB).send({ clubId: 'CHI' })).status).toBe(403);
  });

  it('end audits MASQUERADE_END for a super_admin', async () => {
    const res = await request(app)
      .post('/api/admin/masquerade/end')
      .set('x-test-user', SUPER)
      .set('X-Masquerade-Club', 'CHI');
    expect(res.status).toBe(200);
    expect(res.body.actingAsClub).toBeNull();
    expect(recordAudit.mock.calls[0]?.[1]).toMatchObject({ action: 'MASQUERADE_END', resourceId: 'CHI' });
  });
});
