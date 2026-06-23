import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

// Auth: the x-test-user header stands in for a verified Firebase token.
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

// attachRole passes the test user's role straight through (it's already on
// req.user). The other guards are stubbed so buildServer can register every
// router; this suite only exercises /api/me, which uses attachRole alone.
vi.mock('../src/middleware/rbac.js', () => {
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  return {
    attachRole: pass,
    requireSuperAdmin: pass,
    requireAnyAdmin: pass,
    requireRole: () => pass,
    requireClubScope: () => pass,
  };
});

const { buildServer } = await import('../src/server.js');

const SUPER = JSON.stringify({ uid: 's', email: 'boss@x.org', emailVerified: true, role: 'super_admin', clubId: '' });
const CLUB = JSON.stringify({ uid: 'c', email: 'ca@x.org', emailVerified: true, role: 'club_admin', clubId: 'CHI' });
const MEMBER = JSON.stringify({ uid: 'm', email: 'm@x.org', emailVerified: true });
const GUEST = JSON.stringify({ uid: 'g', emailVerified: false });

describe('GET /api/me', () => {
  const app = buildServer();

  it('401s without a token', async () => {
    expect((await request(app).get('/api/me')).status).toBe(401);
  });

  it('returns the super_admin role', async () => {
    const res = await request(app).get('/api/me').set('x-test-user', SUPER);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, email: 'boss@x.org', role: 'super_admin', clubId: '' });
  });

  it('returns the club_admin role + clubId', async () => {
    const res = await request(app).get('/api/me').set('x-test-user', CLUB);
    expect(res.body).toMatchObject({ role: 'club_admin', clubId: 'CHI' });
  });

  it('returns role null for a signed-in member with no Users row', async () => {
    const res = await request(app).get('/api/me').set('x-test-user', MEMBER);
    expect(res.status).toBe(200);
    expect(res.body.role).toBeNull();
  });

  it('returns role null + email null for an anonymous guest', async () => {
    const res = await request(app).get('/api/me').set('x-test-user', GUEST);
    expect(res.status).toBe(200);
    expect(res.body.role).toBeNull();
    expect(res.body.email).toBeNull();
  });
});
