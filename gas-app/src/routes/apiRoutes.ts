import { ResultStatus, RouteAction } from '../types/enums';
import { UserRecord } from '../types/models';
import { ServiceResult } from '../types/responses';
import {
  validateCreateUserPayload,
  validateUpdateUserPayload,
  validateFolderNamePayload,
  validateCreateEventPayload,
  validateUpdateEventPayload,
  sanitizePayload,
} from '../middleware/inputValidator';
import { createUser, updateUser, deactivateUser, reactivateUser, findByEmail } from '../services/userService';
import { createEvent, updateEvent, listAll as listAllEvents } from '../services/eventService';
import { validateFolderName } from '../utils/folderNameValidator';

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
    .createTextOutput(JSON.stringify({ status: 'error', code, message, ...(errors && { errors }) }))
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
