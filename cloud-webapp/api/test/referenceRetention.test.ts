/**
 * POST /api/admin/findme/retention/sweep — the PRD §8.4 retention tiers on
 * stored reference selfies (services/referenceRetention.ts).
 *
 * What these pin, because each one is how this goes wrong:
 *   - a minor's selfie goes at 30 days, not the bucket's flat 90 — the bug this
 *     exists to fix, including records stamped with a LONGER expiry than the tier;
 *   - the object is deleted BEFORE the record, and a failed object delete keeps
 *     the record (it is the only pointer to the bytes);
 *   - nothing is deleted without `apply: true`;
 *   - super_admin or machine token only.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

import { fakeStore, type FakeStore } from './helpers/fakeDb.js';
import { fakeObjectStore, type FakeObjectStore } from './helpers/fakeObjectStore.js';

process.env.SYNC_TRIGGER_TOKEN = 'cron-secret';

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

let store: FakeStore = fakeStore();
vi.mock('../src/lib/firestore.js', () => ({ firestore: () => store }));

const { __setObjectStoreForTests } = await import('../src/lib/storage.js');
const { buildServer } = await import('../src/server.js');
const { effectiveExpiry } = await import('../src/services/referenceRetention.js');

const BUCKET = 'mmr-data-pipeline-uploads';
const SUPER = JSON.stringify({ uid: 's', email: 'boss@x.org', emailVerified: true, role: 'super_admin' });
const CLUB = JSON.stringify({ uid: 'c', email: 'lead@x.org', emailVerified: true, role: 'club_admin' });
const URL = '/api/admin/findme/retention/sweep';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY).toISOString();
const daysAhead = (n: number): string => new Date(Date.now() + n * DAY).toISOString();

function ref(id: string, createdDaysAgo: number, minor: boolean, expiresAt?: string) {
  return {
    uploadId: id,
    uid: `u-${id}`,
    eventId: 'ev1',
    gcsPath: `find_me_references/u-${id}/${id}.jpg`,
    contentType: 'image/jpeg',
    mode: 'fused',
    subjectIsMinor: minor,
    createdAt: daysAgo(createdDaysAgo),
    expiresAt: expiresAt ?? daysAhead((minor ? 30 : 90) - createdDaysAgo),
  };
}

let objects: FakeObjectStore;

function seed(...recs: ReturnType<typeof ref>[]): void {
  store.seed('find_me_uploads', Object.fromEntries(recs.map((r) => [r.uploadId, r])));
  for (const r of recs) objects.seed(BUCKET, r.gcsPath, { body: 'jpg' });
}

describe('reference retention sweep', () => {
  const app = buildServer();

  beforeEach(() => {
    store = fakeStore();
    objects = fakeObjectStore();
    __setObjectStoreForTests(objects);
  });
  afterAll(() => __setObjectStoreForTests(null));

  it('dry run by default: reports, deletes nothing', async () => {
    seed(ref('kid-old', 45, true), ref('adult-new', 10, false));
    const res = await request(app).post(URL).set('x-test-user', SUPER).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ apply: false, scanned: 2, expired: 1, expiredMinor: 1, deleted: 0 });
    expect(store.ids('find_me_uploads')).toHaveLength(2);
    expect(objects.removed).toEqual([]);
  });

  it('a truthy apply that is not `true` is still a dry run', async () => {
    seed(ref('kid-old', 45, true));
    const res = await request(app).post(URL).set('x-test-user', SUPER).send({ apply: 'yes' });
    expect(res.body.apply).toBe(false);
    expect(store.ids('find_me_uploads')).toEqual(['kid-old']);
  });

  it('apply: a minor goes at 30 days, an adult at 90, the unexpired stay', async () => {
    seed(
      ref('kid-old', 45, true),
      ref('kid-new', 10, true),
      ref('adult-old', 95, false),
      ref('adult-mid', 45, false),
    );
    const res = await request(app).post(URL).set('x-test-user', SUPER).send({ apply: true });
    expect(res.body).toMatchObject({ apply: true, expired: 2, expiredMinor: 1, expiredAdult: 1, deleted: 2, remaining: 0 });
    expect(store.ids('find_me_uploads').sort()).toEqual(['adult-mid', 'kid-new']);
    expect(objects.has(BUCKET, 'find_me_references/u-kid-old/kid-old.jpg')).toBe(false);
    expect(objects.has(BUCKET, 'find_me_references/u-kid-new/kid-new.jpg')).toBe(true);
  });

  it('holds a record to the current tier even when it was stamped with a longer expiry', async () => {
    // A minor's record carrying a 90-day expiresAt must still go at 30.
    seed(ref('kid-stamped-90', 45, true, daysAhead(45)));
    const res = await request(app).post(URL).set('x-test-user', SUPER).send({ apply: true });
    expect(res.body.deleted).toBe(1);
    expect(store.ids('find_me_uploads')).toEqual([]);
  });

  it('an object that is already gone still retires the record', async () => {
    // The bucket's 90-day lifecycle usually beats us to an adult's selfie.
    const r = ref('adult-old', 95, false);
    store.seed('find_me_uploads', { [r.uploadId]: r });
    const res = await request(app).post(URL).set('x-test-user', SUPER).send({ apply: true });
    expect(res.body).toMatchObject({ deleted: 1, failed: 0 });
    expect(store.ids('find_me_uploads')).toEqual([]);
  });

  it('keeps the record when the object delete fails, so the next run retries', async () => {
    seed(ref('kid-old', 45, true), ref('kid-older', 50, true));
    objects.failOn.add('find_me_references/u-kid-old/kid-old.jpg');
    const res = await request(app).post(URL).set('x-test-user', SUPER).send({ apply: true });
    expect(res.body).toMatchObject({ deleted: 1, failed: 1 });
    expect(store.ids('find_me_uploads')).toEqual(['kid-old']);
  });

  it('accepts the machine token; refuses a club admin and an anonymous caller', async () => {
    seed(ref('kid-old', 45, true));
    expect((await request(app).post(URL).set('x-test-user', CLUB).send({ apply: true })).status).toBe(403);
    expect((await request(app).post(URL).send({ apply: true })).status).toBe(401);
    expect(store.ids('find_me_uploads')).toEqual(['kid-old']);

    const res = await request(app).post(URL).set('x-sync-token', 'cron-secret').send({ apply: true });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
    const [auditId] = store.ids('admin_audit');
    expect(store.ids('admin_audit')).toHaveLength(1);
    expect(store.peek('admin_audit', auditId!)).toMatchObject({ action: 'findme_retention_sweep', adminUid: 'system' });
  });

  it('effectiveExpiry: the earlier of the record and the tier, null only when unreadable', () => {
    const created = '2026-06-01T00:00:00.000Z';
    const tier30 = Date.parse(created) + 30 * DAY;
    expect(effectiveExpiry({ createdAt: created, subjectIsMinor: true, expiresAt: '2026-12-01T00:00:00Z' })).toBe(tier30);
    expect(effectiveExpiry({ createdAt: created, subjectIsMinor: true, expiresAt: '2026-06-10T00:00:00Z' })).toBe(
      Date.parse('2026-06-10T00:00:00Z'),
    );
    expect(effectiveExpiry({ createdAt: created, subjectIsMinor: false })).toBe(Date.parse(created) + 90 * DAY);
    expect(effectiveExpiry({ subjectIsMinor: true })).toBeNull();
  });
});
