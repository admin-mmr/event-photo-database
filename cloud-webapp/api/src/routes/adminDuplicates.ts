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

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { allowCronOrAdmin, validCronToken } from '../middleware/cronAuth.js';
import { attachRole, requireAnyAdmin } from '../middleware/rbac.js';
import { recordAudit } from '../services/auditStore.js';
import { removeEventDuplicates, scanEventDuplicates } from '../services/duplicateFilesService.js';
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
 * POST /api/admin/duplicates/:eventId/remove — trash duplicates (dry run by
 * default). Body: { apply?, limit?, hashes? }.
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
    // The ledger + audit row live in the master Sheet, so an apply with no Sheet
    // configured would trash files with no record of it. Refuse up front — but
    // let a dry run through, since it writes nothing.
    const sid = apply ? masterSheetId(res) : env.MASTER_SPREADSHEET_ID;
    if (apply && !sid) return;

    const out = await removeEventDuplicates(eventId, {
      apply,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      hashes: input.hashes,
      clubScope: scopeFor(req),
      actorEmail: actor(req),
    });
    if (!out.ok || !out.data) {
      res.status(404).json({ ok: false, error: 'not_found', message: out.message });
      return;
    }

    if (apply && sid && out.data.removed > 0) {
      await recordAudit(sid, {
        actorEmail: actor(req),
        action: 'DUPLICATES_REMOVED',
        resourceType: 'event',
        resourceId: eventId,
        details: {
          removed: out.data.removed,
          failed: out.data.failed,
          remaining: out.data.remaining,
          bytesReclaimed: out.data.bytesReclaimed,
        },
        reason: 'byte-identical duplicate removal',
        ip: req.ip ?? '',
      });
    }

    logger.info({ eventId, apply, removed: out.data.removed, by: actor(req) }, 'duplicate removal run');
    const body: RemoveDuplicatesResponse = {
      ok: true,
      message: out.message,
      ...out.data,
      reindexRecommended: out.data.removed > 0,
    };
    res.json(body);
  } catch (err) {
    if (handleStoreError(err, res)) return;
    next(err);
  }
});
