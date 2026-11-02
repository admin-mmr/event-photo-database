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

/**
 * True for a user signed in with, or LINKED to, a provider on
 * VERIFIED_SIGN_IN_PROVIDERS. "Linked" covers the guest who hit a bot check and
 * upgraded in place (web `upgradeGuestToGoogle`, linkWithPopup): same uid, so
 * their consent and saved selfies survive, but the token's `sign_in_provider`
 * may still say 'anonymous' — its `identities` is what proves the Google
 * account. A Google identity can only be linked by completing Google OAuth.
 */
export function hasVerifiedSignIn(req: Request): boolean {
  const user = req.user;
  if (!user) return false;
  if (user.signInProvider !== undefined && VERIFIED_SIGN_IN_PROVIDERS.has(user.signInProvider)) return true;
  return (user.linkedProviders ?? []).some((p) => VERIFIED_SIGN_IN_PROVIDERS.has(p));
}
