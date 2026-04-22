import { ResultStatus, UserRole } from '../types/enums';
import { ADMIN_CLUB_ID } from '../config/constants';
import { UserRecord } from '../types/models';
import {
  validateCreateUserPayload,
  validateUpdateUserPayload,
  validateFolderNamePayload,
  validateCreateEventPayload,
  validateUpdateEventPayload,
  validateCreateClubPayload,
  validateUpdateClubPayload,
  sanitizePayload,
} from '../middleware/inputValidator';
import { createUser, updateUser, deactivateUser, reactivateUser } from '../services/userService';
import { deleteSession } from '../services/sessionService';
import { createEvent, updateEvent, listAll as listAllEvents } from '../services/eventService';
import { createClub, updateClub, deactivateClub, listAll as listAllClubs } from '../services/clubService';
import {
  generateLink,
  revokeLink,
  rotateLink,
  listAll as listAllLinks,
  findByClub,
  findByEvent,
} from '../services/uploadLinkService';
import { validateFolderName } from '../utils/folderNameValidator';
import {
  softDeleteFile,
  restoreFile,
  listDeleted,
} from '../services/deleteService';
import { DeletedFileStatus } from '../types/enums';

/* global ContentService */

/**
 * ApiRoutes — handlers for doPost JSON API endpoints.
 *
 * Every handler:
 *   1. Validates the payload via InputValidator (returns 400 on error)
 *   2. Calls the appropriate service function
 *   3. Returns a JSON envelope via jsonOk() or jsonError()
 *
 * HTTP-like status codes are included in the JSON body (not HTTP status,
 * since GAS doPost always returns HTTP 200 — the code field carries semantic status).
 */

// ─── Response helpers ─────────────────────────────────────────────────────────

function jsonOk(
  data: unknown,
  message = 'OK'
): GoogleAppsScript.Content.TextOutput {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'success', code: 200, message, data }))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonError(
  message: string,
  code = 400,
  errors?: unknown
): GoogleAppsScript.Content.TextOutput {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'error', code, message, ...(errors !== undefined ? { errors } : {}) }))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonForbidden(message: string): GoogleAppsScript.Content.TextOutput {
  return jsonError(message, 403);
}

function jsonNotFound(message: string): GoogleAppsScript.Content.TextOutput {
  return jsonError(message, 404);
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST action=create_user
 * Admin-only. Creates a new user record in the Users sheet.
 */
export function handleCreateUser(
  payload: Record<string, unknown>,
  adminUser: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const clean = sanitizePayload(payload);
  const validation = validateCreateUserPayload(clean);
  if (validation.status !== ResultStatus.SUCCESS || !validation.data) {
    return jsonError('Validation failed', 400, validation.errors);
  }

  const result = createUser(validation.data, adminUser.email);
  if (result.status !== ResultStatus.SUCCESS) {
    return jsonError(result.message, 409, result.errors);
  }

  return jsonOk(result.data, result.message);
}

/**
 * POST action=update_user
 * Admin-only. Updates runningClub, role, and/or status of an existing user.
 */
export function handleUpdateUser(
  payload: Record<string, unknown>,
  adminUser: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const clean = sanitizePayload(payload);
  const validation = validateUpdateUserPayload(clean);
  if (validation.status !== ResultStatus.SUCCESS || !validation.data) {
    return jsonError('Validation failed', 400, validation.errors);
  }

  const result = updateUser(validation.data, adminUser.email);
  if (result.status !== ResultStatus.SUCCESS) {
    const code = result.message.includes('not found') ? 404 : 400;
    return jsonError(result.message, code, result.errors);
  }

  return jsonOk(result.data, result.message);
}

/**
 * POST action=deactivate_user
 * Admin-only. Sets a user's status to inactive.
 */
export function handleDeactivateUser(
  payload: Record<string, unknown>,
  _adminUser: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const email = String(payload['email'] ?? '').trim().toLowerCase();
  if (!email) {
    return jsonError('email is required', 400);
  }

  const result = deactivateUser(email);
  if (result.status !== ResultStatus.SUCCESS) {
    const code = result.message.includes('not found') ? 404 : 400;
    return jsonError(result.message, code);
  }

  return jsonOk(result.data, result.message);
}

/**
 * POST action=reactivate_user
 * Admin-only. Re-activates a previously deactivated user.
 */
export function handleReactivateUser(
  payload: Record<string, unknown>,
  _adminUser: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const email = String(payload['email'] ?? '').trim().toLowerCase();
  if (!email) {
    return jsonError('email is required', 400);
  }

  const result = reactivateUser(email);
  if (result.status !== ResultStatus.SUCCESS) {
    const code = result.message.includes('not found') ? 404 : 400;
    return jsonError(result.message, code);
  }

  return jsonOk(result.data, result.message);
}

/**
 * POST (or GET with params) action=validate_folder_name
 * Available to all authenticated users.
 * Returns { isValid, normalizedName, violations } for a proposed folder name.
 */
export function handleValidateFolderName(
  payload: Record<string, unknown>
): GoogleAppsScript.Content.TextOutput {
  const clean = sanitizePayload(payload);
  const validation = validateFolderNamePayload(clean);
  if (validation.status !== ResultStatus.SUCCESS || !validation.data) {
    return jsonError('Validation failed', 400, validation.errors);
  }

  const result = validateFolderName(validation.data);
  return jsonOk(result, 'Validation complete');
}

// ─── Event handlers ───────────────────────────────────────────────────────────

/**
 * POST action=create_event
 * Admin-only. Creates a new event with a Drive folder.
 */
export function handleCreateEvent(
  payload: Record<string, unknown>,
  adminUser: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const clean = sanitizePayload(payload);
  const validation = validateCreateEventPayload(clean);
  if (validation.status !== ResultStatus.SUCCESS || !validation.data) {
    return jsonError('Validation failed', 400, validation.errors);
  }

  const result = createEvent(validation.data, adminUser.email);
  if (result.status !== ResultStatus.SUCCESS) {
    const code = result.message.includes('already exists') ? 409 : 400;
    return jsonError(result.message, code, result.errors);
  }

  return jsonOk(result.data, result.message);
}

/**
 * POST action=update_event
 * Admin-only. Updates event metadata (name, date).
 */
export function handleUpdateEvent(
  payload: Record<string, unknown>,
  adminUser: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const clean = sanitizePayload(payload);
  const validation = validateUpdateEventPayload(clean);
  if (validation.status !== ResultStatus.SUCCESS || !validation.data) {
    return jsonError('Validation failed', 400, validation.errors);
  }

  const result = updateEvent(validation.data, adminUser.email);
  if (result.status !== ResultStatus.SUCCESS) {
    const code = result.message.includes('not found') ? 404 : 400;
    return jsonError(result.message, code, result.errors);
  }

  return jsonOk(result.data, result.message);
}

/**
 * POST action=list_events
 * Available to all authenticated users.
 * Accepts optional { page, pageSize, sort } parameters.
 */
export function handleListEvents(
  payload: Record<string, unknown>
): GoogleAppsScript.Content.TextOutput {
  const page = Number(payload['page']) || 1;
  const pageSize = Math.min(Number(payload['pageSize']) || 20, 100);
  const sort = (payload['sort'] === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';

  const result = listAllEvents(page, pageSize, sort);
  return jsonOk(result, `Found ${result.total} event(s)`);
}

// ─── Club handlers ────────────────────────────────────────────────────────────

/**
 * POST action=create_club
 * Admin-only. Creates a new club in the Clubs sheet.
 */
export function handleCreateClub(
  payload: Record<string, unknown>,
  adminUser: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const clean = sanitizePayload(payload);
  const validation = validateCreateClubPayload(clean);
  if (validation.status !== ResultStatus.SUCCESS || !validation.data) {
    return jsonError('Validation failed', 400, validation.errors);
  }

  const result = createClub(validation.data, adminUser.email);
  if (result.status !== ResultStatus.SUCCESS) {
    const code = result.message.includes('already exists') ? 409 : 400;
    return jsonError(result.message, code, result.errors);
  }

  return jsonOk(result.data, result.message);
}

/**
 * POST action=update_club
 * Admin-only. Updates a club's displayName (normalizedName is immutable).
 */
export function handleUpdateClub(
  payload: Record<string, unknown>,
  adminUser: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const clean = sanitizePayload(payload);
  const validation = validateUpdateClubPayload(clean);
  if (validation.status !== ResultStatus.SUCCESS || !validation.data) {
    return jsonError('Validation failed', 400, validation.errors);
  }

  const result = updateClub(validation.data, adminUser.email);
  if (result.status !== ResultStatus.SUCCESS) {
    const code = result.message.includes('not found') ? 404 : 400;
    return jsonError(result.message, code, result.errors);
  }

  return jsonOk(result.data, result.message);
}

/**
 * POST action=deactivate_club
 * Admin-only. Marks a club as inactive.
 */
export function handleDeactivateClub(
  payload: Record<string, unknown>,
  _adminUser: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const normalizedName = String(payload['normalizedName'] ?? '').trim();
  if (!normalizedName) {
    return jsonError('normalizedName is required', 400);
  }

  const result = deactivateClub(normalizedName);
  if (result.status !== ResultStatus.SUCCESS) {
    const code = result.message.includes('not found') ? 404 : 400;
    return jsonError(result.message, code);
  }

  return jsonOk(result.data, result.message);
}

/**
 * POST action=list_clubs
 * Available to all authenticated users.
 */
export function handleListClubs(
  _payload: Record<string, unknown>
): GoogleAppsScript.Content.TextOutput {
  const result = listAllClubs(1, 100);
  return jsonOk(result, `Found ${result.total} club(s)`);
}

/**
 * POST action=logout
 * Available to all authenticated users.
 * Invalidates the session token so subsequent requests are rejected.
 */
export function handleLogout(
  payload: Record<string, unknown>
): GoogleAppsScript.Content.TextOutput {
  const token = String(payload['session'] ?? '').trim();
  if (token) {
    deleteSession(token);
  }
  return jsonOk(null, 'Logged out successfully');
}

// ─── Upload Link handlers ─────────────────────────────────────────────────────

/**
 * POST action=generate_link
 * Club admin or super admin. Generates a new (event, club) upload link.
 * If an active link already exists for the pair, it is returned unchanged.
 *
 * Club admins may only generate links for their own club.
 * Super admins may generate links for any club.
 */
export function handleGenerateLink(
  payload: Record<string, unknown>,
  adminUser: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const eventId  = String(payload['eventId']  ?? '').trim();
  const clubName = String(payload['clubName'] ?? '').trim();

  if (!eventId || !clubName) {
    return jsonError('eventId and clubName are required', 400);
  }

  // The admin club is a role container, never a content destination.
  // No role — including super admin — may generate upload links that target it.
  if (clubName === ADMIN_CLUB_ID) {
    return jsonError(
      'Upload links cannot target the admin club. Select a real club as the destination.',
      400
    );
  }

  // Club admins are scoped to their own club only
  if (adminUser.role === UserRole.CLUB_ADMIN && adminUser.clubId !== clubName) {
    return jsonForbidden(
      `You administer "${adminUser.clubId}" and cannot generate links for "${clubName}".`
    );
  }

  const result = generateLink({ eventId, clubName }, adminUser.email);
  if (result.status !== ResultStatus.SUCCESS) {
    return jsonError(result.message, 400);
  }
  return jsonOk(result.data, result.message);
}

/**
 * POST action=revoke_link
 * Club admin or super admin. Revokes an existing upload link by linkId.
 *
 * Club admins may only revoke links for their own club.
 * Super admins may revoke any link.
 */
export function handleRevokeLink(
  payload: Record<string, unknown>,
  adminUser: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const linkId = String(payload['linkId'] ?? '').trim();
  const reason = String(payload['reason'] ?? '').trim();

  if (!linkId) {
    return jsonError('linkId is required', 400);
  }

  const result = revokeLink({ linkId, reason: reason || undefined }, adminUser.email);
  if (result.status !== ResultStatus.SUCCESS) {
    const code = result.message.includes('not found') ? 404 : 400;
    return jsonError(result.message, code);
  }

  // Club admins can only revoke their own club's links.
  // Note: the revocation has already been written at this point; if the scope
  // check fails we return an error but cannot roll back the sheet write.
  // The google.script.run path (serverRevokeLink in main.ts) enforces the
  // check BEFORE calling revokeLink, which is the preferred UI path.
  // This doPost path is an additional entry point; scope enforcement here is
  // best-effort since the revoke has already happened.
  if (
    adminUser.role === UserRole.CLUB_ADMIN &&
    result.data &&
    result.data.clubName !== adminUser.clubId
  ) {
    return jsonForbidden(
      `You administer "${adminUser.clubId}" and cannot revoke links for "${result.data.clubName}".`
    );
  }

  return jsonOk(result.data, result.message);
}

/**
 * POST action=list_links
 * Club admin or super admin. Lists upload links with optional filters.
 *
 * Club admins always see only their own club's links regardless of filters.
 * Super admins can filter by eventId and/or clubName, or retrieve all.
 */
export function handleListLinks(
  payload: Record<string, unknown>,
  adminUser: UserRecord
): GoogleAppsScript.Content.TextOutput {
  let links;

  if (adminUser.role === UserRole.CLUB_ADMIN) {
    // Club admins always see only their own club's links
    links = findByClub(adminUser.clubId);
  } else {
    // Super admin: filter by event and/or club if provided
    const eventId  = String(payload['eventId']  ?? '').trim();
    const clubName = String(payload['clubName'] ?? '').trim();

    if (eventId) {
      links = findByEvent(eventId);
      if (clubName) {
        links = links.filter((l) => l.clubName === clubName);
      }
    } else if (clubName) {
      links = findByClub(clubName);
    } else {
      links = listAllLinks();
    }
  }

  return jsonOk({ items: links, total: links.length }, `Found ${links.length} link(s)`);
}

/**
 * POST action=rotate_link
 * Club admin (own club) or super admin (any). Rotates an upload link by
 * revoking the current token and issuing a new one for the same (event, club)
 * pair, with an incremented version number.
 *
 * Required fields: linkId
 * Optional fields: reason
 */
export function handleRotateLink(
  payload: Record<string, unknown>,
  adminUser: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const linkId = String(payload['linkId'] ?? '').trim();
  const reason = String(payload['reason'] ?? '').trim();

  if (!linkId) {
    return jsonError('linkId is required', 400);
  }

  // Scope check: club admins can only rotate their own club's links.
  // We load the existing record first so we know which club it belongs to.
  const all = listAllLinks();
  const existing = all.find((l) => l.linkId === linkId);
  if (!existing) {
    return jsonNotFound(`Link "${linkId}" not found.`);
  }
  if (adminUser.role === UserRole.CLUB_ADMIN && existing.clubName !== adminUser.clubId) {
    return jsonForbidden(
      `You administer "${adminUser.clubId}" and cannot rotate links for "${existing.clubName}".`
    );
  }

  const result = rotateLink(linkId, adminUser.email, reason || 'Rotated');
  if (result.status !== ResultStatus.SUCCESS) {
    return jsonError(result.message, 400);
  }
  return jsonOk(result.data, result.message);
}

// ─── Soft-delete handlers (Phase 7) ──────────────────────────────────────────

/**
 * POST action=delete_file
 * Club admin (own club) or super admin (any club). Soft-deletes a Drive file.
 *
 * Required fields: driveFileId, fileName, eventId, clubName, batchFolderName,
 *                  uploadedBy
 * Optional fields: reason
 */
export function handleDeleteFile(
  payload: Record<string, unknown>,
  adminUser: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const driveFileId     = String(payload['driveFileId']     ?? '').trim();
  const fileName        = String(payload['fileName']        ?? '').trim();
  const eventId         = String(payload['eventId']         ?? '').trim();
  const clubName        = String(payload['clubName']        ?? '').trim();
  const batchFolderName = String(payload['batchFolderName'] ?? '').trim();
  const uploadedBy      = String(payload['uploadedBy']      ?? '').trim();
  const reason          = String(payload['reason']          ?? '').trim();

  if (!driveFileId || !fileName || !eventId || !clubName || !batchFolderName || !uploadedBy) {
    return jsonError('driveFileId, fileName, eventId, clubName, batchFolderName, and uploadedBy are required', 400);
  }

  // Club admins may only delete files within their own club.
  if (adminUser.role === UserRole.CLUB_ADMIN && adminUser.clubId !== clubName) {
    return jsonForbidden(`You administer "${adminUser.clubId}" and cannot delete files for "${clubName}".`);
  }

  const result = softDeleteFile({
    driveFileId, fileName, eventId, clubName, batchFolderName, uploadedBy,
    actorEmail: adminUser.email,
    reason:     reason || undefined,
  });

  if (result.status !== ResultStatus.SUCCESS) {
    return jsonError(result.message, 500);
  }
  return jsonOk({ deleteId: result.deleteId }, result.message);
}

/**
 * POST action=restore_file
 * Club admin (own club) or super admin (any). Restores a soft-deleted file.
 *
 * Required fields: deleteId
 */
export function handleRestoreFile(
  payload: Record<string, unknown>,
  adminUser: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const deleteId = String(payload['deleteId'] ?? '').trim();
  if (!deleteId) {
    return jsonError('deleteId is required', 400);
  }

  // Fetch the record first to enforce club-admin scoping.
  const all = listDeleted({ pageSize: 100000 });
  const record = all.items.find(r => r.deleteId === deleteId);

  if (!record) {
    return jsonNotFound(`Deleted file record not found: ${deleteId}`);
  }
  if (adminUser.role === UserRole.CLUB_ADMIN && adminUser.clubId !== record.clubName) {
    return jsonForbidden(`You administer "${adminUser.clubId}" and cannot restore files for "${record.clubName}".`);
  }

  const result = restoreFile({ deleteId, actorEmail: adminUser.email });
  if (result.status !== ResultStatus.SUCCESS) {
    return jsonError(result.message, result.message.includes('not found') ? 404 : 400);
  }
  return jsonOk(null, result.message);
}

/**
 * GET action=list_deleted
 * Club admin (own club filtered automatically) or super admin (any).
 * Returns a paginated list of soft-deleted files.
 *
 * Optional query params: eventId, clubName (super admin only), status, page, pageSize
 */
export function handleListDeleted(
  payload: Record<string, unknown>,
  adminUser: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const eventId  = String(payload['eventId']  ?? '').trim() || undefined;
  const page     = Math.max(1, Number(payload['page']     ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(payload['pageSize'] ?? 50)));
  const rawStatus = String(payload['status'] ?? '').trim();
  const status = Object.values(DeletedFileStatus).includes(rawStatus as DeletedFileStatus)
    ? rawStatus as DeletedFileStatus
    : undefined;

  // Club admins always see only their own club.
  const clubName = adminUser.role === UserRole.CLUB_ADMIN
    ? adminUser.clubId
    : (String(payload['clubName'] ?? '').trim() || undefined);

  const result = listDeleted({ clubName, eventId, status, page, pageSize });
  return jsonOk(result, `Found ${result.total} deleted file(s)`);
}

/**
 * Fallback for unknown or missing action values.
 */
export function handleUnknownAction(action: string): GoogleAppsScript.Content.TextOutput {
  return jsonNotFound(`Unknown action: "${action}". Check the action parameter.`);
}

/**
 * Returns 403 JSON for routes the authenticated user lacks permission to access.
 */
export function handleForbidden(message: string): GoogleAppsScript.Content.TextOutput {
  return jsonForbidden(message);
}
