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
import { createEvent, updateEvent, listAll as listAllEvents } from './services/eventService';
import { scanAllViolations } from './services/driveService';

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

// ─── Event server functions ───────────────────────────────────────────────────

/**
 * google.script.run entry point for creating an event from the admin UI.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverCreateEvent(
  payload: { eventName: string; eventDate: string }
): ServerResponse {
  try {
    const auth = requireAdminOrFail();
    if (!auth.ok) return auth.response;

    const result = createEvent(
      { eventName: payload.eventName, eventDate: payload.eventDate },
      auth.adminEmail
    );
    return {
      status: result.status,
      message: result.message,
      data: result.data,
      errors: result.errors,
    };
  } catch (err) {
    Logger.log(`serverCreateEvent error: ${String(err)}`);
    return { status: 'error', message: 'Internal error creating event' };
  }
}

/**
 * google.script.run entry point for updating an event from the admin UI.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverUpdateEvent(
  payload: { eventId: string; eventName?: string; eventDate?: string }
): ServerResponse {
  try {
    const auth = requireAdminOrFail();
    if (!auth.ok) return auth.response;

    const result = updateEvent(
      {
        eventId: payload.eventId,
        ...(payload.eventName !== undefined && { eventName: payload.eventName }),
        ...(payload.eventDate !== undefined && { eventDate: payload.eventDate }),
      },
      auth.adminEmail
    );
    return {
      status: result.status,
      message: result.message,
      data: result.data,
      errors: result.errors,
    };
  } catch (err) {
    Logger.log(`serverUpdateEvent error: ${String(err)}`);
    return { status: 'error', message: 'Internal error updating event' };
  }
}

/**
 * google.script.run entry point for listing events.
 * Available to all authenticated users (needed by Phase 3 upload flow).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverListEvents(
  payload: { page?: number; pageSize?: number; sort?: string; dateFrom?: string; dateTo?: string }
): ServerResponse {
  try {
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const page = payload.page ?? 1;
    const pageSize = Math.min(payload.pageSize ?? 20, 100);
    const sort = (payload.sort === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';

    const result = listAllEvents(page, pageSize, sort);

    // Optional client-side date range filter
    let filtered = result.items as typeof result.items;
    if (payload.dateFrom) {
      filtered = filtered.filter((e) => e.eventDate >= payload.dateFrom!);
    }
    if (payload.dateTo) {
      filtered = filtered.filter((e) => e.eventDate <= payload.dateTo!);
    }

    return {
      status: 'success',
      message: `Found ${filtered.length} event(s)`,
      data: { items: filtered, total: filtered.length, page, pageSize },
    };
  } catch (err) {
    Logger.log(`serverListEvents error: ${String(err)}`);
    return { status: 'error', message: 'Internal error listing events' };
  }
}

/**
 * google.script.run entry point that triggers a full Drive folder scan.
 * Returns all naming violations found across Layer 1 and Layer 2.
 * Called from the admin events page on load (background, non-blocking).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverScanViolations(): ServerResponse {
  try {
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const result = scanAllViolations();
    return {
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (err) {
    Logger.log(`serverScanViolations error: ${String(err)}`);
    return { status: 'error', message: 'Internal error scanning violations' };
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
