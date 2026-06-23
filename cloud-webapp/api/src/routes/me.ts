/**
 * me.ts — GET /api/me, the signed-in caller's identity + control-plane role.
 *
 * The web app has only the Firebase user (email / anonymous) and can't know a
 * user's role, which lives in the Users sheet. This endpoint resolves it
 * (requireAuth → attachRole) so the client can render role-aware navigation.
 *
 * This is UI convenience ONLY — every privileged route still enforces its own
 * requireRole / requireAdmin guard, so a forged response here grants nothing.
 * Anonymous guests get role: null (attachRole no-ops without an email).
 */

import { Router } from 'express';
import type { MeResponse } from '@cloud-webapp/shared';

import { requireAuth } from '../middleware/auth.js';
import { attachRole } from '../middleware/rbac.js';

export const meRouter = Router();

meRouter.get('/me', requireAuth, attachRole, (req, res) => {
  const body: MeResponse = {
    ok: true,
    email: req.user?.email ?? null,
    emailVerified: Boolean(req.user?.emailVerified),
    role: req.user?.role ?? null,
    clubId: req.user?.clubId ?? '',
  };
  res.json(body);
});
