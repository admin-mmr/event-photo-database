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
import { requireAdmin } from '../middleware/admin.js';
import { triggerIndexJob } from '../services/indexerJob.js';

export const eventsRouter = Router();

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
 * POST /api/events/:id/index — admin trigger for the indexer Job (M1.4).
 * Body: { force?: boolean }. Responds 202 with the execution name; progress
 * lands in the event doc's `indexState` (written by the job itself).
 */
eventsRouter.post('/events/:id/index', requireAuth, requireAdmin, async (req, res, next) => {
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
      .set({ indexState: { status: 'queued' } }, { merge: true });

    logger.info({ eventId, execution, admin: req.user?.email }, 'index job triggered');
    const body: TriggerIndexResponse = { ok: true, eventId, execution };
    res.status(202).json(body);
  } catch (err) {
    next(err);
  }
});
