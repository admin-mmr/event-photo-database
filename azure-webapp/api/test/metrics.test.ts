import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

// requireAuth mocked (x-test-user); requireAdmin is the REAL gate (ADMIN_EMAILS).
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

interface Row { data: Record<string, unknown> }
const store: Record<string, Row[]> = { match_runs: [], consents: [], match_feedback: [] };

vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: (name: string) => {
      const builder = {
        _limit: 100000,
        orderBy() {
          return builder;
        },
        limit(n: number) {
          builder._limit = n;
          return builder;
        },
        async get() {
          const rows = store[name] ?? [];
          const sorted = [...rows].sort((a, b) =>
            String(b.data.createdAt).localeCompare(String(a.data.createdAt)),
          );
          const docs = sorted.slice(0, builder._limit).map((r) => ({ data: () => r.data }));
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
const NOW = new Date().toISOString();
const OLD = '2000-01-01T00:00:00.000Z';

function seed(): void {
  store.match_runs = [
    { data: { uid: 'u1', eventId: 'ev1', mode: 'fused', createdAt: NOW } },
    { data: { uid: 'u1', eventId: 'ev1', mode: 'person', createdAt: NOW } },
    { data: { uid: 'u2', eventId: 'ev2', mode: 'fused', createdAt: NOW } },
    { data: { uid: 'u9', eventId: 'ev1', mode: 'fused', createdAt: OLD } }, // outside window
  ];
  store.consents = [
    { data: { action: 'findme_search', eventId: 'ev1', subjectIsMinor: false, createdAt: NOW } },
    { data: { action: 'findme_search', eventId: 'ev1', subjectIsMinor: true, createdAt: NOW } },
    { data: { action: 'findme_search', eventId: 'ev2', subjectIsMinor: false, createdAt: NOW } },
    { data: { action: 'data_deleted', createdAt: NOW } },
  ];
  store.match_feedback = [
    { data: { verdict: 'confirmed', eventId: 'ev1', createdAt: NOW } },
    { data: { verdict: 'not_me', eventId: 'ev1', createdAt: NOW } },
    { data: { verdict: 'confirmed', eventId: 'ev2', createdAt: NOW } },
  ];
}

describe('GET /api/admin/metrics (M6.2)', () => {
  const app = buildServer();
  beforeEach(seed);

  it('requires auth', async () => {
    const res = await request(app).get('/api/admin/metrics');
    expect(res.status).toBe(401);
  });

  it('forbids non-admins', async () => {
    const res = await request(app).get('/api/admin/metrics').set('x-test-user', MEMBER);
    expect(res.status).toBe(403);
  });

  it('aggregates searches, consent coverage, precision and deletions', async () => {
    const res = await request(app).get('/api/admin/metrics').set('x-test-user', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.searches).toBe(3); // OLD row excluded by the window
    expect(res.body.distinctSearchers).toBe(2);
    expect(res.body.searchesByMode).toEqual({ fused: 2, person: 1 });
    expect(res.body.minorSearches).toBe(1);
    expect(res.body.consent).toEqual({ records: 3, coverage: 1 });
    expect(res.body.feedback.confirmed).toBe(2);
    expect(res.body.feedback.not_me).toBe(1);
    expect(res.body.feedback.precision).toBeCloseTo(2 / 3, 5);
    expect(res.body.dataDeletions).toBe(1);
    expect(res.body.window.eventId).toBeNull();
  });

  it('scopes search/consent/feedback to an eventId (deletions stay global)', async () => {
    const res = await request(app).get('/api/admin/metrics?eventId=ev1').set('x-test-user', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.searches).toBe(2);
    expect(res.body.distinctSearchers).toBe(1);
    expect(res.body.searchesByMode).toEqual({ fused: 1, person: 1 });
    expect(res.body.consent.records).toBe(2);
    expect(res.body.minorSearches).toBe(1);
    expect(res.body.feedback).toEqual({ confirmed: 1, not_me: 1, precision: 0.5 });
    expect(res.body.dataDeletions).toBe(1);
    expect(res.body.window.eventId).toBe('ev1');
  });

  it('returns null precision when there are no votes', async () => {
    store.match_feedback = [];
    const res = await request(app).get('/api/admin/metrics').set('x-test-user', ADMIN);
    expect(res.body.feedback.precision).toBeNull();
  });
});
