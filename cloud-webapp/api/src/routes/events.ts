import { Router } from 'express';
import {
  EventSummarySchema,
  TriggerIndexRequestSchema,
  type ListEventsResponse,
  type TriggerIndexResponse,
} from '@cloud-webapp/shared';

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { allowCronOrAdmin } from '../middleware/cronAuth.js';
import { triggerIndexJob } from '../services/indexerJob.js';

export const eventsRouter = Router();

/** Index-state values that mean "a run is already in flight" — skipped by the
 *  scan so we never stack executions on the same event. */
const IN_FLIGHT = new Set(['queued', 'running']);

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

    const { execution } = await triggerIndexJob(eventId, { force });
    await firestore()
      .collection('events')
      .doc(eventId)
      .set({ indexState: { status: 'queued', updatedAt: new Date().toISOString() } }, { merge: true });

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

      try {
        const { execution } = await triggerIndexJob(eventId);
        await firestore()
          .collection('events')
          .doc(eventId)
          .set({ indexState: { status: 'queued', updatedAt: new Date().toISOString() } }, { merge: true });
        triggered.push(eventId);
        logger.info({ eventId, execution }, 'index-scan triggered event');
      } catch (err) {
        logger.warn({ err, eventId }, 'index-scan trigger failed (non-fatal)');
        skipped.push({ eventId, reason: 'trigger_failed' });
      }
    }

    logger.info(
      { triggered: triggered.length, scanned: snap.size, by: req.user?.email ?? 'cron' },
      'index-scan complete',
    );
    res.json({ ok: true, scanned: snap.size, triggered, skipped });
  } catch (err) {
    next(err);
  }
});
