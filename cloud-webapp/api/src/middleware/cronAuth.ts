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
 *
 * Rotation grace window: SYNC_TRIGGER_TOKEN_PREVIOUS (empty except during a
 * rotation) is accepted alongside the current value, because the old token
 * outlives the switch in places we can't update atomically — every queued Cloud
 * Tasks upload copy carries it in its stored header (uploadDispatch.ts), and
 * each Cloud Scheduler job keeps sending it until its provision script is
 * re-run. A PREVIOUS match logs a WARN (`alert: "sync_token_previous"`, never
 * the value) naming the caller, so the owner can see who still holds the old
 * token and when it is safe to clear.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from './auth.js';
import { attachRole, requireAnyAdmin, requireOwner, requireSuperAdmin } from './rbac.js';

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Which configured secret a presented token matches, if either. */
export type CronTokenMatch = 'current' | 'previous' | null;

/** Constant-time compare of the provided token against SYNC_TRIGGER_TOKEN and,
 *  during a rotation, SYNC_TRIGGER_TOKEN_PREVIOUS. Hashing both sides first
 *  keeps each comparison length-independent, and both slots are always compared
 *  so the timing doesn't reveal which one matched. PREVIOUS only ever extends a
 *  configured current token: with SYNC_TRIGGER_TOKEN empty the header path is
 *  closed, whatever PREVIOUS holds. */
export function matchCronToken(provided: string | undefined): CronTokenMatch {
  const secret = env.SYNC_TRIGGER_TOKEN;
  if (!secret || !provided) return null;
  const given = sha256(provided);
  const previous = env.SYNC_TRIGGER_TOKEN_PREVIOUS;
  const matchesCurrent = timingSafeEqual(given, sha256(secret));
  // With PREVIOUS unset, compare against a same-cost stand-in and discard it.
  const matchesPrevious = timingSafeEqual(given, sha256(previous || secret));
  if (matchesCurrent) return 'current';
  if (previous && matchesPrevious) return 'previous';
  return null;
}

/** True when the provided token matches either slot. Pass `req` from a gate so a
 *  PREVIOUS match is logged with its caller; leave it out for a second check on
 *  the same request (adminDuplicates' scope lookup) so it logs once. */
export function validCronToken(provided: string | undefined, req?: Request): boolean {
  const match = matchCronToken(provided);
  if (match === 'previous' && req) {
    logger.warn(
      {
        alert: 'sync_token_previous',
        method: req.method,
        path: req.originalUrl,
        userAgent: req.header('user-agent'),
        // Set by Cloud Scheduler / Cloud Tasks; they name which caller still
        // holds the pre-rotation token. Neither is secret.
        schedulerJob: req.header('x-cloudscheduler-jobname'),
        taskName: req.header('x-cloudtasks-taskname'),
      },
      'X-Sync-Token matched SYNC_TRIGGER_TOKEN_PREVIOUS: caller still holds the pre-rotation token',
    );
  }
  return match !== null;
}

/** Allow the request if it carries a valid cron token; otherwise fall back to
 *  the dynamic RBAC admin path (requireAuth → attachRole → requireAnyAdmin), so
 *  any active super_admin or club_admin can run it. attachRole resolves the role
 *  from the Users sheet (or the bootstrap allowlist) and never rejects on its
 *  own; requireAnyAdmin does the gating (and still requires a verified email). */
export function allowCronOrAdmin(req: Request, res: Response, next: NextFunction): void {
  if (validCronToken(req.header('x-sync-token'), req)) {
    next();
    return;
  }
  requireAuth(req, res, () => {
    void attachRole(req, res, () => requireAnyAdmin(req, res, next));
  });
}

/**
 * Same shape as `allowCronOrAdmin`, but a human caller must be a SUPER admin
 * (or owner). For actions that are destructive and cross-club, where "any admin"
 * is too wide — e.g. the selfie retention sweep. The machine token still passes:
 * it is only held by our own schedulers and shell tooling, and it already
 * carries whole-fleet authority.
 */
export function allowCronOrSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (validCronToken(req.header('x-sync-token'), req)) {
    next();
    return;
  }
  requireAuth(req, res, () => {
    void attachRole(req, res, () => requireSuperAdmin(req, res, next));
  });
}

/**
 * Same shape again, but a human caller must be the OWNER — event deletion
 * (routes/adminEvents.ts) is the case this exists for: it is the one action
 * that retires a whole event across every club, so it sits above super_admin.
 * The machine token still passes, for infra/scripts/delete-event.sh.
 */
export function allowCronOrOwner(req: Request, res: Response, next: NextFunction): void {
  if (validCronToken(req.header('x-sync-token'), req)) {
    next();
    return;
  }
  requireAuth(req, res, () => {
    void attachRole(req, res, () => requireOwner(req, res, next));
  });
}
