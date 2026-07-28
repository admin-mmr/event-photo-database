/**
 * /api/admin/events/:id/delete — the guards around a destructive route:
 *   (1) super_admin only for humans, machine token accepted (shell tooling),
 *   (2) nothing is deleted unless the body says `apply: true`,
 *   (3) an apply must NAME the event (confirmName), so a mis-clicked row can't
 *       take a live gallery down,
 *   (4) an applied delete is audited as EVENT_DELETED.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

process.env.MASTER_SPREADSHEET_ID = 'sheet1';
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

const INVENTORY = {
  photos: 0,
  links: 5,
  activeLinks: 5,
  uploadBatches: 0,
  dedupClaims: 0,
  matchRuns: 0,
  matchFeedback: 0,
  specialFolderRows: 0,
  derivativeObjects: 0,
  derivativeObjectsCapped: false,
  stagedObjects: 0,
  driveFolderExists: true,
  sheetRowExists: true,
};

const previewBody = {
  ok: true as const,
  apply: false,
  eventId: 'ev1',
  eventName: 'Test',
  eventDate: '2026-05-01',
  folderName: '2026-05-01_Test',
  driveFolderId: 'folder-1',
  message: 'Dry run — nothing was changed.',
  inventory: INVENTORY,
  removed: { linksRevoked: 0, sheetRowsRemoved: 0, specialFolderRows: 0, firestoreDocs: 0, derivativeObjects: 0 },
  driveFolderTrashed: false,
  deleteId: '',
  derivativesRemaining: false,
  warnings: [],
};

let identity: { eventId: string; name: string } | null = { eventId: 'ev1', name: 'Test' };
const previewEventDeletion = vi.fn(async () => ({ ok: true, message: 'dry', data: { ...previewBody } }));
const deleteEvent = vi.fn(async () => ({
  ok: true,
  message: 'done',
  data: {
    ...previewBody,
    apply: true,
    driveFolderTrashed: true,
    deleteId: 'del-1',
    removed: { linksRevoked: 5, sheetRowsRemoved: 1, specialFolderRows: 0, firestoreDocs: 6, derivativeObjects: 0 },
  },
}));
vi.mock('../src/services/eventDeletionService.js', () => ({
  previewEventDeletion: (...a: unknown[]) => previewEventDeletion(...(a as [])),
  deleteEvent: (...a: unknown[]) => deleteEvent(...(a as [])),
  resolveEvent: async () => identity,
}));

const recordAudit = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../src/services/auditStore.js', () => ({ recordAudit: (...a: unknown[]) => recordAudit(...(a as [])) }));

// The create path in the same router pulls in Drive/email/Firestore; stub them so
// importing the server stays offline.
vi.mock('../src/services/userStore.js', () => ({ listUsers: async () => [] }));
vi.mock('../src/services/emailPrefsStore.js', () => ({ optedInAmong: async () => [] }));
vi.mock('../src/services/emailService.js', () => ({ sendEmail: async () => false, sendToMany: async () => 0 }));
vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({ collection: () => ({ doc: () => ({ set: async () => undefined }) }) }),
}));
vi.mock('../src/services/driveService.js', () => ({
  DRIVE_SCOPE_READWRITE: 'rw',
  getDriveToken: async () => 'tok',
  getOrCreateSubfolder: async () => ({ id: 'f', name: 'f' }),
}));
vi.mock('../src/services/indexerJob.js', () => ({ triggerIndexJob: async () => ({ execution: 'x' }) }));
vi.mock('../src/services/eventStore.js', () => ({
  folderNameFor: (d: string, n: string) => `${d}_${n}`,
  findByFolderName: async () => null,
  createEvent: async () => ({ eventId: 'e' }),
}));

const { buildServer } = await import('../src/server.js');

const SUPER = JSON.stringify({ uid: 's', email: 'boss@x.org', emailVerified: true, role: 'super_admin', clubId: '' });
const CLUB = JSON.stringify({ uid: 'c', email: 'lead@blue.org', emailVerified: true, role: 'club_admin', clubId: 'Blue' });
const MEMBER = JSON.stringify({ uid: 'm', email: 'm@x.org', emailVerified: true });

const DELETE_URL = '/api/admin/events/ev1/delete';

describe('event delete route', () => {
  const app = buildServer();

  beforeEach(() => {
    identity = { eventId: 'ev1', name: 'Test' };
    previewEventDeletion.mockClear();
    deleteEvent.mockClear();
    recordAudit.mockClear();
  });

  it('is super-admin only: a club_admin and a member are both forbidden', async () => {
    for (const user of [CLUB, MEMBER]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post(DELETE_URL).set('x-test-user', user).send({});
      expect(res.status).toBe(403);
    }
    expect((await request(app).get('/api/admin/events/ev1/delete-preview').set('x-test-user', CLUB)).status).toBe(403);
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it('accepts the machine token (shell tooling) with no Firebase user', async () => {
    const res = await request(app).post(DELETE_URL).set('X-Sync-Token', 'cron-secret').send({});
    expect(res.status).toBe(200);
    expect(res.body.apply).toBe(false);
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it('rejects a wrong machine token', async () => {
    expect((await request(app).post(DELETE_URL).set('X-Sync-Token', 'nope').send({})).status).toBe(401);
  });

  it('dry runs when apply is absent or false', async () => {
    for (const body of [{}, { apply: false }]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post(DELETE_URL).set('x-test-user', SUPER).send(body);
      expect(res.status).toBe(200);
      expect(res.body.apply).toBe(false);
    }
    expect(deleteEvent).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('rejects a truthy-but-not-boolean apply instead of treating it as an apply', async () => {
    for (const body of [{ apply: 'yes' }, { apply: 1 }, { apply: 'true' }]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post(DELETE_URL).set('x-test-user', SUPER).send(body);
      expect(res.status).toBe(400);
    }
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it('refuses an apply without a matching confirmName', async () => {
    for (const body of [{ apply: true }, { apply: true, confirmName: '' }, { apply: true, confirmName: 'Test1' }]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post(DELETE_URL).set('x-test-user', SUPER).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('confirm_mismatch');
    }
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it('applies with the event name (case-insensitive) or the event id, and audits it', async () => {
    for (const confirmName of ['Test', 'test', 'ev1']) {
      deleteEvent.mockClear();
      recordAudit.mockClear();
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post(DELETE_URL).set('x-test-user', SUPER).send({ apply: true, confirmName });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ apply: true, driveFolderTrashed: true, deleteId: 'del-1' });
      expect(deleteEvent).toHaveBeenCalledTimes(1);
      expect(recordAudit.mock.calls[0]?.[1]).toMatchObject({ action: 'EVENT_DELETED', resourceType: 'event' });
    }
  });

  it('confirms a nameless event by id only', async () => {
    identity = { eventId: 'ev1', name: '' };
    const bad = await request(app).post(DELETE_URL).set('x-test-user', SUPER).send({ apply: true, confirmName: 'Test' });
    expect(bad.status).toBe(400);
    const ok = await request(app).post(DELETE_URL).set('x-test-user', SUPER).send({ apply: true, confirmName: 'ev1' });
    expect(ok.status).toBe(200);
  });

  it('404s an unknown event without calling the delete', async () => {
    identity = null;
    const res = await request(app).post(DELETE_URL).set('x-test-user', SUPER).send({ apply: true, confirmName: 'ev1' });
    expect(res.status).toBe(404);
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it('preview is read-only and returns the inventory', async () => {
    const res = await request(app).get('/api/admin/events/ev1/delete-preview').set('x-test-user', SUPER);
    expect(res.status).toBe(200);
    expect(res.body.inventory).toMatchObject({ links: 5, activeLinks: 5 });
    expect(deleteEvent).not.toHaveBeenCalled();
  });
});
