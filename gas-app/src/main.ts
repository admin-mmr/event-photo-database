/**
 * main.ts — GAS Web App entry points and google.script.run server functions.
 *
 * doGet(e)  → delegates to Router.handleGet (page routing)
 * doPost(e) → delegates to Router.handlePost (JSON API routing)
 *
 * serverXxx functions are exposed to the browser via google.script.run.
 * They all authenticate the caller and enforce admin-only access where needed.
 */

import { ResultStatus, UserRole, UserStatus } from './types/enums';
import { authenticateRequest } from './middleware/authMiddleware';
import { requireRole } from './middleware/roleGuard';
import { handleGet as routerHandleGet, handlePost as routerHandlePost } from './routes/router';
import { createUser, deactivateUser, reactivateUser, updateUser } from './services/userService';

/* global Logger */

// ─── Web App entry points ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function doGet(
  e: GoogleAppsScript.Events.DoGet
): GoogleAppsScript.HTML.HtmlOutput {
  return routerHandleGet(e);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function doPost(
  e: GoogleAppsScript.Events.DoPost
): GoogleAppsScript.Content.TextOutput {
  return routerHandlePost(e);
}

// ─── google.script.run server functions ──────────────────────────────────────

type ServerResponse = { status: string; message: string; data?: unknown; errors?: unknown };

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverCreateUser(
  payload: { email: string; runningClub: string; role: string }
): ServerResponse {
  try {
    const auth = requireAdminOrFail();
    if (!auth.ok) return auth.response;
    const result = createUser(
      { email: payload.email, runningClub: payload.runningClub, role: payload.role as UserRole },
      auth.adminEmail
    );
    return { status: result.status, message: result.message, data: result.data, errors: result.errors };
  } catch (err) {
    Logger.log(`serverCreateUser error: ${String(err)}`);
    return { status: 'error', message: 'Internal error creating user' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverUpdateUser(
  payload: { email: string; runningClub?: string; role?: string; status?: string }
): ServerResponse {
  try {
    const auth = requireAdminOrFail();
    if (!auth.ok) return auth.response;
    const result = updateUser(
      {
        email: payload.email,
        ...(payload.runningClub !== undefined && { runningClub: payload.runningClub }),
        ...(payload.role !== undefined && { role: payload.role as UserRole }),
        ...(payload.status !== undefined && { status: payload.status as UserStatus }),
      },
      auth.adminEmail
    );
    return { status: result.status, message: result.message, data: result.data, errors: result.errors };
  } catch (err) {
    Logger.log(`serverUpdateUser error: ${String(err)}`);
    return { status: 'error', message: 'Internal error updating user' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverDeactivateUser(payload: { email: string }): ServerResponse {
  try {
    const auth = requireAdminOrFail();
    if (!auth.ok) return auth.response;
    const result = deactivateUser(payload.email);
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverDeactivateUser error: ${String(err)}`);
    return { status: 'error', message: 'Internal error deactivating user' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverReactivateUser(payload: { email: string }): ServerResponse {
  try {
    const auth = requireAdminOrFail();
    if (!auth.ok) return auth.response;
    const result = reactivateUser(payload.email);
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverReactivateUser error: ${String(err)}`);
    return { status: 'error', message: 'Internal error reactivating user' };
  }
}

// ─── Internal auth helper ─────────────────────────────────────────────────────

type AdminCheckResult =
  | { ok: true; adminEmail: string }
  | { ok: false; response: ServerResponse };

function requireAdminOrFail(): AdminCheckResult {
  const authResult = authenticateRequest();
  if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
    return { ok: false, response: { status: 'error', message: 'Authentication required' } };
  }
  const guard = requireRole(authResult.data.role, UserRole.ADMIN);
  if (guard.status !== ResultStatus.SUCCESS) {
    return { ok: false, response: { status: 'error', message: guard.message } };
  }
  return { ok: true, adminEmail: authResult.data.email };
}
