/**
 * adminDuplicates.ts — the duplicate-file removal tool.
 *
 *   GET  /api/admin/duplicates/:eventId         — scan live Drive, report groups
 *   POST /api/admin/duplicates/:eventId/remove  — trash the redundant copies
 *
 * The POST is a DRY RUN unless the body says `apply: true` (the resync-names
 * convention), and it removes at most `limit` files per call, reporting
 * `remaining` — so a big event is drained by repeated calls instead of blowing
 * the 60s Firebase Hosting ceiling. Removal is a soft delete: Drive trash +
 * a Deleted_Files row + an audit entry, all restorable (see
 * routes/adminDeletedFiles.ts).
 *
 * Auth mirrors /admin/folders/resync-names: `allowCronOrAdmin`, so the pass is
 * runnable from a shell with the machine token (infra/scripts/remove-duplicate-
 * files.sh) as well as from the admin UI. A club_admin is confined to their own
 * club's subtree; a machine caller has no club and runs unscoped.
 */

import { Router } from 'express';
import type { Request } from 'express';
import {
  RemoveDuplicatesRequestSchema,
  type DuplicateScanResponse,
  type RemoveDuplicatesResponse,
} from '@cloud-webapp/shared';

import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { allowCronOrAdmin, validCronToken } from '../middleware/cronAuth.js';
import { attachRole, requireAnyAdmin } from '../middleware/rbac.js';
import { recordAudit } from '../services/auditStore.js';
import { previewEventDuplicates, scanEventDuplicates } from '../services/duplicateFilesService.js';
import {
  drainDuplicateRemovalQueue,
  enqueueDuplicateRemoval,
  getDuplicateBatch,
  latestDuplicateBatch,
} from '../services/duplicateRemovalQueue.js';
import { actor, effectiveClubScope, handleStoreError, masterSheetId } from './adminShared.js';

export const adminDuplicatesRouter = Router();

/**
 * Club scope for this request. A machine caller (valid X-Sync-Token, no Firebase
 * user) has no role, and `effectiveClubScope` would pin it to the '__none__'
 * sentinel — which matches no club and would silently find nothing. Machine
 * callers are trusted with the whole event, like the other cron-gated routes.
 */
function scopeFor(req: Request): string | undefined {
  if (!req.user && validCronToken(req.header('x-sync-token'))) return undefined;
  return effectiveClubScope(req);
}

/** GET /api/admin/duplicates/:eventId — read-only scan of live Drive state. */
adminDuplicatesRouter.get(
  '/admin/duplicates/:eventId',
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
      const scan = await scanEventDuplicates(eventId, { clubScope: scopeFor(req) });
      if (!scan.ok || !scan.data) {
        res.status(404).json({ ok: false, error: 'not_found', message: scan.message });
        return;
      }
      const body: DuplicateScanResponse = { ok: true, ...scan.data };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/admin/duplicates/:eventId/remove — Body: { apply?, limit?, hashes? }.
 *
 * DRY RUN (no `apply`) answers synchronously: it is a read-only scan.
 *
 * APPLY enqueues a batch and returns **202** with a `batchId` — it does NOT trash
 * anything inline. Removing an event's duplicates is minutes of rate-paced Drive
 * work (see duplicateRemovalQueue.ts), so every inline attempt died at the 60s
 * request ceiling with a 502/504 while the work carried on unseen. The caller
 * drives `/drain` and polls `/status`.
 */
adminDuplicatesRouter.post('/admin/duplicates/:eventId/remove', allowCronOrAdmin, async (req, res, next) => {
  try {
    const eventId = String(req.params.eventId ?? '').trim();
    if (!eventId) {
      res.status(400).json({ ok: false, error: 'invalid', message: 'eventId is required' });
      return;
    }
    const input = RemoveDuplicatesRequestSchema.parse(req.body ?? {});
    const apply = input.apply === true;

    if (!apply) {
      const out = await previewEventDuplicates(eventId, {
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        hashes: input.hashes,
        clubScope: scopeFor(req),
      });
      if (!out.ok || !out.data) {
        res.status(404).json({ ok: false, error: 'not_found', message: out.message });
        return;
      }
      const body: RemoveDuplicatesResponse = {
        ok: true,
        message: out.message,
        ...out.data,
        reindexRecommended: false,
      };
      res.json(body);
      return;
    }

    // The ledger + audit row live in the master Sheet, so an apply with no Sheet
    // configured would trash files with no record of it. Refuse up front.
    const sid = masterSheetId(res);
    if (!sid) return;

    const out = await enqueueDuplicateRemoval(eventId, {
      createdBy: actor(req),
      hashes: input.hashes,
      clubScope: scopeFor(req),
    });
    if (!out.ok) {
      res.status(404).json({ ok: false, error: 'not_found', message: out.message });
      return;
    }
    // Nothing to do — answer like a finished run so callers need no special case.
    if (!out.data) {
      res.json({ ok: true, mode: 'none', message: out.message, batchId: null, total: 0, notEnqueued: 0 });
      return;
    }

    await recordAudit(sid, {
      actorEmail: actor(req),
      action: 'DUPLICATES_REMOVAL_QUEUED',
      resourceType: 'event',
      resourceId: eventId,
      details: { batchId: out.data.id, total: out.data.total, notEnqueued: out.data.notEnqueued },
      reason: 'byte-identical duplicate removal',
      ip: req.ip ?? '',
    });

    logger.info(
      { eventId, batchId: out.data.id, total: out.data.total, by: actor(req) },
      'enqueued duplicate removal batch',
    );
    res.status(202).json({
      ok: true,
      mode: 'async',
      message: out.message,
      batchId: out.data.id,
      total: out.data.total,
      notEnqueued: out.data.notEnqueued,
    });
  } catch (err) {
    if (handleStoreError(err, res)) return;
    next(err);
  }
});

/**
 * POST /api/admin/duplicates/drain — do one bounded slice of queued removal work.
 * The browser drives this while an admin watches (each call returns well inside
 * 60s); Cloud Scheduler (`findme-duplicates-drain`) is the backstop that finishes
 * a batch if they close the page. Cheap no-op when nothing is queued.
 */
adminDuplicatesRouter.post('/admin/duplicates/drain', allowCronOrAdmin, async (req, res, next) => {
  try {
    const summary = await drainDuplicateRemovalQueue();
    res.json({ ok: true, ...summary });
  } catch (err) {
    if (handleStoreError(err, res)) return;
    next(err);
  }
});

/**
 * GET /api/admin/duplicates/batch/status — progress for the UI to poll.
 * `?batchId=` for a specific batch, else the newest (optionally `?eventId=`).
 */
adminDuplicatesRouter.get(
  '/admin/duplicates/batch/status',
  requireAuth,
  attachRole,
  requireAnyAdmin,
  async (req, res, next) => {
    try {
      const batchId = typeof req.query.batchId === 'string' ? req.query.batchId : '';
      const eventId = typeof req.query.eventId === 'string' ? req.query.eventId : '';
      const batch = batchId ? await getDuplicateBatch(batchId) : await latestDuplicateBatch(eventId || undefined);
      // The inline work list is large and of no use to the UI — send progress only.
      res.json({
        ok: true,
        batch: batch
          ? {
              id: batch.id,
              eventId: batch.eventId,
              eventName: batch.eventName,
              status: batch.status,
              total: batch.total,
              removed: batch.removed ?? 0,
              failed: batch.failed ?? 0,
              remaining: (batch.pending ?? []).length,
              sweepPending: (batch.pendingSweep ?? []).length,
              bytesReclaimed: batch.bytesReclaimed ?? 0,
              shortcutsRemoved: batch.shortcutsRemoved ?? 0,
              notEnqueued: batch.notEnqueued ?? 0,
              warnings: batch.warnings ?? [],
              createdAt: batch.createdAt,
              updatedAt: batch.updatedAt,
              ...(batch.finishedAt ? { finishedAt: batch.finishedAt } : {}),
            }
          : null,
      });
    } catch (err) {
      next(err);
    }
  },
);
