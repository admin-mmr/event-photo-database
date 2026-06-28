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
import type { Response } from 'express';

import { firestore } from '../lib/firestore.js';
import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { attachRole, requireAnyAdmin } from '../middleware/rbac.js';
import {
  rebuildEventPhotoFolders,
  rebuildAllSpecialFoldersForEvent,
  migrateEventPhotoShortcutsToFiles,
  backfillSpecialFoldersSharing,
} from '../services/specialFoldersService.js';
import { rebuildPublicFolderIndex } from '../services/publicFolderIndexService.js';
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

/** Resolve the target event ids: a single `eventId` from the body, or all. */
async function targetEventIds(body: unknown): Promise<string[]> {
  const eventId = typeof (body as { eventId?: unknown })?.eventId === 'string' ? (body as { eventId: string }).eventId.trim() : '';
  return eventId ? [eventId] : allEventIds();
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
    const ids = await targetEventIds(req.body);
    let ok = 0;
    for (const eventId of ids) {
      const r = await rebuildEventPhotoFolders(eventId);
      if (r.ok) ok++;
    }
    await rebuildPublicFolderIndex();
    logger.info({ events: ids.length, ok, by: actor(req) }, 'manual rebuild-photos');
    res.json({ ok: true, events: ids.length, succeeded: ok });
  } catch (err) {
    next(err);
  }
});

adminManagedFoldersRouter.post('/admin/folders/rebuild-videos-albums', ...guard, async (req, res, next) => {
  try {
    if (!masterSheetId(res) || notEnabled(res)) return;
    const ids = await targetEventIds(req.body);
    for (const eventId of ids) await rebuildAllSpecialFoldersForEvent(eventId);
    await rebuildPublicFolderIndex();
    logger.info({ events: ids.length, by: actor(req) }, 'manual rebuild-videos-albums');
    res.json({ ok: true, events: ids.length });
  } catch (err) {
    next(err);
  }
});

adminManagedFoldersRouter.post('/admin/folders/migrate-photo-shortcuts', ...guard, async (req, res, next) => {
  try {
    if (!masterSheetId(res) || notEnabled(res)) return;
    const ids = await targetEventIds(req.body);
    const results = [];
    for (const eventId of ids) {
      const r = await migrateEventPhotoShortcutsToFiles(eventId);
      results.push({ eventId, ok: r.ok, message: r.message });
    }
    logger.info({ events: ids.length, by: actor(req) }, 'manual migrate-photo-shortcuts');
    res.json({ ok: true, results });
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
