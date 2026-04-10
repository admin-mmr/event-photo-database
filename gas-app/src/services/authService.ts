import { ResultStatus } from '../types/enums';
import { ServiceResult } from '../types/responses';

/* global Session */

/**
 * AuthService — thin wrapper around GAS Session API.
 *
 * In GAS Web Apps deployed with "Execute as: USER_ACCESSING",
 * Session.getActiveUser().getEmail() returns the email of the
 * authenticated Google user. No additional OAuth step is needed
 * since GAS handles the OAuth flow automatically on first access.
 *
 * This service is intentionally minimal — it only verifies session state.
 * Authorization (who can do what) is handled by RoleGuard.
 * User lookup (is this person in our database?) is in AuthMiddleware.
 */

/**
 * Retrieves the current user's email from the active GAS session.
 *
 * Returns ERROR status if:
 *   - The Web App is not configured with Google OAuth (check appsscript.json)
 *   - The user somehow accessed without authentication
 *   - GAS returns an empty string (rare, but possible in some execution contexts)
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
 * rather than the published Web App URL. Editor deployments have
 * access restrictions that can cause auth issues.
 *
 * Returns true if running in editor/development mode.
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
