/**
 * /api/admin/duplicates/:eventId — auth, club scoping and the dry-run contract.
 *
 * The removal POST trashes real Drive files, so the two guarantees worth pinning
 * down are: (1) nothing is written unless the body says `apply: true`, and
 * (2) a club_admin can only ever act inside their own club.
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
const removeEventDuplicates = vi.fn();
vi.mock('../src/services/duplicateFilesService.js', () => ({
  scanEventDuplicates: (...a: unknown[]) => scanEventDuplicates(...a),
  removeEventDuplicates: (...a: unknown[]) => removeEventDuplicates(...a),
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

const removalData = (over: Record<string, unknown> = {}) => ({
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
  removeEventDuplicates.mockReset().mockResolvedValue(removalData());
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

  it('is read-only — the scan route never removes anything', async () => {
    await request(app).get(SCAN).set('x-test-user', SUPER);
    expect(removeEventDuplicates).not.toHaveBeenCalled();
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
    expect(removeEventDuplicates).toHaveBeenCalledWith(
      'ev1',
      expect.objectContaining({ apply: false, clubScope: undefined }),
    );
  });

  it('defaults to a DRY RUN and only writes on an explicit apply:true', async () => {
    await request(app).post(REMOVE).set('x-test-user', SUPER).send({});
    expect(removeEventDuplicates).toHaveBeenLastCalledWith('ev1', expect.objectContaining({ apply: false }));

    // Truthy-but-not-true must NOT trigger a write.
    await request(app).post(REMOVE).set('x-test-user', SUPER).send({ apply: 'yes' });
    expect(removeEventDuplicates).toHaveBeenLastCalledWith('ev1', expect.objectContaining({ apply: false }));

    await request(app).post(REMOVE).set('x-test-user', SUPER).send({ apply: true });
    expect(removeEventDuplicates).toHaveBeenLastCalledWith('ev1', expect.objectContaining({ apply: true }));
  });

  it('passes limit + hashes through', async () => {
    await request(app)
      .post(REMOVE)
      .set('x-test-user', SUPER)
      .send({ apply: true, limit: 25, hashes: ['abc', 'def'] });
    expect(removeEventDuplicates).toHaveBeenCalledWith(
      'ev1',
      expect.objectContaining({ limit: 25, hashes: ['abc', 'def'] }),
    );
  });

  it('rejects a nonsense limit', async () => {
    const res = await request(app).post(REMOVE).set('x-test-user', SUPER).send({ limit: 0 });
    expect(res.status).toBe(400);
    expect(removeEventDuplicates).not.toHaveBeenCalled();
  });

  it('pins a club_admin to their own club on the write path too', async () => {
    await request(app).post(REMOVE).set('x-test-user', CLUB).send({ apply: true });
    expect(removeEventDuplicates).toHaveBeenCalledWith('ev1', expect.objectContaining({ clubScope: 'Blue' }));
  });

  it('audits a run that actually trashed files, and flags a re-index', async () => {
    removeEventDuplicates.mockResolvedValue(removalData({ apply: true, removed: 2, bytesReclaimed: 800 }));
    const res = await request(app).post(REMOVE).set('x-test-user', SUPER).send({ apply: true });
    expect(res.status).toBe(200);
    expect(res.body.reindexRecommended).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(
      'sheet1',
      expect.objectContaining({ action: 'DUPLICATES_REMOVED', resourceId: 'ev1' }),
    );
  });

  it('does not audit (or claim a re-index) when nothing was removed', async () => {
    const res = await request(app).post(REMOVE).set('x-test-user', SUPER).send({ apply: true });
    expect(res.body.reindexRecommended).toBe(false);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('does not audit a dry run', async () => {
    removeEventDuplicates.mockResolvedValue(removalData({ planned: [{ driveFileId: 'd1' }] }));
    await request(app).post(REMOVE).set('x-test-user', SUPER).send({});
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
