import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

// requireAuth is mocked to read x-test-user; requireAdmin is the REAL middleware
// (it checks ADMIN_EMAILS, default admin@mmrunners.org) so we exercise the gate.
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers['x-test-user'];
    if (!raw) {
      res.status(401).json({ ok: false, error: 'unauthorized', message: 'Missing bearer token' });
      return;
    }
    req.user = JSON.parse(String(raw));
    next();
  },
}));

// In-memory match_feedback, newest first when ordered by createdAt desc.
interface Row { id: string; data: Record<string, unknown> }
let rows: Row[] = [];

vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: () => {
      const builder = {
        _order: 'createdAt',
        _limit: 1000,
        orderBy(_field: string) {
          return builder;
        },
        limit(n: number) {
          builder._limit = n;
          return builder;
        },
        async get() {
          const sorted = [...rows].sort((a, b) =>
            String(b.data.createdAt).localeCompare(String(a.data.createdAt)),
          );
          const docs = sorted.slice(0, builder._limit).map((r) => ({ id: r.id, data: () => r.data }));
          return { docs };
        },
      };
      return builder;
    },
  }),
}));

const { buildServer } = await import('../src/server.js');

const ADMIN = JSON.stringify({ uid: 'a1', email: 'admin@mmrunners.org', emailVerified: true });
const MEMBER = JSON.stringify({ uid: 'u1', email: 'member@mmrunners.org', emailVerified: true });

function seed(): void {
  rows = [
    { id: 'f1', data: { eventId: 'ev1', photoId: 'p1', verdict: 'not_me', runId: 'r1', uid: 'u1', email: 'a@x', createdAt: '2026-06-10T00:00:00.000Z' } },
    { id: 'f2', data: { eventId: 'ev1', photoId: 'p2', verdict: 'confirmed', runId: null, uid: 'u2', email: 'b@x', createdAt: '2026-06-12T00:00:00.000Z' } },
    { id: 'f3', data: { eventId: 'ev2', photoId: 'p9', verdict: 'not_me', runId: 'r3', uid: 'u3', email: 'c@x', createdAt: '2026-06-11T00:00:00.000Z' } },
  ];
}

describe('GET /api/admin/feedback (M4.4)', () => {
  const app = buildServer();
  beforeEach(seed);

  it('requires auth', async () => {
    const res = await request(app).get('/api/admin/feedback');
    expect(res.status).toBe(401);
  });

  it('forbids non-admins', async () => {
    const res = await request(app).get('/api/admin/feedback').set('x-test-user', MEMBER);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('returns all feedback newest-first with verdict counts', async () => {
    const res = await request(app).get('/api/admin/feedback').set('x-test-user', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.counts).toEqual({ not_me: 2, confirmed: 1 });
    expect(res.body.items.map((i: { feedbackId: string }) => i.feedbackId)).toEqual(['f2', 'f3', 'f1']);
    expect(res.body.items[0]).toMatchObject({ eventId: 'ev1', verdict: 'confirmed', runId: null });
  });

  it('filters by eventId', async () => {
    const res = await request(app).get('/api/admin/feedback?eventId=ev2').set('x-test-user', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].photoId).toBe('p9');
  });

  it('filters by verdict', async () => {
    const res = await request(app).get('/api/admin/feedback?verdict=not_me').set('x-test-user', ADMIN);
    expect(res.body.total).toBe(2);
    expect(res.body.counts).toEqual({ not_me: 2, confirmed: 0 });
  });

  it('ignores an invalid verdict filter (returns everything)', async () => {
    const res = await request(app).get('/api/admin/feedback?verdict=bogus').set('x-test-user', ADMIN);
    expect(res.body.total).toBe(3);
  });
});
