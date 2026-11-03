/**
 * adminUploadInsights.ts — GET /api/admin/upload-insights/:eventId: one row per
 * (club, tag, uploader) with sessions, files, size, upload time, index % and the
 * sessions that need attention (uploadInsightsService.ts). Read-only.
 *
 * Any admin; a club_admin (or a masquerading super_admin) sees only their own
 * club's uploaders. The master Sheet is optional here: without it the page still
 * shows the Firestore-side numbers, minus copied sizes.
 */

import { Router } from 'express';

import { env } from '../lib/config.js';
import { requireAuth } from '../middleware/auth.js';
import { attachRole, requireAnyAdmin } from '../middleware/rbac.js';
import { loadUploadInsights } from '../services/uploadInsightsService.js';
import { effectiveClubScope } from './adminShared.js';

export const adminUploadInsightsRouter = Router();

adminUploadInsightsRouter.get(
  '/admin/upload-insights/:eventId',
  requireAuth,
  attachRole,
  requireAnyAdmin,
  async (req, res, next) => {
    try {
      const eventId = String(req.params.eventId ?? '').trim();
      if (!eventId) {
        res.status(400).json({ ok: false, error: 'bad_request', message: 'eventId is required' });
        return;
      }
      const body = await loadUploadInsights(eventId, {
        spreadsheetId: env.MASTER_SPREADSHEET_ID || null,
        clubScope: effectiveClubScope(req),
      });
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);
