import type { Request, Response, NextFunction } from 'express';
import { getAuth } from 'firebase-admin/auth';
import { initializeApp, getApps, applicationDefault, cert } from 'firebase-admin/app';
import { env } from '../lib/config.js';
import { serviceAccountKey } from '../lib/googleCredentials.js';
import { logger } from '../lib/logger.js';
import type { UserRole } from '../lib/roles.js';

// Initialize firebase-admin exactly once. Idempotent across hot-reloads.
// On GCP, ADC (applicationDefault) is keyless via the metadata server. Off GCP
// (CLOUD_PROVIDER=azure) there is no metadata server, so use the explicit SA
// key — the same credential googleCredentials.ts authenticates to Google with.
if (getApps().length === 0) {
  const key = serviceAccountKey();
  initializeApp({
    credential: key ? cert(key as Parameters<typeof cert>[0]) : applicationDefault(),
    ...(env.FIREBASE_PROJECT_ID ? { projectId: env.FIREBASE_PROJECT_ID } : {}),
  });
}

export interface AuthedUser {
  uid: string;
  email: string | undefined;
  emailVerified: boolean;
  /** Control-plane role, resolved from the Users sheet by middleware/rbac.ts
   *  (attachRole). Undefined until that middleware runs / if the user has no
   *  active Users row and is not a bootstrap admin. */
  role?: UserRole;
  /** Club normalizedName for a club_admin; '' / undefined otherwise. */
  clubId?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthedUser;
  }
}

/**
 * Who is calling, when they happen to be signed in — for ATTRIBUTION only,
 * never authorization. Routes that are open to anyone (the volunteer upload
 * link) still want to know a signed-in uploader, but must not turn anyone away:
 * a missing, expired or forged token, or an anonymous guest session, all read
 * as "not signed in" (null) instead of a 401.
 */
export async function optionalUser(req: Request): Promise<AuthedUser | null> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  try {
    const decoded = await getAuth().verifyIdToken(header.slice('Bearer '.length));
    // A guest (continueAsGuest) has a uid but no identity worth recording.
    if (decoded.firebase?.sign_in_provider === 'anonymous') return null;
    return { uid: decoded.uid, email: decoded.email, emailVerified: decoded.email_verified ?? false };
  } catch (err) {
    logger.debug({ err }, 'optional token did not verify (treated as not signed in)');
    return null;
  }
}

/**
 * Verifies a Firebase ID token from the `Authorization: Bearer …` header
 * and attaches `req.user`. Returns 401 if the token is missing or invalid.
 *
 * Not yet wired into any route — see TODO in server.ts. Will replace the
 * gas-app `Session.getActiveUser()` pattern when route porting begins.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ ok: false, error: 'unauthorized', message: 'Missing bearer token' });
    return;
  }
  const idToken = header.slice('Bearer '.length);

  try {
    const decoded = await getAuth().verifyIdToken(idToken);
    req.user = {
      uid: decoded.uid,
      email: decoded.email,
      emailVerified: decoded.email_verified ?? false,
    };
    next();
  } catch (err) {
    logger.warn({ err }, 'token verification failed');
    res.status(401).json({ ok: false, error: 'unauthorized', message: 'Invalid token' });
  }
}
