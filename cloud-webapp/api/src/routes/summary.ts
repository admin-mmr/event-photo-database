/**
 * summary.ts — upload reporting (dev plan G5.2). GET /api/admin/summary returns
 * session/file/size totals for a date range, broken down by club. Club-scoped: a
 * club_admin (or masquerading super_admin) only sees their own club's numbers.
 */

import { Router } from 'express';
import type { SummaryResponse } from '@cloud-webapp/shared';

import { requireAuth } from '../middleware/auth.js';
import { attachRole, requireAnyAdmin } from '../middleware/rbac.js';
import { summarize } from '../services/summaryService.js';
import { effectiveClubScope, masterSheetId } from './adminShared.js';

export const summaryRouter = Router();

summaryRouter.get('/admin/summary', requireAuth, attachRole, requireAnyAdmin, async (req, res, next) => {
  try {
    const sid = masterSheetId(res);
    if (!sid) return;
    const scope = effectiveClubScope(req);
    const filter: Parameters<typeof summarize>[1] = {};
    if (typeof req.query.since === 'string' && req.query.since) filter.since = req.query.since;
    if (typeof req.query.until === 'string' && req.query.until) filter.until = req.query.until;
    if (scope !== undefined) filter.clubName = scope;
    else if (typeof req.query.clubName === 'string' && req.query.clubName) filter.clubName = req.query.clubName;

    const { totals, byClub } = await summarize(sid, filter);
    const body: SummaryResponse = {
      ok: true,
      since: filter.since ?? '',
      until: filter.until ?? '',
      totals,
      byClub,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
