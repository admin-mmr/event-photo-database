import { ResultStatus, UserRole, UserStatus } from '../types/enums';
import { UserRecord, UploadLinkRecord } from '../types/models';
import { ServiceResult, ServerResponse } from '../types/responses';
import { getCurrentUserEmail } from '../services/authService';
import { getAllRows } from '../services/sheetService';
import { toUserRecord } from '../utils/sheetMapper';
import { getConfig } from '../config/constants';
import { lookupSession } from '../services/sessionService';
import { findByToken } from '../services/uploadLinkService';
import { requireRole } from './roleGuard';

/**
 * AuthMiddleware — request authentication and user resolution pipeline.
 *
 * Three authentication paths:
 *
 *   Path A — GAS native session (Session.getActiveUser).
 *     Works when the Web App is deployed with "Execute as: Anyone with Google account".
 *
 *   Path B — Session token (CacheService).
 *     Used with the GIS client-side login flow. After the ID token is verified
 *     server-side and a session is created, every subsequent call passes the
 *     session token.
 *
 *   Path C — Upload link token.
 *     Used by volunteers on the upload page. A valid, non-revoked upload link
 *     token grants upload access scoped to the (event, club) pair in the link.
 *     The volunteer's identity is the Google account they authenticate with
 *     during the upload session — they are NOT stored in the Users sheet.
 *
 * If any step fails, the router returns an appropriate error page / JSON.
 * This keeps auth logic out of route handlers entirely.
 */

// ─── Path A/B — Admin authentication ─────────────────────────────────────────

/**
 * Step 1 — Extracts and validates the current user's email from the GAS session.
 */
export function getCurrentUser(): ServiceResult<{ email: string }> {
  return getCurrentUserEmail();
}

/**
 * Step 2 — Looks up the email in the Users sheet and returns the full UserRecord.
 *
 * Returns ERROR if:
 *   - No record found → not registered as an admin
 *   - Record exists but status is INACTIVE → account deactivated
 */
export function resolveUser(email: string): ServiceResult<UserRecord> {
  const config = getConfig();
  let rows: unknown[][];

  try {
    rows = getAllRows(config.SHEET_NAMES.USERS);
  } catch (err) {
    // Log the raw error internally but never expose the GAS exception to the user.
    // The most common cause is SpreadsheetApp permission not yet granted —
    // the script deployer needs to re-authorize the deployment.
    const errStr = String(err);
    const isPermissionError =
      errStr.includes('You do not have permission') ||
      errStr.includes('SpreadsheetApp') ||
      errStr.includes('authorization') ||
      errStr.includes('googleapis.com/auth');
    console.error('[authMiddleware] resolveUser failed:', errStr);
    return {
      status: ResultStatus.ERROR,
      message: isPermissionError
        ? 'System configuration error — the app needs to be re-authorized by its owner. Please contact admin@mmrunners.org.'
        : 'Unable to load user data. Please try again, or contact admin@mmrunners.org if the problem persists.',
    };
  }

  const user = rows
    .map(toUserRecord)
    .find((r): r is UserRecord => r !== null && r.email === email);

  if (!user) {
    return {
      status: ResultStatus.ERROR,
      message:
        `您是跑团联络员吗？请联系 admin@mmrunners.org 把您的邮箱权限设置好。我们现在没找到 ${email}。\n` +
        `Are you a club coordinator? Email admin@mmrunners.org to get ${email} added.`,
    };
  }

  if (user.status === UserStatus.INACTIVE) {
    return {
      status: ResultStatus.ERROR,
      message:
        `您的账号 ${email} 已被停用。如需恢复，请联系 admin@mmrunners.org。\n` +
        `Account ${email} has been deactivated. Email admin@mmrunners.org to restore access.`,
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
 *
 * Auth priority:
 *   1. GAS session (Session.getActiveUser) — works with USER_ACCESSING deployment
 *   2. Session token — used with USER_DEPLOYING + GIS client-side login (Path B)
 *
 * Pass the sessionToken from the client payload when calling from google.script.run.
 */
export function authenticateRequest(sessionToken?: string): ServiceResult<UserRecord> {
  // 1. Try GAS native session (works with USER_ACCESSING)
  const sessionResult = getCurrentUser();
  if (sessionResult.status === ResultStatus.SUCCESS && sessionResult.data?.email) {
    return resolveUser(sessionResult.data.email);
  }

  // 2. Fall back to session token from client (USER_DEPLOYING + GIS)
  if (sessionToken) {
    return authenticateBySession(sessionToken);
  }

  return { status: ResultStatus.ERROR, message: sessionResult.message };
}

/**
 * Authenticates using a session token created after GIS login.
 * Looks up the token in CacheService and resolves the stored email.
 */
export function authenticateBySession(sessionToken: string): ServiceResult<UserRecord> {
  const session = lookupSession(sessionToken);
  if (!session) {
    return {
      status:  ResultStatus.ERROR,
      message: 'Session expired or invalid. Please sign in again.',
    };
  }
  return resolveUser(session.email);
}

// ─── Path C — Upload link authentication ─────────────────────────────────────

/**
 * Context returned for a volunteer authenticated via an upload link.
 * Volunteers are not stored in the Users sheet — they are identified by their
 * Google email (captured from the OAuth session) and the link scope.
 */
export interface UploadLinkContext {
  readonly email: string;             // Volunteer's Google account email
  readonly linkId: string;            // Upload link ID (stable across rotations)
  readonly linkVersion: number;       // Version of the token used (for audit forensics)
  readonly eventId: string;           // Event scope from the link
  readonly clubName: string;          // Club scope from the link
}

/**
 * Authenticates a request using an upload link token and the caller's
 * current Google session email.
 *
 * Steps:
 *   1. Validate the token (must exist and not be revoked).
 *   2. Extract the caller's Google email from the GAS session.
 *
 * Returns SUCCESS with an UploadLinkContext on valid auth.
 * Returns ERROR if the token is invalid/revoked or no Google session exists.
 */
export function authenticateByUploadLink(
  token: string,
  callerEmail: string
): ServiceResult<UploadLinkContext> {
  if (!token || !token.trim()) {
    return { status: ResultStatus.ERROR, message: 'Upload link token is required.' };
  }

  if (!callerEmail || !callerEmail.trim()) {
    return {
      status: ResultStatus.ERROR,
      message: 'Google authentication is required to use this upload link.',
    };
  }

  const link: UploadLinkRecord | null = findByToken(token.trim());

  if (!link) {
    return {
      status: ResultStatus.ERROR,
      message: 'This upload link is not recognized.',
    };
  }

  if (link.revokedAt) {
    return {
      status: ResultStatus.ERROR,
      message:
        'This upload link has been revoked. Please contact your club administrator for a new link.',
    };
  }

  return {
    status: ResultStatus.SUCCESS,
    message: 'Upload link authenticated',
    data: {
      email:       callerEmail.trim().toLowerCase(),
      linkId:      link.linkId,
      linkVersion: link.version,
      eventId:     link.eventId,
      clubName:    link.clubName,
    },
  };
}

/**
 * Checks whether the given admin is allowed to manage links for the given club.
 *
 * Super admins can manage any club's links.
 * Club admins can only manage their own club.
 */
export function canManageClubLinks(admin: UserRecord, clubName: string): boolean {
  if (admin.role === UserRole.SUPER_ADMIN) return true;
  if (admin.role === UserRole.CLUB_ADMIN && admin.clubId === clubName) return true;
  return false;
}

// ─── google.script.run auth helpers ──────────────────────────────────────────

/**
 * Discriminated union returned by requireAdminOrFail / requireSuperAdminOrFail.
 */
export type AdminCheckResult =
  | { ok: true;  adminEmail: string; adminRole: UserRole; adminClubId: string }
  | { ok: false; response: ServerResponse };

/**
 * Accepts any authenticated admin (super_admin or club_admin).
 * Use for operations that both tiers can perform within their own scope.
 */
export function requireAdminOrFail(sessionToken?: string): AdminCheckResult {
  const authResult = authenticateRequest(sessionToken);
  if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
    return { ok: false, response: { status: 'error', message: 'Authentication required' } };
  }
  const user = authResult.data;
  if (user.role !== UserRole.SUPER_ADMIN && user.role !== UserRole.CLUB_ADMIN) {
    return { ok: false, response: { status: 'error', message: 'Admin access required.' } };
  }
  return { ok: true, adminEmail: user.email, adminRole: user.role, adminClubId: user.clubId };
}

/**
 * Requires super_admin role specifically.
 * Use for global operations like creating clubs or masquerading.
 */
export function requireSuperAdminOrFail(sessionToken?: string): AdminCheckResult {
  const authResult = authenticateRequest(sessionToken);
  if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
    return { ok: false, response: { status: 'error', message: 'Authentication required' } };
  }
  const guard = requireRole(authResult.data.role, UserRole.SUPER_ADMIN);
  if (guard.status !== ResultStatus.SUCCESS) {
    return { ok: false, response: { status: 'error', message: guard.message } };
  }
  return {
    ok: true,
    adminEmail:  authResult.data.email,
    adminRole:   authResult.data.role,
    adminClubId: authResult.data.clubId,
  };
}
