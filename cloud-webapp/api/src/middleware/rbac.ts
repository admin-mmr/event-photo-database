/**
 * rbac.ts — role-based access control for the control plane, ported from gas-app
 * roleGuard (dev plan G1.3). Runs AFTER requireAuth.
 *
 * Roles resolve from the Users sheet (SSOT, via userStore's TTL cache). A
 * bootstrap allowlist (env.ADMIN_EMAILS) is always treated as super_admin so the
 * org can never lock itself out before any Users rows exist — same allowlist the
 * legacy requireAdmin uses.
 *
 * Because the Sheet has no row-level security, this middleware is the ONLY guard
 * on Sheet writes — every control-plane write route must sit behind requireRole
 * and, where a club is involved, requireClubScope.
 */

import type { Request, Response, NextFunction } from 'express';

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { UserRole, UserStatus, type UserRole as Role } from '../lib/roles.js';
import { getUserByEmail } from '../services/userStore.js';

function bootstrapAdmins(): string[] {
  return env.ADMIN_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Resolve req.user.role / req.user.clubId from the Users sheet (best-effort).
 * Never rejects on its own — gating is done by requireRole / requireClubScope —
 * so routes that only need authentication can run this harmlessly.
 *
 * Resolution order: bootstrap allowlist → active Users row → none.
 */
export async function attachRole(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const email = req.user?.email?.toLowerCase();
  if (!email) {
    next();
    return;
  }
  if (bootstrapAdmins().includes(email)) {
    req.user!.role = UserRole.SUPER_ADMIN;
    req.user!.clubId = '';
    next();
    return;
  }
  if (env.MASTER_SPREADSHEET_ID) {
    try {
      const user = await getUserByEmail(env.MASTER_SPREADSHEET_ID, email);
      if (user && user.status === UserStatus.ACTIVE) {
        req.user!.role = user.role;
        req.user!.clubId = user.clubId;
      }
    } catch (err) {
      logger.warn({ err, email }, 'role resolution failed (treating as no role)');
    }
  }
  next();
}

/**
 * Require the caller to hold one of `roles` (and a verified email). Must run
 * after attachRole. 403s otherwise.
 */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.user?.role;
    if (!req.user?.emailVerified || !role || !roles.includes(role)) {
      res.status(403).json({ ok: false, error: 'forbidden', message: 'Insufficient role' });
      return;
    }
    next();
  };
}

/** Convenience: super_admin only. */
export const requireSuperAdmin = requireRole(UserRole.SUPER_ADMIN);
/** Convenience: any admin (super_admin or club_admin). */
export const requireAnyAdmin = requireRole(UserRole.SUPER_ADMIN, UserRole.CLUB_ADMIN);

/**
 * Enforce club scope on a route that targets a specific club's data. super_admin
 * passes for any club; a club_admin passes only for their own `clubId`. Must run
 * after attachRole (and typically requireAnyAdmin).
 *
 * `getClubId` extracts the target club (normalizedName) from the request — e.g.
 * `(req) => req.params.clubId` or `(req) => req.body.clubId`. A missing/empty
 * target is rejected (fail closed).
 */
export function requireClubScope(getClubId: (req: Request) => string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.user?.role;
    if (role === UserRole.SUPER_ADMIN) {
      next();
      return;
    }
    const target = (getClubId(req) ?? '').trim();
    if (role === UserRole.CLUB_ADMIN && target && req.user?.clubId === target) {
      next();
      return;
    }
    res.status(403).json({ ok: false, error: 'forbidden', message: 'Outside your club scope' });
  };
}
