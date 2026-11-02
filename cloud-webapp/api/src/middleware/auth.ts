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
  /** Firebase `sign_in_provider` from the verified token: 'anonymous' for a
   *  guest, 'google.com' for Google sign-in. Undefined if the token lacks it. */
  signInProvider?: string;
  /** Providers linked to the account (keys of the token's `firebase.identities`,
   *  e.g. ['google.com', 'email']). A guest who upgrades in place with
   *  linkWithPopup keeps their uid and gains 'google.com' here. */
  linkedProviders?: string[];
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
      ...(decoded.firebase?.sign_in_provider ? { signInProvider: decoded.firebase.sign_in_provider } : {}),
      ...(decoded.firebase?.identities ? { linkedProviders: Object.keys(decoded.firebase.identities) } : {}),
    };
    next();
  } catch (err) {
    logger.warn({ err }, 'token verification failed');
    res.status(401).json({ ok: false, error: 'unauthorized', message: 'Invalid token' });
  }
}
