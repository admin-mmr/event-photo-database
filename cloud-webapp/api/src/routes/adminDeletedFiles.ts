/**
 * adminDeletedFiles.ts — soft-delete lifecycle (dev plan G5.1). Soft-delete
 * trashes the Drive file + ledgers it; restore untrashes within the retention
 * window; the purge job permanently deletes expired records. All actions audited;
 * club-scoped (a club_admin only acts on their own club's files).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  SoftDeleteRequestSchema,
  type DeletedFileResponse,
  type ListDeletedFilesResponse,
  type PurgeResponse,
} from '@cloud-webapp/shared';

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { allowCronOrAdmin } from '../middleware/cronAuth.js';
import { attachRole, requireAnyAdmin } from '../middleware/rbac.js';
import { recordAudit } from '../services/auditStore.js';
import { deleteFilePermanently, trashFile, untrashFile } from '../services/driveService.js';
import {
  findExpired,
  listDeleted,
  markPurged,
  markRestored,
  recordSoftDelete,
} from '../services/deletedFilesStore.js';
import { removeShortcutsForTargets } from '../services/specialFoldersService.js';
import { tryRebuildPublicFolderIndex } from '../services/publicFolderIndexService.js';
import { actor, effectiveClubScope, handleStoreError, masterSheetId } from './adminShared.js';

export const adminDeletedFilesRouter = Router();

function denyOutOfScope(req: Request, res: Response, clubName: string): boolean {
  const scope = effectiveClubScope(req);
  if (scope !== undefined && clubName !== scope) {
    res.status(403).json({ ok: false, error: 'forbidden', message: 'Outside your club scope' });
    return true;
  }
  return false;
}

/** GET /api/admin/deleted-files?status&eventId — scoped to the caller's club. */
adminDeletedFilesRouter.get('/admin/deleted-files', requireAuth, attachRole, requireAnyAdmin, async (req, res, next) => {
  try {
    const sid = masterSheetId(res);
    if (!sid) return;
    const scope = effectiveClubScope(req);
    const filter: Parameters<typeof listDeleted>[1] = {};
    if (scope !== undefined) filter.clubName = scope;
    const status = req.query.status;
    if (status === 'deleted' || status === 'restored' || status === 'purged') filter.status = status;
    if (typeof req.query.eventId === 'string' && req.query.eventId) filter.eventId = req.query.eventId;
    const files = await listDeleted(sid, filter);
    const body: ListDeletedFilesResponse = { ok: true, files };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/deleted-files — trash a Drive file + ledger it (soft delete). */
adminDeletedFilesRouter.post('/admin/deleted-files', requireAuth, attachRole, requireAnyAdmin, async (req, res, next) => {
  try {
    const sid = masterSheetId(res);
    if (!sid) return;
    const input = SoftDeleteRequestSchema.parse(req.body ?? {});
    if (denyOutOfScope(req, res, input.clubName.trim())) return;
    await trashFile(input.driveFileId);
    const file = await recordSoftDelete(sid, input, actor(req));
    // Retire any managed shortcuts/copies that pointed at this original so they
    // don't dangle in the public-browse folders. Best-effort + gated; trashed
    // (recoverable) entries are recreated if the file is restored + rebuilt.
    if (env.MANAGED_FOLDERS_ENABLED === 'true') {
      try {
        await removeShortcutsForTargets([file.driveFileId]);
        await tryRebuildPublicFolderIndex();
      } catch (err) {
        logger.warn({ err, driveFileId: file.driveFileId }, 'managed-folders sweep after delete failed (non-fatal)');
      }
    }
    await recordAudit(sid, {
      actorEmail: actor(req),
      action: 'FILE_DELETED',
      resourceType: 'other',
      resourceId: file.driveFileId,
      details: { deleteId: file.deleteId, clubName: file.clubName, eventId: file.eventId },
      reason: file.deletedReason,
      ip: req.ip ?? '',
    });
    const body: DeletedFileResponse = { ok: true, file };
    res.status(201).json(body);
  } catch (err) {
    if (handleStoreError(err, res)) return;
    next(err);
  }
});

/** POST /api/admin/deleted-files/:deleteId/restore — untrash + mark restored. */
adminDeletedFilesRouter.post(
  '/admin/deleted-files/:deleteId/restore',
  requireAuth,
  attachRole,
  requireAnyAdmin,
  async (req, res, next) => {
    try {
      const sid = masterSheetId(res);
      if (!sid) return;
      const deleteId = String(req.params.deleteId);
      const all = await listDeleted(sid);
      const target = all.find((f) => f.deleteId === deleteId);
      if (!target) {
        res.status(404).json({ ok: false, error: 'not_found', message: `Delete record not found: ${deleteId}` });
        return;
      }
      if (denyOutOfScope(req, res, target.clubName)) return;
      await untrashFile(target.driveFileId);
      const file = await markRestored(sid, deleteId, actor(req));
      await recordAudit(sid, {
        actorEmail: actor(req),
        action: 'FILE_RESTORED',
        resourceType: 'other',
        resourceId: file.driveFileId,
        details: { deleteId: file.deleteId, clubName: file.clubName },
        ip: req.ip ?? '',
      });
      const body: DeletedFileResponse = { ok: true, file };
      res.json(body);
    } catch (err) {
      if (handleStoreError(err, res)) return;
      next(err);
    }
  },
);

/**
 * POST /api/admin/deleted-files/purge — permanently delete soft-deleted files
 * past the retention window. Cloud Scheduler (or an admin) calls this daily.
 */
adminDeletedFilesRouter.post('/admin/deleted-files/purge', allowCronOrAdmin, async (_req, res, next) => {
  try {
    const sid = env.MASTER_SPREADSHEET_ID;
    if (!sid) {
      res.status(503).json({ ok: false, error: 'not_configured', message: 'MASTER_SPREADSHEET_ID is not set' });
      return;
    }
    const expired = await findExpired(sid, env.SOFT_DELETE_RETENTION_DAYS);
    let purged = 0;
    let failed = 0;
    for (const rec of expired) {
      try {
        await deleteFilePermanently(rec.driveFileId);
        await markPurged(sid, rec.deleteId);
        await recordAudit(sid, {
          actorEmail: 'system',
          action: 'FILE_PURGED',
          resourceType: 'other',
          resourceId: rec.driveFileId,
          details: { deleteId: rec.deleteId, retentionDays: env.SOFT_DELETE_RETENTION_DAYS },
        });
        purged += 1;
      } catch (err) {
        logger.warn({ err, deleteId: rec.deleteId }, 'purge of one file failed (continuing)');
        failed += 1;
      }
    }
    logger.info({ purged, failed, candidates: expired.length }, 'deleted-files purge run');
    const body: PurgeResponse = { ok: true, purged, failed };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
