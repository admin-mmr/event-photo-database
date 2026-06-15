/**
 * sync.ts — POST /api/admin/sync, the "Sync with Drive" reconciler trigger
 * (dev plan §8). Reads the master Sheet and upserts events + tags into
 * Firestore (see services/reconcileService.ts).
 *
 * Two ways to authorize a sync:
 *   1. A Firebase **admin** (the web app's "Sync with Drive" button) — the
 *      normal requireAuth + requireAdmin path.
 *   2. A machine caller (Cloud Scheduler) presenting the shared secret in the
 *      `X-Sync-Token` header, matched against SYNC_TRIGGER_TOKEN. This avoids
 *      minting a Firebase token from a cron job. Disabled when the env var is
 *      empty.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { SyncResponse } from '@cloud-webapp/shared';

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { reconcile } from '../services/reconcileService.js';

export const syncRouter = Router();

/** Constant-time compare of the provided token against SYNC_TRIGGER_TOKEN.
 *  Hashing both sides first keeps the comparison length-independent. */
function validCronToken(provided: string | undefined): boolean {
  const secret = env.SYNC_TRIGGER_TOKEN;
  if (!secret || !provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

/** Allow the request if it carries a valid cron token; otherwise fall back to
 *  the Firebase admin path (requireAuth → requireAdmin). */
function allowCronOrAdmin(req: Request, res: Response, next: NextFunction): void {
  if (validCronToken(req.header('x-sync-token'))) {
    next();
    return;
  }
  requireAuth(req, res, () => requireAdmin(req, res, next));
}

syncRouter.post('/admin/sync', allowCronOrAdmin, async (req, res, next) => {
  try {
    if (!env.MASTER_SPREADSHEET_ID) {
      res.status(503).json({
        ok: false,
        error: 'not_configured',
        message: 'MASTER_SPREADSHEET_ID is not set — configure it before syncing',
      });
      return;
    }

    const result = await reconcile(env.MASTER_SPREADSHEET_ID);

    logger.info(
      {
        admin: req.user?.email ?? 'cron',
        scanned: result.scanned,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        tagsLinked: result.tagsLinked,
        orphans: result.orphans.length,
        durationMs: result.durationMs,
      },
      'drive sync complete',
    );

    const body: SyncResponse = { ok: true, ...result };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
