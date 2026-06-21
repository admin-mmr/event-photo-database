import type { Request, Response, NextFunction } from 'express';

import { env } from '../lib/config.js';

/**
 * requireAdmin — gate admin-only routes (e.g. "Index event", M1.4).
 * Must run AFTER requireAuth. Admins are a comma-separated allowlist in
 * ADMIN_EMAILS (env / deploy flag); email must be verified.
 *
 * Good enough for a handful of org admins; swap for Firebase custom claims
 * if the admin set ever needs to be managed at runtime.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const admins = env.ADMIN_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const email = req.user?.email?.toLowerCase();
  if (!email || !req.user?.emailVerified || !admins.includes(email)) {
    res.status(403).json({ ok: false, error: 'forbidden', message: 'Admin access required' });
    return;
  }
  next();
}
