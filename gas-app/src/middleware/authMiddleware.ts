import { ResultStatus, UserRole, UserStatus } from '../types/enums';
import { UserRecord } from '../types/models';
import { ServiceResult } from '../types/responses';
import { getCurrentUserEmail } from '../services/authService';
import { getAllRows } from '../services/sheetService';
import { toUserRecord } from '../utils/sheetMapper';
import { getConfig } from '../config/constants';

/**
 * AuthMiddleware — request authentication and user resolution pipeline.
 *
 * Every incoming request (doGet / doPost) runs through these two steps
 * before reaching a route handler:
 *
 *   Step 1: getCurrentUser()   — verify GAS session, extract email
 *   Step 2: resolveUser(email) — look up user in Sheets, check status
 *
 * If either step fails, the router returns an appropriate error page / JSON.
 * This keeps auth logic out of route handlers entirely.
 */

/**
 * Step 1 — Extracts and validates the current user's email from the GAS session.
 *
 * Returns SUCCESS with { email } on authentication, ERROR otherwise.
 * The email is normalized to lowercase before being returned.
 */
export function getCurrentUser(): ServiceResult<{ email: string }> {
  return getCurrentUserEmail();
}

/**
 * Step 2 — Looks up the email in the Users sheet and returns the full UserRecord.
 *
 * Returns ERROR if:
 *   - No record found → user is not registered in the system
 *   - Record exists but status is INACTIVE → user has been deactivated
 *
 * This is a linear scan of the Users sheet. For Phase 1 (< 500 users)
 * this is acceptable. Phase 2 can add an in-memory cache.
 */
export function resolveUser(email: string): ServiceResult<UserRecord> {
  const config = getConfig();
  let rows: unknown[][];

  try {
    rows = getAllRows(config.SHEET_NAMES.USERS);
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to read Users sheet: ${String(err)}`,
    };
  }

  const user = rows
    .map(toUserRecord)
    .find((r): r is UserRecord => r !== null && r.email === email);

  if (!user) {
    return {
      status: ResultStatus.ERROR,
      message:
        'Access denied. Your Google account is not registered in this system. ' +
        'Contact an administrator to request access.',
    };
  }

  if (user.status === UserStatus.INACTIVE) {
    return {
      status: ResultStatus.ERROR,
      message:
        'Your account has been deactivated. ' +
        'Contact an administrator to restore access.',
    };
  }

  return {
    status: ResultStatus.SUCCESS,
    message: 'User authenticated',
    data: user,
  };
}

/**
 * Convenience: runs both auth steps and returns the full UserRecord on success.
 * This is the single call most route handlers use.
 */
export function authenticateRequest(): ServiceResult<UserRecord> {
  const sessionResult = getCurrentUser();
  if (sessionResult.status !== ResultStatus.SUCCESS || !sessionResult.data) {
    return { status: ResultStatus.ERROR, message: sessionResult.message };
  }
  return resolveUser(sessionResult.data.email);
}

/**
 * Phase 5 — API key authentication.
 *
 * GAS web apps do not expose HTTP request headers to the script, so the API
 * key is passed as a query-string parameter (`?api_key=<key>`) rather than
 * an `X-Api-Key` header. The value is the registered email of an API_CLIENT
 * user in the Users sheet.
 *
 * Authentication rules:
 *   1. The key must be a non-empty string.
 *   2. A Users row must exist with email === key AND role === API_CLIENT.
 *   3. The user must be ACTIVE.
 *
 * Returns SUCCESS with the UserRecord on valid auth, ERROR otherwise.
 * Callers must then perform rate-limit checking before executing the request.
 */
export function authenticateApiKey(apiKey: string): ServiceResult<UserRecord> {
  const key = (apiKey ?? '').trim().toLowerCase();
  if (!key) {
    return {
      status: ResultStatus.ERROR,
      message: 'Missing api_key parameter. Include ?api_key=<your-key> in the request.',
    };
  }

  const config = getConfig();
  let rows: unknown[][];
  try {
    rows = getAllRows(config.SHEET_NAMES.USERS);
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to read Users sheet: ${String(err)}`,
    };
  }

  const user = rows
    .map(toUserRecord)
    .find((r): r is UserRecord => r !== null && r.email === key);

  if (!user) {
    return {
      status: ResultStatus.ERROR,
      message: 'Invalid API key. The key is not registered in this system.',
    };
  }

  if (user.role !== UserRole.API_CLIENT) {
    return {
      status: ResultStatus.ERROR,
      message: 'Forbidden. This key does not have API_CLIENT privileges.',
    };
  }

  if (user.status === UserStatus.INACTIVE) {
    return {
      status: ResultStatus.ERROR,
      message: 'API key is deactivated. Contact an administrator to restore access.',
    };
  }

  return {
    status: ResultStatus.SUCCESS,
    message: 'API key authenticated',
    data: user,
  };
}
