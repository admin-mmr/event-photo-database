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
  countEventMedia,
  dedupeEventManagedFolders,
} from '../services/specialFoldersService.js';
import { listAllSpecialFolders } from '../services/specialFoldersStore.js';
import { rebuildPublicFolderIndex } from '../services/publicFolderIndexService.js';
import {
  enqueueRebuild,
  enqueueFullRebuild,
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

/**
 * POST /admin/folders/rebuild/:eventId — full rebuild for ONE event. Enqueued as
 * a stepped 'full' batch (Photos_NNN → Videos → Albums → public sheet) and
 * drained step-by-step, so a large event no longer 502s at the 60s cap. Returns
 * 202 with the batchId; the UI drives `/rebuild-drain` and polls
 * `/rebuild-status` for per-step progress.
 */
adminManagedFoldersRouter.post('/admin/folders/rebuild/:eventId', ...guard, async (req, res, next) => {
  try {
    if (!masterSheetId(res) || notEnabled(res)) return;
    const eventId = String(req.params.eventId);
    const { id, total } = await enqueueFullRebuild(eventId, { createdBy: actor(req) });
    logger.info({ eventId, batchId: id, by: actor(req) }, 'enqueued full rebuild batch for event');
    res.status(202).json({ ok: true, mode: 'async', batchId: id, total });
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

/**
 * GET /admin/folders/reconcile/:eventId — a one-glance reconciliation of the
 * counts that diverge across the pipeline, so an admin can see WHERE photos drop
 * off without digging through the Sheet / index manifest:
 *   - source:  media actually in the event's Drive tree (live walk, same MIME
 *              filter the Photos_NNN rebuild uses)
 *   - folders: how many entries the managed Photos_NNN / Videos / Album folders
 *              currently hold (summed Special_Folders fileCount)
 *   - index:   what the FindMe indexer recorded (photos seen + face vectors);
 *              fewer faces than photos is expected (no detectable face).
 */
adminManagedFoldersRouter.get('/admin/folders/reconcile/:eventId', ...guard, async (req, res, next) => {
  try {
    const spreadsheetId = masterSheetId(res);
    if (!spreadsheetId || notEnabled(res)) return;
    const eventId = String(req.params.eventId);

    const [source, records, evSnap] = await Promise.all([
      countEventMedia(eventId),
      listAllSpecialFolders(spreadsheetId),
      firestore().collection('events').doc(eventId).get(),
    ]);

    const folders = { photos: 0, videos: 0, albums: 0 };
    for (const r of records) {
      if (r.eventId !== eventId) continue;
      if (r.scope === 'photos') folders.photos += r.fileCount;
      else if (r.scope === 'videos') folders.videos += r.fileCount;
      else if (r.scope === 'albums') folders.albums += r.fileCount;
    }

    const idx = (evSnap.data()?.indexState ?? null) as Record<string, unknown> | null;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const index = idx
      ? {
          status: typeof idx.status === 'string' ? idx.status : null,
          photos: num(idx.photoCount),
          faces: num(idx.faces),
          persons: num(idx.persons),
          duplicates: num(idx.duplicates),
          updatedAt: typeof idx.updatedAt === 'string' ? idx.updatedAt : null,
        }
      : null;

    res.json({ ok: true, eventId, source, folders, index });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/folders/dedupe/:eventId — trash duplicate managed folders for one
 * event (keep the oldest), drop their stale Special_Folders rows, then refresh
 * the public index. Single-event so it fits the 60s budget. Use when the
 * "Managed Albums" sheet shows duplicate rows / Drive shows two Album folders.
 */
adminManagedFoldersRouter.post('/admin/folders/dedupe/:eventId', ...guard, async (req, res, next) => {
  try {
    if (!masterSheetId(res) || notEnabled(res)) return;
    const eventId = String(req.params.eventId);
    const result = await dedupeEventManagedFolders(eventId);
    await rebuildPublicFolderIndex();
    logger.info({ eventId, trashed: result.trashedFolders, rows: result.rowsRemoved, by: actor(req) }, 'manual dedupe managed folders');
    res.json({ eventId, ...result });
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
