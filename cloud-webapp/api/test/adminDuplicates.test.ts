/**
 * /api/admin/duplicates/* — auth, club scoping, and the dry-run/apply contract.
 *
 * The guarantees worth pinning down: (1) nothing is written unless the body says
 * `apply: true`, (2) a club_admin can only ever act inside their own club, and
 * (3) an apply ENQUEUES (202) rather than trashing inline — the inline version
 * could not fit the 60s request ceiling and 502'd on every real event.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

// Must be set before config.ts is imported by the server.
process.env.SYNC_TRIGGER_TOKEN = 'cron-secret';
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
vi.mock('../src/middleware/rbac.js', () => ({
  attachRole: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAnyAdmin: (req: Request, res: Response, next: NextFunction) =>
    req.user?.role === 'super_admin' || req.user?.role === 'club_admin'
      ? next()
      : res.status(403).json({ ok: false, error: 'forbidden' }),
  requireSuperAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireClubScope: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const scanEventDuplicates = vi.fn();
const previewEventDuplicates = vi.fn();
vi.mock('../src/services/duplicateFilesService.js', () => ({
  scanEventDuplicates: (...a: unknown[]) => scanEventDuplicates(...a),
  previewEventDuplicates: (...a: unknown[]) => previewEventDuplicates(...a),
}));

const enqueueDuplicateRemoval = vi.fn();
const drainDuplicateRemovalQueue = vi.fn();
const getDuplicateBatch = vi.fn();
const latestDuplicateBatch = vi.fn();
vi.mock('../src/services/duplicateRemovalQueue.js', () => ({
  enqueueDuplicateRemoval: (...a: unknown[]) => enqueueDuplicateRemoval(...a),
  drainDuplicateRemovalQueue: (...a: unknown[]) => drainDuplicateRemovalQueue(...a),
  getDuplicateBatch: (...a: unknown[]) => getDuplicateBatch(...a),
  latestDuplicateBatch: (...a: unknown[]) => latestDuplicateBatch(...a),
}));

const recordAudit = vi.fn(async () => undefined);
vi.mock('../src/services/auditStore.js', () => ({
  recordAudit: (...a: unknown[]) => recordAudit(...(a as [])),
}));

const { buildServer } = await import('../src/server.js');

const SUPER = JSON.stringify({ uid: 's', email: 'boss@x.org', emailVerified: true, role: 'super_admin' });
const CLUB = JSON.stringify({
  uid: 'c',
  email: 'lead@blue.org',
  emailVerified: true,
  role: 'club_admin',
  clubId: 'Blue',
});
const MEMBER = JSON.stringify({ uid: 'm', email: 'm@x.org', emailVerified: true });
const SCAN = '/api/admin/duplicates/ev1';
const REMOVE = '/api/admin/duplicates/ev1/remove';
const DRAIN = '/api/admin/duplicates/drain';
const STATUS = '/api/admin/duplicates/batch/status';

const previewData = (over: Record<string, unknown> = {}) => ({
  ok: true,
  message: 'ok',
  data: {
    eventId: 'ev1',
    apply: false,
    candidates: 2,
    removed: 0,
    failed: 0,
    remaining: 0,
    bytesReclaimed: 0,
    planned: [],
    warnings: [],
    ...over,
  },
});

beforeEach(() => {
  scanEventDuplicates.mockReset().mockResolvedValue({
    ok: true,
    message: 'ok',
    data: {
      eventId: 'ev1',
      eventName: 'Spring Meet',
      filesScanned: 3,
      unhashedFiles: 0,
      duplicateFiles: 1,
      reclaimableBytes: 400,
      groups: [],
    },
  });
  previewEventDuplicates.mockReset().mockResolvedValue(previewData());
  enqueueDuplicateRemoval
    .mockReset()
    .mockResolvedValue({ ok: true, message: 'queued', data: { id: 'b1', eventName: 'Spring Meet', total: 2, notEnqueued: 0 } });
  drainDuplicateRemovalQueue
    .mockReset()
    .mockResolvedValue({ drained: true, batchId: 'b1', processed: 2, failed: 0, remaining: 0, finished: true });
  getDuplicateBatch.mockReset().mockResolvedValue(null);
  latestDuplicateBatch.mockReset().mockResolvedValue(null);
  recordAudit.mockReset().mockResolvedValue(undefined);
});

describe('GET /api/admin/duplicates/:eventId', () => {
  const app = buildServer();

  it('rejects an unauthenticated caller', async () => {
    expect((await request(app).get(SCAN)).status).toBe(401);
  });

  it('rejects a signed-in non-admin', async () => {
    expect((await request(app).get(SCAN).set('x-test-user', MEMBER)).status).toBe(403);
  });

  it('returns the scan for a super_admin, unscoped', async () => {
    const res = await request(app).get(SCAN).set('x-test-user', SUPER);
    expect(res.status).toBe(200);
    expect(res.body.duplicateFiles).toBe(1);
    expect(scanEventDuplicates).toHaveBeenCalledWith('ev1', { clubScope: undefined });
  });

  it('pins a club_admin to their own club', async () => {
    await request(app).get(SCAN).set('x-test-user', CLUB);
    expect(scanEventDuplicates).toHaveBeenCalledWith('ev1', { clubScope: 'Blue' });
  });

  it('honours a super_admin masquerade header', async () => {
    await request(app).get(SCAN).set('x-test-user', SUPER).set('X-Masquerade-Club', 'Red');
    expect(scanEventDuplicates).toHaveBeenCalledWith('ev1', { clubScope: 'Red' });
  });

  it('404s an event with no Drive folder', async () => {
    scanEventDuplicates.mockResolvedValue({ ok: false, message: 'no folder' });
    const res = await request(app).get(SCAN).set('x-test-user', SUPER);
    expect(res.status).toBe(404);
  });

  it('is read-only — the scan route never queues or removes anything', async () => {
    await request(app).get(SCAN).set('x-test-user', SUPER);
    expect(enqueueDuplicateRemoval).not.toHaveBeenCalled();
    expect(previewEventDuplicates).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/duplicates/:eventId/remove', () => {
  const app = buildServer();

  it('rejects an unauthenticated caller', async () => {
    expect((await request(app).post(REMOVE).send({})).status).toBe(401);
  });

  it('rejects a signed-in non-admin', async () => {
    expect((await request(app).post(REMOVE).set('x-test-user', MEMBER).send({})).status).toBe(403);
  });

  it('rejects a wrong machine token', async () => {
    expect((await request(app).post(REMOVE).set('x-sync-token', 'nope').send({})).status).toBe(401);
  });

  it('accepts the machine token so the pass can be scripted', async () => {
    const res = await request(app).post(REMOVE).set('x-sync-token', 'cron-secret').send({});
    expect(res.status).toBe(200);
    // A machine caller has no club — it must run unscoped, not against the
    // '__none__' sentinel (which would silently match nothing).
    expect(previewEventDuplicates).toHaveBeenCalledWith('ev1', expect.objectContaining({ clubScope: undefined }));
  });

  it('defaults to a DRY RUN when apply is absent', async () => {
    const res = await request(app).post(REMOVE).set('x-test-user', SUPER).send({});
    expect(res.status).toBe(200);
    expect(previewEventDuplicates).toHaveBeenCalledTimes(1);
    expect(enqueueDuplicateRemoval).not.toHaveBeenCalled();
  });

  it('refuses a truthy-but-not-boolean apply rather than guessing', async () => {
    const res = await request(app).post(REMOVE).set('x-test-user', SUPER).send({ apply: 'yes' });
    expect(res.status).toBe(400);
    expect(enqueueDuplicateRemoval).not.toHaveBeenCalled();
    expect(previewEventDuplicates).not.toHaveBeenCalled();
  });

  it('enqueues on apply:true and answers 202 with the batch id — never inline', async () => {
    const res = await request(app).post(REMOVE).set('x-test-user', SUPER).send({ apply: true });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, mode: 'async', batchId: 'b1', total: 2 });
    expect(enqueueDuplicateRemoval).toHaveBeenCalledWith('ev1', expect.objectContaining({ createdBy: 'boss@x.org' }));
    // The inline trashing path is gone — that is the whole point of the fix.
    expect(previewEventDuplicates).not.toHaveBeenCalled();
  });

  it('passes limit + hashes through on a dry run', async () => {
    await request(app)
      .post(REMOVE)
      .set('x-test-user', SUPER)
      .send({ limit: 25, hashes: ['abc', 'def'] });
    expect(previewEventDuplicates).toHaveBeenCalledWith(
      'ev1',
      expect.objectContaining({ limit: 25, hashes: ['abc', 'def'] }),
    );
  });

  it('passes hashes through when queuing', async () => {
    await request(app).post(REMOVE).set('x-test-user', SUPER).send({ apply: true, hashes: ['abc'] });
    expect(enqueueDuplicateRemoval).toHaveBeenCalledWith('ev1', expect.objectContaining({ hashes: ['abc'] }));
  });

  it('rejects a nonsense limit', async () => {
    const res = await request(app).post(REMOVE).set('x-test-user', SUPER).send({ limit: 0 });
    expect(res.status).toBe(400);
    expect(previewEventDuplicates).not.toHaveBeenCalled();
  });

  it('pins a club_admin to their own club on the write path too', async () => {
    await request(app).post(REMOVE).set('x-test-user', CLUB).send({ apply: true });
    expect(enqueueDuplicateRemoval).toHaveBeenCalledWith('ev1', expect.objectContaining({ clubScope: 'Blue' }));
  });

  it('audits the queued run', async () => {
    await request(app).post(REMOVE).set('x-test-user', SUPER).send({ apply: true });
    expect(recordAudit).toHaveBeenCalledWith(
      'sheet1',
      expect.objectContaining({ action: 'DUPLICATES_REMOVAL_QUEUED', resourceId: 'ev1' }),
    );
  });

  it('does not audit a dry run', async () => {
    previewEventDuplicates.mockResolvedValue(previewData({ planned: [{ driveFileId: 'd1' }] }));
    await request(app).post(REMOVE).set('x-test-user', SUPER).send({});
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('reports "nothing to do" as a plain 200, not a queued batch', async () => {
    enqueueDuplicateRemoval.mockResolvedValue({ ok: true, message: 'No duplicate files to remove' });
    const res = await request(app).post(REMOVE).set('x-test-user', SUPER).send({ apply: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'none', batchId: null, total: 0 });
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('404s an event with no Drive folder', async () => {
    enqueueDuplicateRemoval.mockResolvedValue({ ok: false, message: 'no folder' });
    const res = await request(app).post(REMOVE).set('x-test-user', SUPER).send({ apply: true });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/duplicates/drain', () => {
  const app = buildServer();

  it('rejects an unauthenticated caller', async () => {
    expect((await request(app).post(DRAIN).send({})).status).toBe(401);
  });

  it('runs a tick for an admin', async () => {
    const res = await request(app).post(DRAIN).set('x-test-user', SUPER).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, processed: 2, finished: true });
  });

  it('accepts the machine token so Cloud Scheduler can back the UI up', async () => {
    const res = await request(app).post(DRAIN).set('x-sync-token', 'cron-secret').send({});
    expect(res.status).toBe(200);
    expect(drainDuplicateRemovalQueue).toHaveBeenCalled();
  });
});

describe('GET /api/admin/duplicates/batch/status', () => {
  const app = buildServer();

  const batch = {
    id: 'b1',
    eventId: 'ev1',
    eventName: 'Spring Meet',
    status: 'running' as const,
    total: 10,
    pending: [{ i: 'd1' }, { i: 'd2' }],
    pendingSweep: ['d0'],
    removed: 8,
    failed: 0,
    bytesReclaimed: 3200,
    shortcutsRemoved: 12,
    notEnqueued: 0,
    warnings: [],
    createdBy: 'boss@x.org',
    createdAt: 't0',
    updatedAt: 't1',
  };

  it('rejects a signed-in non-admin', async () => {
    expect((await request(app).get(STATUS).set('x-test-user', MEMBER)).status).toBe(403);
  });

  it('reports progress without shipping the work list back', async () => {
    getDuplicateBatch.mockResolvedValue(batch);
    const res = await request(app).get(`${STATUS}?batchId=b1`).set('x-test-user', SUPER);
    expect(res.status).toBe(200);
    expect(res.body.batch).toMatchObject({ id: 'b1', total: 10, removed: 8, remaining: 2, sweepPending: 1 });
    // The inline work list can be thousands of entries — never echo it.
    expect(res.body.batch.pending).toBeUndefined();
  });

  it('falls back to the newest batch for the event', async () => {
    latestDuplicateBatch.mockResolvedValue(batch);
    const res = await request(app).get(`${STATUS}?eventId=ev1`).set('x-test-user', SUPER);
    expect(latestDuplicateBatch).toHaveBeenCalledWith('ev1');
    expect(res.body.batch.id).toBe('b1');
  });

  it('returns a null batch when there has never been one', async () => {
    const res = await request(app).get(STATUS).set('x-test-user', SUPER);
    expect(res.body).toEqual({ ok: true, batch: null });
  });
});
