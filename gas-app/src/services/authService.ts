import { ResultStatus } from '../types/enums';
import { ServiceResult } from '../types/responses';

/* global Session */

/**
 * AuthService — thin wrapper around GAS Session API.
 *
 * The Web App is deployed with "Execute as: Me (owner)", so the script
 * always runs with the owner's credentials and can access owner-shared
 * resources (e.g. the spreadsheet) regardless of who is logged in.
 *
 * "Who has access" is set to "Anyone with a Google account", which means
 * Google forces the visitor to sign in before the script runs. Once signed
 * in, Session.getActiveUser().getEmail() returns the *visitor's* email —
 * not the owner's — so we can still identify and authorize each user
 * against the Users sheet.
 *
 * This service is intentionally minimal — it only verifies session state.
 * Authorization (who can do what) is handled by RoleGuard.
 * User lookup (is this person in our database?) is in AuthMiddleware.
 */

/**
 * Retrieves the current user's email from the active GAS session.
 *
 * With "Execute as: Me" + "Anyone with a Google account", GAS guarantees
 * the visitor is signed in before doGet/doPost runs, so this should always
 * return a non-empty email in production.
 *
 * Returns ERROR status if:
 *   - The Web App access setting was accidentally changed to "Anyone" (no login)
 *   - The script is being run from the GAS editor preview (not the published URL)
 *   - GAS returns an empty string for any other reason
 */
export function getCurrentUserEmail(): ServiceResult<{ email: string }> {
  let email: string;
  try {
    email = Session.getActiveUser().getEmail();
  } catch {
    return {
      status: ResultStatus.ERROR,
      message:
        'Unable to retrieve user session. ' +
        'Ensure the Web App is deployed with Google Account authentication.',
    };
  }

  if (!email || email.trim() === '') {
    return {
      status: ResultStatus.ERROR,
      message:
        'Not authenticated. Please access this app through the published Web App URL, ' +
        'not via the GAS editor preview.',
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
