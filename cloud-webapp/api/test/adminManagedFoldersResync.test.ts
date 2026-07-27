/**
 * POST /api/admin/folders/resync-names — auth + dry-run contract.
 *
 * Step 1 of the capture-time rename procedure (backfill-capture-time.sh) is a
 * shell script, so step 2 has to be shell-runnable too; this route therefore
 * uses allowCronOrAdmin (machine token OR Firebase admin) rather than the
 * admin-only guard the other managed-folder routes use.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

// Must be set before config.ts is imported by the server.
process.env.SYNC_TRIGGER_TOKEN = 'cron-secret';
process.env.MASTER_SPREADSHEET_ID = 'sheet1';
process.env.MANAGED_FOLDERS_ENABLED = 'true';

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

const resyncEventManagedFolderNames = vi.fn();
vi.mock('../src/services/specialFoldersService.js', () => ({
  resyncEventManagedFolderNames: (...a: unknown[]) =>
    resyncEventManagedFolderNames(...(a as [string, { apply?: boolean }])),
  rebuildEventPhotoFolders: vi.fn(),
  rebuildAllSpecialFoldersForEvent: vi.fn(),
  migrateEventPhotoShortcutsToFiles: vi.fn(),
  backfillSpecialFoldersSharing: vi.fn(),
  countEventMedia: vi.fn(),
  dedupeEventManagedFolders: vi.fn(),
}));
vi.mock('../src/services/publicFolderIndexService.js', () => ({
  rebuildPublicFolderIndex: vi.fn(),
}));

const { buildServer } = await import('../src/server.js');

const ADMIN = JSON.stringify({ uid: 's', email: 'boss@x.org', emailVerified: true, role: 'super_admin' });
const MEMBER = JSON.stringify({ uid: 'm', email: 'm@x.org', emailVerified: true });
const PATH = '/api/admin/folders/resync-names';

beforeEach(() => {
  resyncEventManagedFolderNames.mockReset();
  resyncEventManagedFolderNames.mockResolvedValue({
    ok: true,
    message: 'ok',
    data: { foldersScanned: 2, drifted: 1, renamed: 0, failed: 0, planned: [], warnings: [] },
  });
});

describe('POST /api/admin/folders/resync-names', () => {
  const app = buildServer();

  it('rejects an unauthenticated caller', async () => {
    expect((await request(app).post(PATH).send({ eventId: 'ev1' })).status).toBe(401);
  });

  it('rejects a signed-in non-admin', async () => {
    const res = await request(app).post(PATH).set('x-test-user', MEMBER).send({ eventId: 'ev1' });
    expect(res.status).toBe(403);
  });

  it('accepts a Firebase admin', async () => {
    const res = await request(app).post(PATH).set('x-test-user', ADMIN).send({ eventId: 'ev1' });
    expect(res.status).toBe(200);
  });

  it('accepts the machine token, so step 2 can be scripted like step 1', async () => {
    const res = await request(app).post(PATH).set('x-sync-token', 'cron-secret').send({ eventId: 'ev1' });
    expect(res.status).toBe(200);
    expect(resyncEventManagedFolderNames).toHaveBeenCalledWith('ev1', { apply: false });
  });

  it('rejects a wrong machine token', async () => {
    const res = await request(app).post(PATH).set('x-sync-token', 'nope').send({ eventId: 'ev1' });
    expect(res.status).toBe(401);
  });

  it('requires an eventId', async () => {
    const res = await request(app).post(PATH).set('x-sync-token', 'cron-secret').send({});
    expect(res.status).toBe(400);
    expect(resyncEventManagedFolderNames).not.toHaveBeenCalled();
  });

  it('defaults to a DRY RUN and only writes on an explicit apply:true', async () => {
    await request(app).post(PATH).set('x-sync-token', 'cron-secret').send({ eventId: 'ev1' });
    expect(resyncEventManagedFolderNames).toHaveBeenLastCalledWith('ev1', { apply: false });

    // Truthy-but-not-true must NOT trigger a write.
    await request(app).post(PATH).set('x-sync-token', 'cron-secret').send({ eventId: 'ev1', apply: 'yes' });
    expect(resyncEventManagedFolderNames).toHaveBeenLastCalledWith('ev1', { apply: false });

    await request(app).post(PATH).set('x-sync-token', 'cron-secret').send({ eventId: 'ev1', apply: true });
    expect(resyncEventManagedFolderNames).toHaveBeenLastCalledWith('ev1', { apply: true });
  });

  it('echoes the plan so a dry run can be eyeballed', async () => {
    resyncEventManagedFolderNames.mockResolvedValue({
      ok: true,
      message: 'would rename 1',
      data: {
        foldersScanned: 1,
        drifted: 1,
        renamed: 0,
        failed: 0,
        planned: [{ id: 's1', from: 'IMG_1.jpg', to: '20260620-143052_IMG_1.jpg' }],
        warnings: [],
      },
    });
    const res = await request(app).post(PATH).set('x-sync-token', 'cron-secret').send({ eventId: 'ev1' });
    expect(res.status).toBe(200);
    expect(res.body.apply).toBe(false);
    expect(res.body.planned).toEqual([
      { id: 's1', from: 'IMG_1.jpg', to: '20260620-143052_IMG_1.jpg' },
    ]);
  });
});
