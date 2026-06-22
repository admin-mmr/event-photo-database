/**
 * adminMasquerade.ts — super-admin "act as a club_admin" for support (dev plan
 * G2.3), ported from gas-app masquerade. Both transitions are audited
 * (MASQUERADE_START / MASQUERADE_END).
 *
 * Mechanism: we can't mint a Firebase token for another scope, so masquerade is
 * stateless — start validates the target club + records the audit, then the
 * client sends `X-Masquerade-Club: <clubId>` on subsequent admin calls.
 * effectiveClubScope() (adminShared) honors that header ONLY for super_admins,
 * so a club_admin can't widen their own scope with it.
 */

import { Router } from 'express';
import { MasqueradeStartRequestSchema, type MasqueradeResponse } from '@cloud-webapp/shared';

import { requireAuth } from '../middleware/auth.js';
import { attachRole, requireSuperAdmin } from '../middleware/rbac.js';
import { recordAudit } from '../services/auditStore.js';
import { getClub } from '../services/clubStore.js';
import { actor, handleStoreError, masterSheetId } from './adminShared.js';

export const adminMasqueradeRouter = Router();

/** POST /api/admin/masquerade/start — begin acting as a club_admin for a club. */
adminMasqueradeRouter.post(
  '/admin/masquerade/start',
  requireAuth,
  attachRole,
  requireSuperAdmin,
  async (req, res, next) => {
    try {
      const sid = masterSheetId(res);
      if (!sid) return;
      const { clubId } = MasqueradeStartRequestSchema.parse(req.body ?? {});
      const club = await getClub(sid, clubId);
      if (!club) {
        res.status(404).json({ ok: false, error: 'not_found', message: `Unknown club '${clubId}'` });
        return;
      }
      await recordAudit(sid, {
        actorEmail: actor(req),
        action: 'MASQUERADE_START',
        resourceType: 'club',
        resourceId: clubId,
        ip: req.ip ?? '',
      });
      const body: MasqueradeResponse = { ok: true, actingAsClub: clubId };
      res.json(body);
    } catch (err) {
      if (handleStoreError(err, res)) return;
      next(err);
    }
  },
);

/** POST /api/admin/masquerade/end — stop acting as a club_admin. */
adminMasqueradeRouter.post(
  '/admin/masquerade/end',
  requireAuth,
  attachRole,
  requireSuperAdmin,
  async (req, res, next) => {
    try {
      const sid = masterSheetId(res);
      if (!sid) return;
      await recordAudit(sid, {
        actorEmail: actor(req),
        action: 'MASQUERADE_END',
        resourceType: 'club',
        resourceId: req.header('X-Masquerade-Club') ?? '',
        ip: req.ip ?? '',
      });
      const body: MasqueradeResponse = { ok: true, actingAsClub: null };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);
