import { Router } from 'express';
import {
  EventSummarySchema,
  TriggerIndexRequestSchema,
  type ListEventsResponse,
  type GetEventResponse,
  type TriggerIndexResponse,
} from '@cloud-webapp/shared';

import { firestore } from '../lib/firestore.js';
import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { attachRole, requireAnyAdmin } from '../middleware/rbac.js';
import { allowCronOrAdmin } from '../middleware/cronAuth.js';
import { triggerIndexJob } from '../services/indexerJob.js';
import { listEventImages } from '../services/driveService.js';
import { rebuildAllSpecialFoldersForEvent } from '../services/specialFoldersService.js';
import { tryRebuildPublicFolderIndex } from '../services/publicFolderIndexService.js';

export const eventsRouter = Router();

/** Index-state values that mean "a run is already in flight" — skipped by the
 *  scan so we never stack executions on the same event. */
const IN_FLIGHT = new Set(['queued', 'running']);

/**
 * A cheap fingerprint of an event's Drive image set: total image count plus the
 * latest `modifiedTime` across all images (listEventImages recurses, so nested
 * upload buckets are covered). The value changes whenever a photo is added,
 * removed, or modified — exactly the cases that warrant a re-index. The scan
 * compares this against the `lastIndexSig` we persisted on the previous trigger
 * to skip events whose Drive content hasn't changed since they were last
 * indexed, avoiding a redundant Cloud Run execution per scan tick.
 */
async function computeDriveSig(folderId: string): Promise<string> {
  const images = await listEventImages(folderId);
  let maxModified = '';
  for (const img of images) {
    if (img.modifiedTime && img.modifiedTime > maxModified) maxModified = img.modifiedTime;
  }
  return `${images.length}:${maxModified}`;
}

/**
 * GET /api/events — list events visible to a signed-in user (M1 minimal:
 * all events; per-event visibility rules land with the gallery in M3).
 */
eventsRouter.get('/events', requireAuth, async (_req, res, next) => {
  try {
    const snap = await firestore().collection('events').get();
    const events = snap.docs.map((d) =>
      // Strip unknown gas-app-era fields; tolerate partial docs.
      EventSummarySchema.parse({ id: d.id, ...d.data() }),
    );
    const body: ListEventsResponse = { ok: true, events };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/events/:id — a single event's summary. Cheap (one Firestore doc
 * read, no photo signing) so the gallery can render the event title
 * immediately rather than waiting for the photo list to load.
 */
eventsRouter.get('/events/:id', requireAuth, async (req, res, next) => {
  try {
    const eventId = String(req.params.id);
    const doc = await firestore().collection('events').doc(eventId).get();
    if (!doc.exists) {
      res.status(404).json({ ok: false, error: 'not_found', message: `Unknown event '${eventId}'` });
      return;
    }
    const event = EventSummarySchema.parse({ id: eventId, ...doc.data() });
    const body: GetEventResponse = { ok: true, event };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/events/:id/album-folders — public-facing list of the event's managed
 * Album folders (Drive links) so the gallery can offer "Open album in Drive".
 * Reads the `specialFolders` Firestore cache (mirrors the Special_Folders sheet,
 * written on every rebuild) — no Sheets quota on this user-facing path. The
 * folders are shared anyone-with-link, so exposing the URL is safe. One equality
 * filter (eventId) uses an automatic index; scope is filtered in memory.
 */
eventsRouter.get('/events/:id/album-folders', requireAuth, async (req, res, next) => {
  try {
    const eventId = String(req.params.id);
    const snap = await firestore().collection('specialFolders').where('eventId', '==', eventId).get();
    const folders = snap.docs
      .map((d) => d.data() as Record<string, unknown>)
      .filter((r) => r.scope === 'albums' && typeof r.folderUrl === 'string' && r.folderUrl)
      .map((r) => ({
        clubName: String(r.clubName ?? ''),
        tag: String(r.tag ?? ''),
        folderUrl: String(r.folderUrl),
        fileCount: typeof r.fileCount === 'number' ? r.fileCount : 0,
      }))
      .sort((a, b) => a.clubName.localeCompare(b.clubName) || a.tag.localeCompare(b.tag));
    res.json({ ok: true, folders });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/events/:id/duplicates — admin audit of de-duplicated photos
 * (B6 / FR-2c). Reports how many byte-identical duplicates the indexer collapsed
 * and which canonical photos absorbed them, so an admin can verify dedup is
 * working without digging into the GCS manifest.
 */
eventsRouter.get('/events/:id/duplicates', requireAuth, attachRole, requireAnyAdmin, async (req, res, next) => {
  try {
    const eventId = String(req.params.id);
    const snap = await firestore().collection('photos').where('eventId', '==', eventId).get();

    let duplicatesRemoved = 0;
    const byPhoto: Array<{ photoId: string; name: string; duplicateCount: number }> = [];
    for (const d of snap.docs) {
      const n = Number(d.data().duplicateCount ?? 0);
      if (n > 0) {
        duplicatesRemoved += n;
        byPhoto.push({ photoId: d.id, name: String(d.data().name ?? ''), duplicateCount: n });
      }
    }
    byPhoto.sort((a, b) => b.duplicateCount - a.duplicateCount);

    res.json({
      ok: true,
      eventId,
      uniquePhotos: snap.size,
      duplicatesRemoved,
      byPhoto,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/events/:id/index — trigger the indexer Job (M1.4).
 * Body: { force?: boolean }. Responds 202 with the execution name; progress
 * lands in the event doc's `indexState` (written by the job itself).
 *
 * Authorized by `allowCronOrAdmin`: a Firebase admin (the web "Index event"
 * button) OR a machine caller with the `X-Sync-Token` secret. The machine
 * path is what lets the gas-app fire this automatically at the end of an
 * upload batch (no-touch indexing) — see AUTOMATED_INDEXING_IMPLEMENTATION.md.
 */
eventsRouter.post('/events/:id/index', allowCronOrAdmin, async (req, res, next) => {
  try {
    const eventId = String(req.params.id);
    const { force } = TriggerIndexRequestSchema.parse(req.body ?? {});

    const doc = await firestore().collection('events').doc(eventId).get();
    if (!doc.exists) {
      res.status(404).json({ ok: false, error: 'not_found', message: `Unknown event '${eventId}'` });
      return;
    }
    if (!doc.data()?.driveFolderId) {
      res.status(409).json({
        ok: false,
        error: 'no_drive_folder',
        message: `Event '${eventId}' has no driveFolderId — set it before indexing`,
      });
      return;
    }
    if (doc.data()?.indexState?.status === 'running' && !force) {
      res.status(409).json({
        ok: false,
        error: 'already_running',
        message: 'An index run is already in progress for this event',
      });
      return;
    }

    // Capture the Drive fingerprint we're about to index so the scan can skip
    // this event next tick if nothing changed. Best-effort: a Drive read
    // failure must not block an explicitly requested index.
    let driveSig = '';
    try {
      driveSig = await computeDriveSig(String(doc.data()?.driveFolderId));
    } catch (err) {
      logger.warn({ err, eventId }, 'index trigger: drive fingerprint failed (non-fatal)');
    }

    const { execution } = await triggerIndexJob(eventId, { force });
    await firestore()
      .collection('events')
      .doc(eventId)
      .set(
        {
          indexState: { status: 'queued', updatedAt: new Date().toISOString() },
          ...(driveSig ? { lastIndexSig: driveSig } : {}),
        },
        { merge: true },
      );

    logger.info({ eventId, execution, admin: req.user?.email ?? 'machine' }, 'index job triggered');
    const body: TriggerIndexResponse = { ok: true, eventId, execution };
    res.status(202).json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/index-scan — safety-net automation (dev plan §7.1 "scheduled
 * Drive change scan"). Cloud Scheduler hits this every few minutes; it triggers
 * the indexer for every event that has a driveFolderId and isn't already
 * running. The indexer is idempotent (md5 + modelVersion diff), so an event
 * with no new photos costs only a Drive listing + a no-op store rewrite — new
 * photos that the end-of-batch trigger missed still get picked up within one
 * scan interval. Catches files added outside the gas-app upload page too.
 *
 * Query/body params (all optional):
 *   activeWithinDays — only scan events whose `date` is within this many days
 *                      (default 21; events with no date are always included).
 *   limit            — cap the number of events triggered per scan (default 25).
 *
 * Authorized by `allowCronOrAdmin` (machine token or Firebase admin).
 */
eventsRouter.post('/admin/index-scan', allowCronOrAdmin, async (req, res, next) => {
  try {
    const activeWithinDays = Number(req.query.activeWithinDays ?? req.body?.activeWithinDays ?? 21);
    const limit = Number(req.query.limit ?? req.body?.limit ?? 25);
    const cutoffMs = Number.isFinite(activeWithinDays)
      ? Date.now() - activeWithinDays * 24 * 60 * 60 * 1000
      : 0;

    const snap = await firestore().collection('events').get();
    const triggered: string[] = [];
    const skipped: { eventId: string; reason: string }[] = [];

    for (const doc of snap.docs) {
      if (triggered.length >= limit) break;
      const data = doc.data();
      const eventId = doc.id;

      if (!data?.driveFolderId) {
        skipped.push({ eventId, reason: 'no_drive_folder' });
        continue;
      }
      if (IN_FLIGHT.has(data?.indexState?.status)) {
        skipped.push({ eventId, reason: 'already_running' });
        continue;
      }
      // Bound cost: skip events whose date is older than the active window.
      const dateStr = typeof data?.date === 'string' ? data.date : '';
      if (cutoffMs && dateStr) {
        const t = Date.parse(dateStr);
        if (Number.isFinite(t) && t < cutoffMs) {
          skipped.push({ eventId, reason: 'outside_active_window' });
          continue;
        }
      }

      // Skip events whose Drive content is unchanged since the last completed
      // index. We re-index only when the fingerprint differs OR the previous
      // run didn't reach 'done' (so failed/never-run events still get picked
      // up). A Drive read failure falls through to triggering, to be safe.
      let driveSig = '';
      try {
        driveSig = await computeDriveSig(String(data.driveFolderId));
      } catch (err) {
        logger.warn({ err, eventId }, 'index-scan: drive fingerprint failed; triggering to be safe');
      }
      const lastSig = typeof data?.lastIndexSig === 'string' ? data.lastIndexSig : '';
      const lastRunDone = data?.indexState?.status === 'done';
      if (driveSig && lastSig && driveSig === lastSig && lastRunDone) {
        skipped.push({ eventId, reason: 'unchanged' });
        continue;
      }

      try {
        const { execution } = await triggerIndexJob(eventId);
        await firestore()
          .collection('events')
          .doc(eventId)
          .set(
            {
              indexState: { status: 'queued', updatedAt: new Date().toISOString() },
              ...(driveSig ? { lastIndexSig: driveSig } : {}),
            },
            { merge: true },
          );
        triggered.push(eventId);
        logger.info({ eventId, execution }, 'index-scan triggered event');
      } catch (err) {
        logger.warn({ err, eventId }, 'index-scan trigger failed (non-fatal)');
        skipped.push({ eventId, reason: 'trigger_failed' });
      }
    }

    // Managed folders (gas-app migration): rebuild Photos_NNN / Videos / Album
    // for the events whose Drive content changed this scan, then refresh the
    // public folder index once. Best-effort — never fails the scan. Walks Drive,
    // so it is gated behind MANAGED_FOLDERS_ENABLED and scoped to changed events;
    // all Drive calls are paced by driveRateLimit so the burst stays under quota.
    let foldersRebuilt = 0;
    if (env.MANAGED_FOLDERS_ENABLED === 'true' && triggered.length > 0) {
      for (const eventId of triggered) {
        try {
          await rebuildAllSpecialFoldersForEvent(eventId);
          foldersRebuilt++;
        } catch (err) {
          logger.warn({ err, eventId }, 'index-scan: special-folders rebuild failed (non-fatal)');
        }
      }
      await tryRebuildPublicFolderIndex();
    }

    logger.info(
      { triggered: triggered.length, scanned: snap.size, foldersRebuilt, by: req.user?.email ?? 'cron' },
      'index-scan complete',
    );
    res.json({ ok: true, scanned: snap.size, triggered, skipped, foldersRebuilt });
  } catch (err) {
    next(err);
  }
});
