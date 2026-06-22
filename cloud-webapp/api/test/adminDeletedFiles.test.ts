import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

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
vi.mock('../src/middleware/rbac.js', () => {
  const deny = (res: Response) => res.status(403).json({ ok: false, error: 'forbidden' });
  return {
    attachRole: (_req: Request, _res: Response, next: NextFunction) => next(),
    requireSuperAdmin: (req: Request, res: Response, next: NextFunction) =>
      req.user?.role === 'super_admin' ? next() : deny(res),
    requireAnyAdmin: (req: Request, res: Response, next: NextFunction) =>
      req.user?.role === 'super_admin' || req.user?.role === 'club_admin' ? next() : deny(res),
    requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
    requireClubScope: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  };
});
vi.mock('../src/middleware/cronAuth.js', () => ({
  allowCronOrAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const recordAudit = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../src/services/auditStore.js', () => ({ recordAudit: (...a: unknown[]) => recordAudit(...a) }));

const trashFile = vi.fn(async () => undefined);
const untrashFile = vi.fn(async () => undefined);
const deleteFilePermanently = vi.fn(async () => undefined);
vi.mock('../src/services/driveService.js', () => ({
  trashFile: (...a: unknown[]) => trashFile(...(a as [])),
  untrashFile: (...a: unknown[]) => untrashFile(...(a as [])),
  deleteFilePermanently: (...a: unknown[]) => deleteFilePermanently(...(a as [])),
}));

interface Rec { deleteId: string; driveFileId: string; clubName: string; status: string }
let store: Rec[] = [];
class DeletedFilesError extends Error {
  constructor(public code: string, m: string) {
    super(m);
    this.name = 'DeletedFilesError';
  }
}
vi.mock('../src/services/deletedFilesStore.js', () => ({
  DeletedFilesError,
  listDeleted: async (_sid: string, f?: { clubName?: string; status?: string }) => {
    let a = [...store];
    if (f?.clubName !== undefined) a = a.filter((r) => r.clubName === f.clubName);
    if (f?.status !== undefined) a = a.filter((r) => r.status === f.status);
    return a;
  },
  recordSoftDelete: async (_sid: string, input: { driveFileId: string; clubName: string }) => {
    const rec = { deleteId: 'new', driveFileId: input.driveFileId, clubName: input.clubName, status: 'deleted' };
    store.push(rec);
    return rec;
  },
  markRestored: async (_sid: string, id: string) => ({ ...store.find((r) => r.deleteId === id)!, status: 'restored' }),
  markPurged: async (_sid: string, id: string) => ({ ...store.find((r) => r.deleteId === id)!, status: 'purged' }),
  findExpired: async () => store.filter((r) => r.status === 'deleted'),
}));

const { buildServer } = await import('../src/server.js');

const SUPER = JSON.stringify({ uid: 's', email: 'boss@x.org', emailVerified: true, role: 'super_admin' });
const CHI = JSON.stringify({ uid: 'c', email: 'ca@x.org', emailVerified: true, role: 'club_admin', clubId: 'CHI' });

describe('admin deleted-files routes', () => {
  const app = buildServer();
  beforeEach(() => {
    store = [{ deleteId: 'd-chi', driveFileId: 'f1', clubName: 'CHI', status: 'deleted' }];
    recordAudit.mockClear();
    trashFile.mockClear();
    untrashFile.mockClear();
    deleteFilePermanently.mockClear();
  });

  it('soft-delete trashes the Drive file, ledgers it, audits — club-scoped', async () => {
    const denied = await request(app).post('/api/admin/deleted-files').set('x-test-user', CHI).send({ driveFileId: 'f9', clubName: 'NYC' });
    expect(denied.status).toBe(403);
    expect(trashFile).not.toHaveBeenCalled();

    const ok = await request(app).post('/api/admin/deleted-files').set('x-test-user', CHI).send({ driveFileId: 'f9', clubName: 'CHI' });
    expect(ok.status).toBe(201);
    expect(trashFile).toHaveBeenCalledWith('f9');
    expect(recordAudit.mock.calls[0]?.[1]).toMatchObject({ action: 'FILE_DELETED' });
  });

  it('restore untrashes + marks restored; 404 unknown', async () => {
    const res = await request(app).post('/api/admin/deleted-files/d-chi/restore').set('x-test-user', SUPER);
    expect(res.status).toBe(200);
    expect(untrashFile).toHaveBeenCalledWith('f1');
    expect(res.body.file.status).toBe('restored');
    const nf = await request(app).post('/api/admin/deleted-files/ghost/restore').set('x-test-user', SUPER);
    expect(nf.status).toBe(404);
  });

  it('purge permanently deletes expired files', async () => {
    const res = await request(app).post('/api/admin/deleted-files/purge').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, purged: 1, failed: 0 });
    expect(deleteFilePermanently).toHaveBeenCalledWith('f1');
  });

  it('GET lists scoped to the caller club', async () => {
    store = [
      { deleteId: 'a', driveFileId: 'f1', clubName: 'CHI', status: 'deleted' },
      { deleteId: 'b', driveFileId: 'f2', clubName: 'NYC', status: 'deleted' },
    ];
    const res = await request(app).get('/api/admin/deleted-files').set('x-test-user', CHI);
    expect(res.body.files.map((f: Rec) => f.deleteId)).toEqual(['a']);
  });
});
