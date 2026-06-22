/**
 * audit.ts — control-plane audit-log search (dev plan G4.2). Reads the
 * Audit_Log tab (SSOT) via auditStore. Super-admin only: the audit trail spans
 * all clubs and is a compliance artifact, so it isn't club-scoped.
 *
 * CSV export is done client-side (web/pages/AdminAudit) from this JSON, so there
 * is one content type and the same RBAC/filter path for both views.
 */

import { Router } from 'express';
import type { AuditResourceType, ListAuditResponse } from '@cloud-webapp/shared';

import { requireAuth } from '../middleware/auth.js';
import { attachRole, requireSuperAdmin } from '../middleware/rbac.js';
import { listAudit } from '../services/auditStore.js';
import { masterSheetId } from './adminShared.js';

export const auditRouter = Router();

const RESOURCE_TYPES = new Set(['user', 'club', 'event', 'link', 'report', 'other']);

/** GET /api/admin/audit?since&until&actor&action&type&limit */
auditRouter.get('/admin/audit', requireAuth, attachRole, requireSuperAdmin, async (req, res, next) => {
  try {
    const sid = masterSheetId(res);
    if (!sid) return;

    const q = req.query;
    const typeRaw = typeof q.type === 'string' ? q.type : '';
    const filter: Parameters<typeof listAudit>[1] = {};
    if (typeof q.since === 'string' && q.since) filter.since = q.since;
    if (typeof q.until === 'string' && q.until) filter.until = q.until;
    if (typeof q.actor === 'string' && q.actor) filter.actorEmail = q.actor;
    if (typeof q.action === 'string' && q.action) filter.action = q.action;
    if (RESOURCE_TYPES.has(typeRaw)) filter.resourceType = typeRaw as AuditResourceType;
    const limit = Number(q.limit);
    filter.limit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 2000) : 500;

    const records = await listAudit(sid, filter);
    const body: ListAuditResponse = { ok: true, records, total: records.length };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
