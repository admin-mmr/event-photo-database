/**
 * adminManagedFolders.ts — manual triggers for the managed-folders pipeline
 * (gas-app migration). These let an admin re-run the post-upload procedure when
 * the automatic inline hook or the scheduled index-scan rebuild failed.
 *
 * All routes require an admin (requireAuth + attachRole + requireAnyAdmin) and
 * the master Sheet. They mirror the gas-app "Public Sheet" admin buttons:
 *   POST /api/admin/folders/refresh-public        — rewrite the public index only
 *   POST /api/admin/folders/rebuild/:eventId      — full rebuild for one event
 *   POST /api/admin/folders/rebuild-photos        — Photos_NNN for one/all events
 *   POST /api/admin/folders/rebuild-videos-albums — Videos+Album for one/all events
 *   POST /api/admin/folders/migrate-photo-shortcuts — one-off non-JPEG upgrade
 *   POST /api/admin/folders/backfill-sharing      — one-off re-share of all folders
 *
 * Drive-heavy operations are paced by driveRateLimit. "all events" variants are
 * bounded by the events present in the Firestore cache and are intended for
 * occasional manual recovery, not a hot path.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';

import { firestore } from '../lib/firestore.js';
import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { attachRole, requireAnyAdmin } from '../middleware/rbac.js';
import { allowCronOrAdmin } from '../middleware/cronAuth.js';
import {
  rebuildEventPhotoFolders,
  rebuildAllSpecialFoldersForEvent,
  migrateEventPhotoShortcutsToFiles,
  backfillSpecialFoldersSharing,
} from '../services/specialFoldersService.js';
import { rebuildPublicFolderIndex } from '../services/publicFolderIndexService.js';
import {
  enqueueRebuild,
  drainRebuildQueue,
  getBatch,
  latestBatch,
  type RebuildKind,
} from '../services/folderRebuildQueue.js';
import { actor, masterSheetId } from './adminShared.js';

export const adminManagedFoldersRouter = Router();

const guard = [requireAuth, attachRole, requireAnyAdmin] as const;

function notEnabled(res: Response): boolean {
  if (env.MANAGED_FOLDERS_ENABLED !== 'true') {
    res.status(503).json({ ok: false, error: 'not_enabled', message: 'MANAGED_FOLDERS_ENABLED is not "true"' });
    return true;
  }
  return false;
}

/** All event IDs from the Firestore events cache (for "all events" variants). */
async function allEventIds(): Promise<string[]> {
  const snap = await firestore().collection('events').get();
  return snap.docs.map((d) => d.id);
}

/** A single `eventId` from the body, trimmed, or '' for the "all events" case. */
function singleEventId(body: unknown): string {
  return typeof (body as { eventId?: unknown })?.eventId === 'string' ? (body as { eventId: string }).eventId.trim() : '';
}

/**
 * Shared handler for the per-event-loop rebuilds (photos / videos-albums /
 * migrate-shortcuts). A single `eventId` runs synchronously (one event fits the
 * 60s request budget); the "all events" case is enqueued as a batch and drained
 * by the scheduler so it never trips the Hosting/Cloud Run timeout.
 */
async function handleRebuild(
  kind: RebuildKind,
  req: Request,
  res: Response,
  refreshPublic: boolean,
): Promise<void> {
  const eventId = singleEventId(req.body);
  if (eventId) {
    if (kind === 'videos-albums') await rebuildAllSpecialFoldersForEvent(eventId);
    else if (kind === 'photos') await rebuildEventPhotoFolders(eventId);
    else await migrateEventPhotoShortcutsToFiles(eventId);
    if (refreshPublic) await rebuildPublicFolderIndex();
    logger.info({ kind, eventId, by: actor(req) }, 'synchronous single-event rebuild');
    res.json({ ok: true, mode: 'sync', eventId });
    return;
  }
  const ids = await allEventIds();
  const { id, total } = await enqueueRebuild(kind, ids, { createdBy: actor(req), refreshPublic });
  logger.info({ kind, batchId: id, total, by: actor(req) }, 'enqueued all-events rebuild batch');
  res.status(202).json({ ok: true, mode: 'async', batchId: id, total });
}

adminManagedFoldersRouter.post('/admin/folders/refresh-public', ...guard, async (req, res, next) => {
  try {
    if (!masterSheetId(res) || notEnabled(res)) return;
    const rows = await rebuildPublicFolderIndex();
    logger.info({ rows, by: actor(req) }, 'manual public folder index refresh');
    res.json({ ok: true, rows });
  } catch (err) {
    next(err);
  }
});

adminManagedFoldersRouter.post('/admin/folders/rebuild/:eventId', ...guard, async (req, res, next) => {
  try {
    if (!masterSheetId(res) || notEnabled(res)) return;
    const eventId = String(req.params.eventId);
    const result = await rebuildAllSpecialFoldersForEvent(eventId);
    await rebuildPublicFolderIndex();
    logger.info({ eventId, by: actor(req) }, 'manual full rebuild for event');
    res.json({ ok: true, eventId, result });
  } catch (err) {
    next(err);
  }
});

adminManagedFoldersRouter.post('/admin/folders/rebuild-photos', ...guard, async (req, res, next) => {
  try {
    if (!masterSheetId(res) || notEnabled(res)) return;
    await handleRebuild('photos', req, res, true);
  } catch (err) {
    next(err);
  }
});

adminManagedFoldersRouter.post('/admin/folders/rebuild-videos-albums', ...guard, async (req, res, next) => {
  try {
    if (!masterSheetId(res) || notEnabled(res)) return;
    await handleRebuild('videos-albums', req, res, true);
  } catch (err) {
    next(err);
  }
});

adminManagedFoldersRouter.post('/admin/folders/migrate-photo-shortcuts', ...guard, async (req, res, next) => {
  try {
    if (!masterSheetId(res) || notEnabled(res)) return;
    await handleRebuild('migrate-shortcuts', req, res, false);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/folders/rebuild-drain — process queued "all events" rebuild
 * batches. Cloud Scheduler (`findme-folder-rebuild`) hits this every couple of
 * minutes via the `allowCronOrAdmin` machine path; an admin can also trigger a
 * drain by hand. Cheap no-op when nothing is queued. See folderRebuildQueue.ts.
 */
adminManagedFoldersRouter.post('/admin/folders/rebuild-drain', allowCronOrAdmin, async (req, res, next) => {
  try {
    if (!masterSheetId(res) || notEnabled(res)) return;
    const summary = await drainRebuildQueue();
    res.json({ ok: true, ...summary });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/folders/rebuild-status — progress for the UI to poll. `?batchId=`
 * for a specific batch, otherwise the most recent one.
 */
adminManagedFoldersRouter.get('/admin/folders/rebuild-status', ...guard, async (req, res, next) => {
  try {
    const batchId = typeof req.query.batchId === 'string' ? req.query.batchId : '';
    const batch = batchId ? await getBatch(batchId) : await latestBatch();
    res.json({ ok: true, batch });
  } catch (err) {
    next(err);
  }
});

adminManagedFoldersRouter.post('/admin/folders/backfill-sharing', ...guard, async (req, res, next) => {
  try {
    if (!masterSheetId(res) || notEnabled(res)) return;
    const summary = await backfillSpecialFoldersSharing();
    logger.info({ ...summary, by: actor(req) }, 'manual backfill-sharing');
    res.json({ ok: true, summary });
  } catch (err) {
    next(err);
  }
});
