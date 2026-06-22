/**
 * adminClubs.ts — control-plane Clubs admin API (dev plan G2.1). Writes go to
 * the Clubs tab (SSOT) through clubStore; every state change is audited.
 *
 * RBAC: listing is open to any admin (events/links pickers need the club list);
 * create/update/activate is super_admin only (clubs are an org-level resource —
 * gas-app reserves club management to super admins).
 */

import { Router } from 'express';
import {
  CreateClubRequestSchema,
  UpdateClubRequestSchema,
  type ClubResponse,
  type ListClubsResponse,
} from '@cloud-webapp/shared';

import { UserStatus } from '../lib/roles.js';
import { requireAuth } from '../middleware/auth.js';
import { attachRole, requireAnyAdmin, requireSuperAdmin } from '../middleware/rbac.js';
import { recordAudit } from '../services/auditStore.js';
import { createClub, listClubs, setClubStatus, updateClub } from '../services/clubStore.js';
import { actor, handleStoreError, masterSheetId } from './adminShared.js';

export const adminClubsRouter = Router();

/** GET /api/admin/clubs — list all clubs (any admin). */
adminClubsRouter.get('/admin/clubs', requireAuth, attachRole, requireAnyAdmin, async (_req, res, next) => {
  try {
    const sid = masterSheetId(res);
    if (!sid) return;
    const clubs = await listClubs(sid);
    const body: ListClubsResponse = { ok: true, clubs };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/clubs — create a club (super_admin only). */
adminClubsRouter.post('/admin/clubs', requireAuth, attachRole, requireSuperAdmin, async (req, res, next) => {
  try {
    const sid = masterSheetId(res);
    if (!sid) return;
    const input = CreateClubRequestSchema.parse(req.body ?? {});
    const club = await createClub(sid, input, actor(req));
    await recordAudit(sid, {
      actorEmail: actor(req),
      action: 'CLUB_CREATED',
      resourceType: 'club',
      resourceId: club.normalizedName,
      details: { displayName: club.displayName },
      ip: req.ip ?? '',
    });
    const body: ClubResponse = { ok: true, club };
    res.status(201).json(body);
  } catch (err) {
    if (handleStoreError(err, res)) return;
    next(err);
  }
});

/** PATCH /api/admin/clubs/:normalizedName — rename (super_admin only). */
adminClubsRouter.patch(
  '/admin/clubs/:normalizedName',
  requireAuth,
  attachRole,
  requireSuperAdmin,
  async (req, res, next) => {
    try {
      const sid = masterSheetId(res);
      if (!sid) return;
      const normalizedName = String(req.params.normalizedName);
      const patch = UpdateClubRequestSchema.parse(req.body ?? {});
      const club = await updateClub(sid, normalizedName, patch);
      await recordAudit(sid, {
        actorEmail: actor(req),
        action: 'CLUB_UPDATED',
        resourceType: 'club',
        resourceId: club.normalizedName,
        details: patch,
        ip: req.ip ?? '',
      });
      const body: ClubResponse = { ok: true, club };
      res.json(body);
    } catch (err) {
      if (handleStoreError(err, res)) return;
      next(err);
    }
  },
);

/** POST /api/admin/clubs/:normalizedName/deactivate|reactivate (super_admin only). */
for (const action of ['deactivate', 'reactivate'] as const) {
  adminClubsRouter.post(
    `/admin/clubs/:normalizedName/${action}`,
    requireAuth,
    attachRole,
    requireSuperAdmin,
    async (req, res, next) => {
      try {
        const sid = masterSheetId(res);
        if (!sid) return;
        const normalizedName = String(req.params.normalizedName);
        const status = action === 'deactivate' ? UserStatus.INACTIVE : UserStatus.ACTIVE;
        const club = await setClubStatus(sid, normalizedName, status);
        await recordAudit(sid, {
          actorEmail: actor(req),
          action: action === 'deactivate' ? 'CLUB_DEACTIVATED' : 'CLUB_REACTIVATED',
          resourceType: 'club',
          resourceId: club.normalizedName,
          ip: req.ip ?? '',
        });
        const body: ClubResponse = { ok: true, club };
        res.json(body);
      } catch (err) {
        if (handleStoreError(err, res)) return;
        next(err);
      }
    },
  );
}
