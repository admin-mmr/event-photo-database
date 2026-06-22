/**
 * adminEvents.ts — create an event from cloud-webapp (dev plan G3.1).
 *
 * Flow: provision the layer-1 Drive folder (driveService, DWD write scope) →
 * append the Events row (Sheet SSOT, eventStore) → upsert the Firestore `events`
 * cache so the gallery sees it immediately → kick the indexer (best-effort).
 * Audited (EVENT_CREATED). Listing/reading events stays in routes/events.ts.
 *
 * RBAC: any admin may create an event (a club_admin needs one before generating
 * their club's upload links). The Sheet is SSOT; the reconciler keeps the cache
 * in sync on its normal schedule regardless of the direct upsert here.
 */

import { Router } from 'express';
import { CreateEventRequestSchema, type CreateEventResponse } from '@cloud-webapp/shared';

import { env } from '../lib/config.js';
import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { attachRole, requireAnyAdmin } from '../middleware/rbac.js';
import { recordAudit } from '../services/auditStore.js';
import { DRIVE_SCOPE_READWRITE, getDriveToken, getOrCreateSubfolder } from '../services/driveService.js';
import { createEvent, findByFolderName, folderNameFor } from '../services/eventStore.js';
import { triggerIndexJob } from '../services/indexerJob.js';
import { actor, handleStoreError, masterSheetId } from './adminShared.js';

export const adminEventsRouter = Router();

adminEventsRouter.post('/admin/events', requireAuth, attachRole, requireAnyAdmin, async (req, res, next) => {
  try {
    const sid = masterSheetId(res);
    if (!sid) return;
    if (!env.EVENTS_ROOT_FOLDER_ID) {
      res.status(503).json({
        ok: false,
        error: 'not_configured',
        message: 'EVENTS_ROOT_FOLDER_ID is not set — configure the Drive events root first',
      });
      return;
    }

    const { name, date } = CreateEventRequestSchema.parse(req.body ?? {});
    const folderName = folderNameFor(date, name);

    // Dup check before creating a Drive folder, so a duplicate doesn't leave an
    // orphan folder behind.
    if (await findByFolderName(sid, folderName)) {
      res.status(409).json({ ok: false, error: 'duplicate', message: `An event already exists for "${folderName}"` });
      return;
    }

    const token = await getDriveToken(DRIVE_SCOPE_READWRITE);
    const folder = await getOrCreateSubfolder(env.EVENTS_ROOT_FOLDER_ID, folderName, { token });

    const event = await createEvent(sid, { name, date, folderName, driveFolderId: folder.id }, actor(req));

    // Make the event visible to the gallery immediately (reconciler also does
    // this on schedule). Best-effort: a cache write failure must not fail the
    // create — the Sheet (SSOT) already has the row.
    try {
      await firestore()
        .collection('events')
        .doc(event.eventId)
        .set(
          {
            name: event.name,
            date: event.date,
            folderName: event.folderName,
            driveFolderId: event.driveFolderId,
            source: 'admin-create',
            lastSyncedAt: new Date().toISOString(),
          },
          { merge: true },
        );
    } catch (err) {
      logger.warn({ err, eventId: event.eventId }, 'events cache upsert failed (non-fatal)');
    }

    // Kick an initial index so Find Me/gallery populate once photos arrive.
    try {
      const { execution } = await triggerIndexJob(event.eventId);
      await firestore()
        .collection('events')
        .doc(event.eventId)
        .set({ indexState: { status: 'queued', updatedAt: new Date().toISOString() } }, { merge: true });
      logger.info({ eventId: event.eventId, execution }, 'event created + index queued');
    } catch (err) {
      logger.warn({ err, eventId: event.eventId }, 'initial index trigger failed (non-fatal)');
    }

    await recordAudit(sid, {
      actorEmail: actor(req),
      action: 'EVENT_CREATED',
      resourceType: 'event',
      resourceId: event.eventId,
      details: { folderName: event.folderName, driveFolderId: event.driveFolderId },
      ip: req.ip ?? '',
    });

    const body: CreateEventResponse = { ok: true, event };
    res.status(201).json(body);
  } catch (err) {
    if (handleStoreError(err, res)) return;
    next(err);
  }
});
