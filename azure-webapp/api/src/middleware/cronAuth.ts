/**
 * cronAuth.ts — shared "machine caller OR Firebase admin" gate.
 *
 * Cloud Scheduler and the gas-app upload flow can't mint a Firebase ID token,
 * so machine callers present the shared secret in the `X-Sync-Token` header
 * (matched against SYNC_TRIGGER_TOKEN). Humans fall through to the normal
 * requireAuth → requireAdmin path. Disabled (header path) when the env var is
 * empty, so no token == admin-only.
 *
 * Extracted from routes/sync.ts so the same gate protects the automated
 * indexing triggers (POST /api/events/:id/index, POST /api/admin/index-scan)
 * without duplicating the constant-time compare.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

import { env } from '../lib/config.js';
import { requireAuth } from './auth.js';
import { requireAdmin } from './admin.js';

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
 *  the Firebase admin path (requireAuth → requireAdmin). */
export function allowCronOrAdmin(req: Request, res: Response, next: NextFunction): void {
  if (validCronToken(req.header('x-sync-token'))) {
    next();
    return;
  }
  requireAuth(req, res, () => requireAdmin(req, res, next));
}
