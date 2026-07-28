/**
 * adminUploadRecovery.ts — re-drive volunteer photos stuck in the staging bucket.
 *
 *   GET  /api/admin/upload-recovery/:eventId  — read-only report of what is owed
 *   POST /api/admin/upload-recovery/:eventId  — dry run, or dispatch the copies
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

import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { allowCronOrAdmin } from '../middleware/cronAuth.js';
import { attachRole, requireAnyAdmin } from '../middleware/rbac.js';
import { recordAudit } from '../services/auditStore.js';
import { dispatchStagedRecovery, scanStagedRecovery } from '../services/uploadRecoveryService.js';
import { actor, handleStoreError, masterSheetId } from './adminShared.js';

export const adminUploadRecoveryRouter = Router();

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
