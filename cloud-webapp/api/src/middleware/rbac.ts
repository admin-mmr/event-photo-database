/**
 * rbac.ts — role-based access control for the control plane, ported from gas-app
 * roleGuard (dev plan G1.3). Runs AFTER requireAuth.
 *
 * Roles resolve from the Users sheet (SSOT, via userStore's TTL cache). A
 * bootstrap allowlist (env.ADMIN_EMAILS) is always treated as super_admin so the
 * org can never lock itself out before any Users rows exist — same allowlist the
 * legacy requireAdmin uses. The `owner` class comes ONLY from env.OWNER_EMAILS
 * (see roles.ts for why the Sheet can never grant it).
 *
 * Because the Sheet has no row-level security, this middleware is the ONLY guard
 * on Sheet writes — every control-plane write route must sit behind requireRole
 * and, where a club is involved, requireClubScope.
 */

import type { Request, Response, NextFunction } from 'express';

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { UserRole, UserStatus, isGlobalAdmin, isUserRole, type UserRole as Role } from '../lib/roles.js';
import { getUserByEmail } from '../services/userStore.js';

const emailList = (raw: string): string[] =>
  raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function bootstrapAdmins(): string[] {
  return emailList(env.ADMIN_EMAILS);
}

function owners(): string[] {
  return emailList(env.OWNER_EMAILS);
}

/**
 * Resolve req.user.role / req.user.clubId from the Users sheet (best-effort).
 * Never rejects on its own — gating is done by requireRole / requireClubScope —
 * so routes that only need authentication can run this harmlessly.
 *
 * Resolution order: owner allowlist → bootstrap allowlist → active Users row → none.
 */
export async function attachRole(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const email = req.user?.email?.toLowerCase();
  if (!email) {
    next();
    return;
  }
  if (owners().includes(email)) {
    req.user!.role = UserRole.OWNER;
    req.user!.clubId = '';
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
      // isUserRole: a Users row can never carry owner (or any unknown string),
      // even if someone types it into the Sheet by hand.
      if (user && user.status === UserStatus.ACTIVE && isUserRole(user.role)) {
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
  // NAMED, not an arrow: `test/routeGuards.test.ts` walks the Express route
  // table and identifies each route's guards by function name, so an unguarded
  // route can never be added silently. Also makes stack traces legible.
  return function requireRoleGuard(req: Request, res: Response, next: NextFunction): void {
    const role = req.user?.role;
    if (!req.user?.emailVerified || !role || !roles.includes(role)) {
      res.status(403).json({ ok: false, error: 'forbidden', message: 'Insufficient role' });
      return;
    }
    next();
  };
}

// Classes nest: owner ⊇ super_admin ⊇ club_admin. Each guard lists every class
// above it, so an owner passes anything a super_admin can.

/** Convenience: owner only — event deletion. */
export const requireOwner = requireRole(UserRole.OWNER);
/** Convenience: super_admin (or owner). */
export const requireSuperAdmin = requireRole(UserRole.OWNER, UserRole.SUPER_ADMIN);
/** Convenience: any admin (owner, super_admin or club_admin). */
export const requireAnyAdmin = requireRole(UserRole.OWNER, UserRole.SUPER_ADMIN, UserRole.CLUB_ADMIN);

/**
 * Enforce club scope on a route that targets a specific club's data. An owner or
 * super_admin passes for any club; a club_admin passes only for their own `clubId`. Must run
 * after attachRole (and typically requireAnyAdmin).
 *
 * `getClubId` extracts the target club (normalizedName) from the request — e.g.
 * `(req) => req.params.clubId` or `(req) => req.body.clubId`. A missing/empty
 * target is rejected (fail closed).
 */
export function requireClubScope(getClubId: (req: Request) => string | undefined) {
  // Named for the same reason as requireRole's guard.
  return function requireClubScopeGuard(req: Request, res: Response, next: NextFunction): void {
    const role = req.user?.role;
    if (isGlobalAdmin(role)) {
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
