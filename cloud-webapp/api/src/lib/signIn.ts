/**
 * signIn.ts — who counts as a GUEST for bot protection.
 *
 * Kept free of firebase-admin so the reCAPTCHA and rate-limit middleware can
 * use it without initialising the Admin SDK. `req.user.signInProvider` is set
 * by requireAuth (middleware/auth.ts) from the verified token.
 */

import type { Request } from 'express';

/**
 * Sign-in providers whose accounts a bot cannot mass-create. Anonymous guests
 * can be minted at will — each a fresh uid, so a fresh per-uid rate-limit
 * quota — which is the hole reCAPTCHA (middleware/recaptcha.ts) and the per-IP
 * guest limits (middleware/rateLimit.ts) exist to cover; a Google account
 * can't be, and its fixed uid makes the per-uid limits bind. An ALLOWLIST on
 * purpose: a provider added later (e.g. email/password, cheap to mass-create)
 * stays treated as a guest unless someone decides otherwise.
 */
const VERIFIED_SIGN_IN_PROVIDERS: ReadonlySet<string> = new Set(['google.com']);

/** True for a user signed in with a provider on VERIFIED_SIGN_IN_PROVIDERS. */
export function hasVerifiedSignIn(req: Request): boolean {
  const provider = req.user?.signInProvider;
  return provider !== undefined && VERIFIED_SIGN_IN_PROVIDERS.has(provider);
}
