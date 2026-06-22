/**
 * adminUsers.ts — control-plane Users admin API (dev plan G2.1). Writes go to
 * the Users tab (SSOT) through userStore; every state change is audited.
 *
 * RBAC (rbac.ts): user *management* (create/update/activate) is super_admin only
 * — a club_admin manages content within their club (events/links, G3), not the
 * admin roster. Listing is open to any admin but scoped: a club_admin (or a
 * super_admin masquerading via X-Masquerade-Club) sees only their club's users.
 */

import { Router } from 'express';
import {
  CreateUserRequestSchema,
  UpdateUserRequestSchema,
  type ListUsersResponse,
  type UserResponse,
} from '@cloud-webapp/shared';

import { UserStatus } from '../lib/roles.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { attachRole, requireAnyAdmin, requireSuperAdmin } from '../middleware/rbac.js';
import { recordAudit } from '../services/auditStore.js';
import { optedInAmong } from '../services/emailPrefsStore.js';
import { sendEmail, sendToMany } from '../services/emailService.js';
import { userCreated, welcomeUser } from '../services/emailTemplates.js';
import { createUser, listUsers, setUserStatus, updateUser } from '../services/userStore.js';
import { actor, effectiveClubScope, handleStoreError, masterSheetId } from './adminShared.js';

/**
 * Best-effort email fan-out for a newly created user: a welcome to the user, and
 * a "new user added" notice to opted-in admins (default ON). Never throws — a
 * mail failure must not fail the create (sendEmail itself no-ops when disabled).
 */
async function notifyUserCreated(
  sid: string,
  newUser: { email: string; firstName: string; lastName: string; role: string },
  actorEmail: string,
): Promise<void> {
  try {
    await sendEmail(newUser.email, welcomeUser(`${newUser.firstName} ${newUser.lastName}`, newUser.role));
    const admins = (await listUsers(sid, { status: UserStatus.ACTIVE }))
      .filter((u) => u.role !== 'api_client' && u.email !== newUser.email)
      .map((u) => u.email);
    const recipients = await optedInAmong(sid, 'userCreated', admins);
    await sendToMany(recipients, userCreated(actorEmail, newUser.email, newUser.role));
  } catch (err) {
    logger.warn({ err, email: newUser.email }, 'user-created notification failed (non-fatal)');
  }
}

export const adminUsersRouter = Router();

/** GET /api/admin/users — list (scoped by club for club_admins / masquerade). */
adminUsersRouter.get('/admin/users', requireAuth, attachRole, requireAnyAdmin, async (req, res, next) => {
  try {
    const sid = masterSheetId(res);
    if (!sid) return;
    const clubId = effectiveClubScope(req);
    const users = await listUsers(sid, clubId === undefined ? undefined : { clubId });
    const body: ListUsersResponse = { ok: true, users };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/users — create a user (super_admin only). */
adminUsersRouter.post('/admin/users', requireAuth, attachRole, requireSuperAdmin, async (req, res, next) => {
  try {
    const sid = masterSheetId(res);
    if (!sid) return;
    const input = CreateUserRequestSchema.parse(req.body ?? {});
    const user = await createUser(sid, input, actor(req));
    await recordAudit(sid, {
      actorEmail: actor(req),
      action: 'USER_CREATED',
      resourceType: 'user',
      resourceId: user.email,
      details: { role: user.role, clubId: user.clubId },
      ip: req.ip ?? '',
    });
    await notifyUserCreated(sid, user, actor(req));
    const body: UserResponse = { ok: true, user };
    res.status(201).json(body);
  } catch (err) {
    if (handleStoreError(err, res)) return;
    next(err);
  }
});

/** PATCH /api/admin/users/:email — update name/role/club (super_admin only). */
adminUsersRouter.patch('/admin/users/:email', requireAuth, attachRole, requireSuperAdmin, async (req, res, next) => {
  try {
    const sid = masterSheetId(res);
    if (!sid) return;
    const email = String(req.params.email);
    const patch = UpdateUserRequestSchema.parse(req.body ?? {});
    const user = await updateUser(sid, email, patch);
    await recordAudit(sid, {
      actorEmail: actor(req),
      action: 'USER_UPDATED',
      resourceType: 'user',
      resourceId: user.email,
      details: patch,
      ip: req.ip ?? '',
    });
    const body: UserResponse = { ok: true, user };
    res.json(body);
  } catch (err) {
    if (handleStoreError(err, res)) return;
    next(err);
  }
});

/** POST /api/admin/users/:email/deactivate|reactivate (super_admin only). */
for (const action of ['deactivate', 'reactivate'] as const) {
  adminUsersRouter.post(
    `/admin/users/:email/${action}`,
    requireAuth,
    attachRole,
    requireSuperAdmin,
    async (req, res, next) => {
      try {
        const sid = masterSheetId(res);
        if (!sid) return;
        const email = String(req.params.email);
        const status = action === 'deactivate' ? UserStatus.INACTIVE : UserStatus.ACTIVE;
        const user = await setUserStatus(sid, email, status);
        await recordAudit(sid, {
          actorEmail: actor(req),
          action: action === 'deactivate' ? 'USER_DEACTIVATED' : 'USER_REACTIVATED',
          resourceType: 'user',
          resourceId: user.email,
          ip: req.ip ?? '',
        });
        const body: UserResponse = { ok: true, user };
        res.json(body);
      } catch (err) {
        if (handleStoreError(err, res)) return;
        next(err);
      }
    },
  );
}
