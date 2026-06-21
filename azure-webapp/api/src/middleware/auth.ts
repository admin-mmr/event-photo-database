import type { Request, Response, NextFunction } from 'express';
import { getAuth } from 'firebase-admin/auth';
import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app';
import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';

// Initialize firebase-admin exactly once. Idempotent across hot-reloads.
if (getApps().length === 0) {
  initializeApp({
    credential: applicationDefault(),
    ...(env.FIREBASE_PROJECT_ID ? { projectId: env.FIREBASE_PROJECT_ID } : {}),
  });
}

export interface AuthedUser {
  uid: string;
  email: string | undefined;
  emailVerified: boolean;
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
    };
    next();
  } catch (err) {
    logger.warn({ err }, 'token verification failed');
    res.status(401).json({ ok: false, error: 'unauthorized', message: 'Invalid token' });
  }
}
