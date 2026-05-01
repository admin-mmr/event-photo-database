import { ResultStatus } from '../types/enums';
import { ServiceResult } from '../types/responses';

/* global Session */

/**
 * AuthService — thin wrapper around GAS Session API.
 *
 * The Web App is deployed with "Execute as: Me (owner)" (USER_DEPLOYING) and
 * "Who has access: Anyone with a Google account". Under this configuration
 * the script ALWAYS runs as the deploying account, so:
 *
 *   - Session.getActiveUser().getEmail() returns "" for visitors. This is
 *     normal and expected — it does NOT mean auth failed.
 *   - Visitor identity comes from the OAuth 2.0 authorization code flow:
 *     login.html redirects to accounts.google.com, Google redirects back
 *     with ?code=…, router.handleOAuthCallback exchanges the code for an
 *     ID token, and we mint a CacheService session token that the client
 *     passes back on every subsequent request.
 *
 * So the auth pipeline is:
 *   1. authMiddleware.authenticateRequest tries this service first (cheap
 *      no-op under USER_DEPLOYING — always returns empty for visitors).
 *   2. Falls back to authenticateBySession(sessionToken) which looks up
 *      the OAuth-minted token in CacheService.
 *
 * This service is intentionally minimal — it only verifies session state.
 * Authorization (who can do what) is handled by RoleGuard.
 * User lookup (is this person in our database?) is in AuthMiddleware.
 */

/**
 * Retrieves the current user's email from the active GAS session.
 *
 * Under USER_DEPLOYING (the live deployment mode) this returns ERROR with
 * an empty-session message for every unauthenticated visitor — that's the
 * expected first-visit state, NOT a misconfiguration. Callers (the router)
 * should treat that case as "fall through to session-token auth" and show
 * a clean login page rather than surfacing the message.
 *
 * The error text is kept generic so it never alarms end users if it does
 * leak through to the login page on a stale code path.
 *
 * Will only return SUCCESS if:
 *   - The deployment was changed to USER_ACCESSING (legacy / future), OR
 *   - The visitor is the script owner running it from the GAS editor.
 */
export function getCurrentUserEmail(): ServiceResult<{ email: string }> {
  let email: string;
  try {
    email = Session.getActiveUser().getEmail();
  } catch {
    return {
      status: ResultStatus.ERROR,
      message: 'No active session.',
    };
  }

  if (!email || email.trim() === '') {
    return {
      status: ResultStatus.ERROR,
      message: 'No active session.',
    };
  }

  return {
    status: ResultStatus.SUCCESS,
    message: 'Session active',
    data: { email: email.trim().toLowerCase() },
  };
}

/**
 * Checks whether the caller is using the GAS editor "test deployment"
 * rather than the published Web App URL.
 *
 * With "Execute as: Me (owner)", the editor preview runs as the owner and
 * getEmail() returns the owner's email — so technically it's non-empty.
 * This helper is retained for diagnostic logging; route handlers should
 * always redirect users to the published URL rather than the editor URL.
 *
 * Returns true if a session email is detectable (editor or published).
 */
export function isEditorSession(): boolean {
  try {
    const email = Session.getActiveUser().getEmail();
    // In editor mode, getEmail() returns the script owner's email without OAuth
    return email !== '';
  } catch {
    return false;
  }
}
