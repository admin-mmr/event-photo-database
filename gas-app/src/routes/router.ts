import { ResultStatus, RouteAction, UserRole } from '../types/enums';
import { UserRecord } from '../types/models';
import { authenticateRequest } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleGuard';
import {
  loginPage,
  accessDeniedPage,
  notFoundPage,
  errorPage,
  dashboardPage,
  adminUsersPage,
  adminEventsPage,
} from './pageRoutes';
import {
  handleCreateUser,
  handleUpdateUser,
  handleDeactivateUser,
  handleValidateFolderName,
  handleCreateEvent,
  handleUpdateEvent,
  handleListEvents,
  handleUnknownAction,
  handleForbidden,
} from './apiRoutes';

/* global Logger, ContentService */

/**
 * Router — central dispatcher for doGet and doPost.
 *
 * Pipeline (same for both GET and POST):
 *   1. authenticateRequest() — verify session + resolve UserRecord
 *   2. Route lookup
 *   3. Role check (if the route requires admin)
 *   4. Dispatch to the appropriate page or API handler
 *
 * Errors at any stage return an appropriate page (doGet) or JSON (doPost).
 * All unhandled exceptions are caught here, logged, and surfaced as 500s.
 */

// ─── Route metadata ───────────────────────────────────────────────────────────

interface RouteConfig {
  readonly requiredRole: UserRole | null; // null = any authenticated user
}

const GET_ROUTES: Readonly<Record<string, RouteConfig>> = {
  [RouteAction.DASHBOARD]:    { requiredRole: null },
  [RouteAction.LOGIN]:        { requiredRole: null },
  [RouteAction.ADMIN_USERS]:  { requiredRole: UserRole.ADMIN },
  [RouteAction.ADMIN_EVENTS]: { requiredRole: UserRole.ADMIN },
};

const POST_ROUTES: Readonly<Record<string, RouteConfig>> = {
  [RouteAction.CREATE_USER]:           { requiredRole: UserRole.ADMIN },
  [RouteAction.UPDATE_USER]:           { requiredRole: UserRole.ADMIN },
  [RouteAction.DEACTIVATE_USER]:       { requiredRole: UserRole.ADMIN },
  [RouteAction.VALIDATE_FOLDER_NAME]:  { requiredRole: null },
  [RouteAction.CREATE_EVENT]:          { requiredRole: UserRole.ADMIN },
  [RouteAction.UPDATE_EVENT]:          { requiredRole: UserRole.ADMIN },
  [RouteAction.LIST_EVENTS]:           { requiredRole: null }, // all users can list events
};

// ─── doGet dispatcher ─────────────────────────────────────────────────────────

/**
 * Handles all GET requests. Returns an HtmlOutput.
 * Called from doGet() in main.ts.
 */
export function handleGet(
  e: GoogleAppsScript.Events.DoGet
): GoogleAppsScript.HTML.HtmlOutput {
  try {
    const action = (e.parameter['action'] as RouteAction | undefined) ?? RouteAction.DASHBOARD;

    // Login page doesn't require auth
    if (action === RouteAction.LOGIN) {
      return loginPage();
    }

    // Authenticate
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return loginPage(authResult.message);
    }

    const user = authResult.data;
    const route = GET_ROUTES[action];

    if (!route) {
      return notFoundPage(action);
    }

    // Role check
    if (route.requiredRole) {
      const guard = requireRole(user.role, route.requiredRole);
      if (guard.status !== ResultStatus.SUCCESS) {
        return accessDeniedPage(guard.message);
      }
    }

    return dispatchGetHandler(action, user);
  } catch (err) {
    Logger.log(`[Router.handleGet] Unhandled error: ${String(err)}`);
    return errorPage('An unexpected error occurred. Please try again or contact an administrator.');
  }
}

/**
 * Maps a validated action to its page handler.
 */
function dispatchGetHandler(
  action: RouteAction,
  user: UserRecord
): GoogleAppsScript.HTML.HtmlOutput {
  switch (action) {
    case RouteAction.DASHBOARD:
      return dashboardPage(user);
    case RouteAction.ADMIN_USERS:
      return adminUsersPage(user);
    case RouteAction.ADMIN_EVENTS:
      return adminEventsPage(user);
    default:
      return notFoundPage(action);
  }
}

// ─── doPost dispatcher ────────────────────────────────────────────────────────

/**
 * Handles all POST requests. Returns a JSON TextOutput.
 * Called from doPost() in main.ts.
 */
export function handlePost(
  e: GoogleAppsScript.Events.DoPost
): GoogleAppsScript.Content.TextOutput {
  try {
    const action = e.parameter['action'] as RouteAction | undefined;

    if (!action) {
      return jsonError('Missing required parameter: action', 400);
    }

    // Authenticate
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return jsonError(authResult.message, 403);
    }

    const user = authResult.data;
    const route = POST_ROUTES[action];

    if (!route) {
      return handleUnknownAction(action);
    }

    // Role check
    if (route.requiredRole) {
      const guard = requireRole(user.role, route.requiredRole);
      if (guard.status !== ResultStatus.SUCCESS) {
        return handleForbidden(guard.message);
      }
    }

    // Parse request body
    let payload: Record<string, unknown> = {};
    if (e.postData?.contents) {
      try {
        payload = JSON.parse(e.postData.contents) as Record<string, unknown>;
      } catch {
        return jsonError('Request body must be valid JSON', 400);
      }
    }

    return dispatchPostHandler(action, payload, user);
  } catch (err) {
    Logger.log(`[Router.handlePost] Unhandled error: ${String(err)}`);
    return jsonError('Internal server error', 500);
  }
}

/**
 * Maps a validated action to its API handler.
 */
function dispatchPostHandler(
  action: RouteAction,
  payload: Record<string, unknown>,
  user: UserRecord
): GoogleAppsScript.Content.TextOutput {
  switch (action) {
    case RouteAction.CREATE_USER:
      return handleCreateUser(payload, user);
    case RouteAction.UPDATE_USER:
      return handleUpdateUser(payload, user);
    case RouteAction.DEACTIVATE_USER:
      return handleDeactivateUser(payload, user);
    case RouteAction.VALIDATE_FOLDER_NAME:
      return handleValidateFolderName(payload);
    case RouteAction.CREATE_EVENT:
      return handleCreateEvent(payload, user);
    case RouteAction.UPDATE_EVENT:
      return handleUpdateEvent(payload, user);
    case RouteAction.LIST_EVENTS:
      return handleListEvents(payload);
    default:
      return handleUnknownAction(action);
  }
}

// ─── Internal JSON helper ─────────────────────────────────────────────────────

function jsonError(
  message: string,
  code: number
): GoogleAppsScript.Content.TextOutput {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'error', code, message }))
    .setMimeType(ContentService.MimeType.JSON);
}
