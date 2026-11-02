/**
 * adminUploadRecovery.ts — re-drive volunteer photos stuck in the staging bucket.
 *
 *   GET  /api/admin/upload-recovery/:eventId  — read-only report of what is owed
 *   POST /api/admin/upload-recovery/:eventId  — dry run, or dispatch the copies
 *   POST /api/admin/upload-recovery/sweep     — every event: file the sessions
 *                                               that never reached /complete
 *                                               (the `findme-upload-sweep`
 *                                               scheduler's target)
 *
 * The POST is a DRY RUN unless the body says `apply: true` (the resync-names /
 * duplicate-removal convention). Applying only LISTS staging and creates Cloud
 * Tasks work items — the actual Drive copying happens in the existing upload
 * worker — so the request itself stays far inside the 60s browser ceiling no
 * matter how many thousands of photos are recovered.
 *
 * Auth mirrors the other recovery tools: `allowCronOrAdmin`, so it is runnable
 * from a shell with the machine token (infra/scripts/recover-staged-uploads.sh)
 * as well as by an admin. Unlike the duplicates tool there is no club scoping:
 * recovery is a super-admin-grade repair of the event's own staging area, and a
 * partial recovery would be worse than none.
 */

import { Router } from 'express';

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { allowCronOrAdmin } from '../middleware/cronAuth.js';
import { attachRole, requireAnyAdmin } from '../middleware/rbac.js';
import { recordAudit } from '../services/auditStore.js';
import { dispatchStagedRecovery, scanStagedRecovery } from '../services/uploadRecoveryService.js';
import { sweepNeverCompletedUploads } from '../services/uploadSweepService.js';
import { actor, handleStoreError, masterSheetId } from './adminShared.js';

export const adminUploadRecoveryRouter = Router();

/**
 * POST /api/admin/upload-recovery/sweep — Body: { apply?, minAgeMinutes? }.
 *
 * Registered BEFORE the `:eventId` routes so `sweep` is never read as an event.
 * Dry run unless `apply: true`; the scheduler sends `apply: true`. A tick with
 * nothing owed is one staging listing and returns 200 — the zero-idle-cost
 * policy. Details in services/uploadSweepService.ts.
 */
adminUploadRecoveryRouter.post('/admin/upload-recovery/sweep', allowCronOrAdmin, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { apply?: unknown; minAgeMinutes?: unknown };
    const apply = body.apply === true;
    const minAgeMs =
      typeof body.minAgeMinutes === 'number' && body.minAgeMinutes > 0 ? body.minAgeMinutes * 60_000 : undefined;

    const out = await sweepNeverCompletedUploads({ apply, ...(minAgeMs === undefined ? {} : { minAgeMs }) });

    // Audited only when it acted. Not gated up front like the per-event POST: an
    // idle tick must not 503 for want of a Sheet, and the copies are already
    // queued (and marked) by the time this runs, so a failed audit row is
    // logged rather than turned into a 500 the scheduler would retry.
    if (apply && out.objects > 0 && env.MASTER_SPREADSHEET_ID) {
      await recordAudit(env.MASTER_SPREADSHEET_ID, {
        actorEmail: actor(req),
        action: 'UPLOAD_SWEEP_DISPATCHED',
        resourceType: 'event',
        resourceId: [...new Set(out.candidates.map((c) => c.eventId))].join(','),
        details: { objects: out.objects, tasks: out.tasks, batches: out.candidates.map((c) => c.batchId) },
        reason: 'file volunteer uploads that never reached /complete',
        ip: req.ip ?? '',
      }).catch((err: unknown) => logger.error({ err }, 'upload sweep audit row failed'));
    }

    res.status(apply && out.objects > 0 ? 202 : 200).json({ ok: true, ...out });
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/upload-recovery/:eventId — read-only, changes nothing. */
adminUploadRecoveryRouter.get(
  '/admin/upload-recovery/:eventId',
  requireAuth,
  attachRole,
  requireAnyAdmin,
  async (req, res, next) => {
    try {
      const eventId = String(req.params.eventId ?? '').trim();
      if (!eventId) {
        res.status(400).json({ ok: false, error: 'invalid', message: 'eventId is required' });
        return;
      }
      const scan = await scanStagedRecovery(eventId);
      res.json({ ok: true, ...scan });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/admin/upload-recovery/:eventId — Body: { apply?, chunkSize?, batchIds? }.
 * Dry run by default; `apply: true` dispatches the copies to the upload worker.
 */
adminUploadRecoveryRouter.post('/admin/upload-recovery/:eventId', allowCronOrAdmin, async (req, res, next) => {
  try {
    const eventId = String(req.params.eventId ?? '').trim();
    if (!eventId) {
      res.status(400).json({ ok: false, error: 'invalid', message: 'eventId is required' });
      return;
    }
    const body = (req.body ?? {}) as { apply?: unknown; chunkSize?: unknown; batchIds?: unknown };
    const apply = body.apply === true;
    const chunkSize = typeof body.chunkSize === 'number' ? body.chunkSize : undefined;
    const batchIds = Array.isArray(body.batchIds) ? body.batchIds.map(String) : undefined;

    // Recovery writes an audit row, which lives in the master Sheet.
    const sid = apply ? masterSheetId(res) : '';
    if (apply && !sid) return;

    const out = await dispatchStagedRecovery(eventId, {
      apply,
      ...(chunkSize === undefined ? {} : { chunkSize }),
      batchIds,
    });

    if (apply && sid && out.objects > 0) {
      await recordAudit(sid, {
        actorEmail: actor(req),
        action: 'UPLOAD_RECOVERY_DISPATCHED',
        resourceType: 'event',
        resourceId: eventId,
        details: { objects: out.objects, tasks: out.tasks, batches: out.batches },
        reason: 'recover staged uploads never copied to Drive',
        ip: req.ip ?? '',
      });
    }

    logger.info({ eventId, apply, objects: out.objects, tasks: out.tasks, by: actor(req) }, 'upload recovery run');
    res.status(apply ? 202 : 200).json({ ok: true, ...out });
  } catch (err) {
    if (handleStoreError(err, res)) return;
    next(err);
  }
});
