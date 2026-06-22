/**
 * adminShared.ts — helpers shared by the control-plane admin routes (G2):
 * master-Sheet guard, store-error → HTTP mapping, and effective club scope
 * (club_admin pinned to their club; super_admin global unless masquerading).
 */

import type { Request, Response } from 'express';
import { ZodError } from 'zod';

import { env } from '../lib/config.js';
import { UserRole } from '../lib/roles.js';
import { ClubStoreError } from '../services/clubStore.js';
import { EventStoreError } from '../services/eventStore.js';
import { LinkStoreError } from '../services/linkStore.js';
import { UserStoreError } from '../services/userStore.js';

/** Store error `code` → HTTP status. */
const CODE_STATUS: Record<string, number> = {
  duplicate: 409,
  already_revoked: 409,
  not_found: 404,
  invalid: 400,
};

/** Resolve the configured master Sheet, or 503 if unset (mirrors sync route). */
export function masterSheetId(res: Response): string | null {
  if (!env.MASTER_SPREADSHEET_ID) {
    res.status(503).json({
      ok: false,
      error: 'not_configured',
      message: 'MASTER_SPREADSHEET_ID is not set — configure the master Sheet first',
    });
    return null;
  }
  return env.MASTER_SPREADSHEET_ID;
}

/**
 * Map an expected route error to an HTTP status + JSON body. Handles Zod
 * validation errors (400) and store errors (duplicate→409, not_found→404,
 * invalid→400). Returns true if handled; otherwise the caller should `next(err)`.
 */
export function handleStoreError(err: unknown, res: Response): boolean {
  if (err instanceof ZodError) {
    res.status(400).json({ ok: false, error: 'invalid', message: err.issues[0]?.message ?? 'Invalid request' });
    return true;
  }
  if (
    err instanceof UserStoreError ||
    err instanceof ClubStoreError ||
    err instanceof EventStoreError ||
    err instanceof LinkStoreError
  ) {
    res.status(CODE_STATUS[err.code] ?? 400).json({ ok: false, error: err.code, message: err.message });
    return true;
  }
  return false;
}

/**
 * Effective club scope for a request: a club_admin is pinned to their own club;
 * a super_admin sees everything unless masquerading (X-Masquerade-Club header,
 * honored ONLY for super_admins). Returns undefined for "all clubs"; the
 * sentinel '__none__' means "no club" (a roleless/over-scoped caller sees none).
 */
export function effectiveClubScope(req: Request): string | undefined {
  if (req.user?.role === UserRole.SUPER_ADMIN) {
    const m = req.header('X-Masquerade-Club');
    return m && m.trim() ? m.trim() : undefined;
  }
  if (req.user?.role === UserRole.CLUB_ADMIN) return req.user.clubId || '__none__';
  return '__none__';
}

export const actor = (req: Request): string => req.user?.email ?? 'unknown';
