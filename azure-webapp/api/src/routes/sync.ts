/**
 * sync.ts — POST /api/admin/sync, the "Sync with Drive" reconciler trigger
 * (dev plan §8). Reads the master Sheet and upserts events + tags into
 * Firestore (see services/reconcileService.ts).
 *
 * Authorized by `allowCronOrAdmin` (middleware/cronAuth.ts): a Firebase admin
 * (the web app's "Sync with Drive" button) OR a machine caller presenting the
 * shared `X-Sync-Token` secret (Cloud Scheduler).
 */

import { Router } from 'express';
import type { SyncResponse } from '@cloud-webapp/shared';

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { allowCronOrAdmin } from '../middleware/cronAuth.js';
import { reconcile } from '../services/reconcileService.js';

export const syncRouter = Router();

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
