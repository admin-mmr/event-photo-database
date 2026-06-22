import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

process.env.MASTER_SPREADSHEET_ID = 'sheet1';
process.env.EVENTS_ROOT_FOLDER_ID = 'root-folder';

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

const recordAudit = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../src/services/auditStore.js', () => ({ recordAudit: (...a: unknown[]) => recordAudit(...a) }));

const fsSet = vi.fn(async () => undefined);
vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({ collection: () => ({ doc: () => ({ set: fsSet }) }) }),
}));

const getOrCreateSubfolder = vi.fn(async () => ({ id: 'folder-xyz', name: 'f' }));
vi.mock('../src/services/driveService.js', () => ({
  DRIVE_SCOPE_READWRITE: 'rw',
  getDriveToken: async () => 'tok',
  getOrCreateSubfolder: (...a: unknown[]) => getOrCreateSubfolder(...(a as [])),
}));

const triggerIndexJob = vi.fn(async () => ({ execution: 'exec-1' }));
vi.mock('../src/services/indexerJob.js', () => ({ triggerIndexJob: (...a: unknown[]) => triggerIndexJob(...(a as [])) }));

let existingFolder: unknown = null;
const createEvent = vi.fn(async (_sid: string, input: { name: string; date: string; folderName: string; driveFolderId: string }, actorEmail: string) => ({
  eventId: 'ev-new', name: input.name, date: input.date, folderName: input.folderName, driveFolderId: input.driveFolderId, createdBy: actorEmail, createdAt: 't',
}));
vi.mock('../src/services/eventStore.js', () => ({
  folderNameFor: (date: string, name: string) => `${date}_${name.replace(/\s+/g, '_')}`,
  findByFolderName: async () => existingFolder,
  createEvent: (...a: unknown[]) => createEvent(...(a as [string, never, string])),
}));

const { buildServer } = await import('../src/server.js');

const SUPER = JSON.stringify({ uid: 's', email: 'boss@x.org', emailVerified: true, role: 'super_admin', clubId: '' });
const MEMBER = JSON.stringify({ uid: 'm', email: 'm@x.org', emailVerified: true });

describe('admin events route', () => {
  const app = buildServer();

  beforeEach(() => {
    existingFolder = null;
    recordAudit.mockClear();
    getOrCreateSubfolder.mockClear();
    createEvent.mockClear();
    triggerIndexJob.mockClear();
    fsSet.mockClear();
  });

  it('non-admin is forbidden; bad date is 400', async () => {
    expect((await request(app).post('/api/admin/events').set('x-test-user', MEMBER).send({ name: 'X', date: '2026-06-01' })).status).toBe(403);
    expect((await request(app).post('/api/admin/events').set('x-test-user', SUPER).send({ name: 'X', date: 'nope' })).status).toBe(400);
  });

  it('creates an event: Drive folder + sheet row + cache + index + audit', async () => {
    const res = await request(app)
      .post('/api/admin/events')
      .set('x-test-user', SUPER)
      .send({ name: 'Spring Run', date: '2026-04-01' });
    expect(res.status).toBe(201);
    expect(res.body.event).toMatchObject({ eventId: 'ev-new', driveFolderId: 'folder-xyz', folderName: '2026-04-01_Spring_Run' });
    expect(getOrCreateSubfolder).toHaveBeenCalledWith('root-folder', '2026-04-01_Spring_Run', expect.anything());
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(triggerIndexJob).toHaveBeenCalledWith('ev-new');
    expect(recordAudit.mock.calls[0]?.[1]).toMatchObject({ action: 'EVENT_CREATED', resourceType: 'event' });
  });

  it('duplicate folderName → 409 before creating a Drive folder', async () => {
    existingFolder = { eventId: 'old', folderName: '2026-04-01_Spring_Run' };
    const res = await request(app)
      .post('/api/admin/events')
      .set('x-test-user', SUPER)
      .send({ name: 'Spring Run', date: '2026-04-01' });
    expect(res.status).toBe(409);
    expect(getOrCreateSubfolder).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
  });
});
