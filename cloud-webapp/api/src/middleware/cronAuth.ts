/**
 * cronAuth.ts — shared "machine caller OR Firebase admin" gate.
 *
 * Cloud Scheduler and the gas-app upload flow can't mint a Firebase ID token,
 * so machine callers present the shared secret in the `X-Sync-Token` header
 * (matched against SYNC_TRIGGER_TOKEN). Humans fall through to the dynamic RBAC
 * path (requireAuth → attachRole → requireAnyAdmin): any active super_admin or
 * club_admin in the Users sheet — plus the ADMIN_EMAILS bootstrap allowlist,
 * which attachRole treats as super_admin — is allowed, with no redeploy needed
 * to add or remove an admin. Disabled (header path) when the env var is empty,
 * so no token == admin-only.
 *
 * Extracted from routes/sync.ts so the same gate protects the automated
 * indexing triggers (POST /api/events/:id/index, POST /api/admin/index-scan)
 * without duplicating the constant-time compare.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

import { env } from '../lib/config.js';
import { requireAuth } from './auth.js';
import { attachRole, requireAnyAdmin } from './rbac.js';

/** Constant-time compare of the provided token against SYNC_TRIGGER_TOKEN.
 *  Hashing both sides first keeps the comparison length-independent. */
export function validCronToken(provided: string | undefined): boolean {
  const secret = env.SYNC_TRIGGER_TOKEN;
  if (!secret || !provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

/** Allow the request if it carries a valid cron token; otherwise fall back to
 *  the dynamic RBAC admin path (requireAuth → attachRole → requireAnyAdmin), so
 *  any active super_admin or club_admin can run it. attachRole resolves the role
 *  from the Users sheet (or the bootstrap allowlist) and never rejects on its
 *  own; requireAnyAdmin does the gating (and still requires a verified email). */
export function allowCronOrAdmin(req: Request, res: Response, next: NextFunction): void {
  if (validCronToken(req.header('x-sync-token'))) {
    next();
    return;
  }
  requireAuth(req, res, () => {
    void attachRole(req, res, () => requireAnyAdmin(req, res, next));
  });
}
