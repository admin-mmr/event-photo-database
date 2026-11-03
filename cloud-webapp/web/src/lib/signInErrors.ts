/**
 * signInErrors.ts — tell a user backing out of the Google popup apart from a
 * sign-in that actually failed.
 *
 * The sign-in buttons used to fire `void signInWithGoogle()`, so closing the
 * popup became an unhandled rejection, which reportError.ts files at ERROR and
 * the alert policy emails on (3 on 2026-11-02, NYC Marathon). Meanwhile a real
 * failure (popup blocked, network) told the user nothing at all.
 *
 * Kept out of firebase.ts so it can be tested without loading the SDK.
 */

/** Firebase Auth codes that mean "the user (or a second click) cancelled",
 *  not "something is broken". */
const CANCELLED_CODES = new Set([
  'auth/popup-closed-by-user',
  'auth/cancelled-popup-request',
  'auth/user-cancelled',
]);

export function isSignInCancelled(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && CANCELLED_CODES.has(code);
}
