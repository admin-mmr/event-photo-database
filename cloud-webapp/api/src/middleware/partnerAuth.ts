/**
 * partnerAuth.ts — API-key auth for the partner REST API (dev plan G5.3).
 *
 * The secret lives in env/Secret Manager (PARTNER_API_KEYS as `email:key` pairs),
 * NEVER in the world-viewable master Sheet (D2) — the Sheet's Users row only
 * records that the email is an active `api_client`. A request presents its key in
 * `X-Api-Key`; we resolve it to an email, confirm that email is an active
 * api_client in the Users tab, and attach `req.partner`.
 */

import type { Request, Response, NextFunction } from 'express';

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { UserRole, UserStatus } from '../lib/roles.js';
import { rateLimit } from './rateLimit.js';
import { getUserByEmail } from '../services/userStore.js';

export interface PartnerClient {
  email: string;
  clubId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    partner?: PartnerClient;
  }
}

/** Parse PARTNER_API_KEYS ("email:key,email2:key2") into key → email. */
export function parsePartnerKeys(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const i = pair.indexOf(':');
    if (i <= 0) continue;
    const email = pair.slice(0, i).trim().toLowerCase();
    const key = pair.slice(i + 1).trim();
    if (email && key) map.set(key, email);
  }
  return map;
}

/**
 * Gate a partner route: validate X-Api-Key, confirm the mapped email is an
 * active api_client, attach req.partner. 401 on a bad/absent key; 403 if the
 * email isn't an active api_client (e.g. deactivated in the Users tab).
 */
export async function requirePartner(req: Request, res: Response, next: NextFunction): Promise<void> {
  const keys = parsePartnerKeys(env.PARTNER_API_KEYS);
  const presented = req.header('X-Api-Key') ?? '';
  const email = presented ? keys.get(presented) : undefined;
  if (!email) {
    res.status(401).json({ ok: false, error: 'unauthorized', message: 'Invalid or missing API key' });
    return;
  }
  if (!env.MASTER_SPREADSHEET_ID) {
    res.status(503).json({ ok: false, error: 'not_configured', message: 'MASTER_SPREADSHEET_ID is not set' });
    return;
  }
  try {
    const user = await getUserByEmail(env.MASTER_SPREADSHEET_ID, email);
    if (!user || user.status !== UserStatus.ACTIVE || user.role !== UserRole.API_CLIENT) {
      res.status(403).json({ ok: false, error: 'forbidden', message: 'Not an active API client' });
      return;
    }
    req.partner = { email, clubId: user.clubId };
    next();
  } catch (err) {
    logger.warn({ err, email }, 'partner auth lookup failed');
    res.status(503).json({ ok: false, error: 'unavailable', message: 'Could not verify API client' });
  }
}

/** Per-api-client Firestore rate limit (no-ops under NODE_ENV=test). */
export const partnerRateLimit = (): ReturnType<typeof rateLimit> =>
  rateLimit({
    bucket: 'partner',
    limit: env.PARTNER_RATE_LIMIT,
    windowSec: env.PARTNER_RATE_WINDOW_SEC,
    keyFn: (req) => `partner:${req.partner?.email ?? req.ip ?? 'anon'}`,
  });
