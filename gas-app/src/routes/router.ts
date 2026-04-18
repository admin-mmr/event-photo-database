import { ResultStatus, RouteAction, UserRole } from '../types/enums';
import { UserRecord } from '../types/models';
import { authenticateRequest, getCurrentUser, resolveUser } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleGuard';
import {
  loginPage,
  accessDeniedPage,
  notFoundPage,
  errorPage,
  dashboardPage,
  adminUsersPage,
  adminEventsPage,
  adminClubsPage,
  adminSummaryPage,
  adminAuditPage,
  uploadPage,
} from './pageRoutes';
import {
  handleCreateUser,
  handleUpdateUser,
  handleDeactivateUser,
  handleValidateFolderName,
  handleCreateEvent,
  handleUpdateEvent,
  handleListEvents,
  handleCreateClub,
  handleUpdateClub,
  handleDeactivateClub,
  handleListClubs,
  handleUnknownAction,
  handleForbidden,
} from './apiRoutes';
import {
  handleApiCheckFolder,
  handleApiListFiles,
  handleApiUploadFile,
} from './apiClientHandlers';

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

// Wrapped in functions to avoid GAS file load-order issues:
// clasp pushes alphabetically, so routes/router (r) loads before types/enums (t).
// A module-level const referencing RouteAction/UserRole would read `undefined`.
function getGetRoutes(): Readonly<Record<string, RouteConfig>> {
  return {
    [RouteAction.DASHBOARD]:     { requiredRole: null },
    [RouteAction.LOGIN]:         { requiredRole: null },
    [RouteAction.ADMIN_USERS]:   { requiredRole: UserRole.ADMIN },
    [RouteAction.ADMIN_EVENTS]:  { requiredRole: UserRole.ADMIN },
    [RouteAction.ADMIN_CLUBS]:   { requiredRole: UserRole.ADMIN },
    [RouteAction.ADMIN_SUMMARY]: { requiredRole: UserRole.ADMIN },
    [RouteAction.ADMIN_AUDIT]:   { requiredRole: UserRole.ADMIN },
    [RouteAction.UPLOAD]:        { requiredRole: null }, // all authenticated users
  };
}

function getPostRoutes(): Readonly<Record<string, RouteConfig>> {
  return {
    [RouteAction.CREATE_USER]:           { requiredRole: UserRole.ADMIN },
    [RouteAction.UPDATE_USER]:           { requiredRole: UserRole.ADMIN },
    [RouteAction.DEACTIVATE_USER]:       { requiredRole: UserRole.ADMIN },
    [RouteAction.VALIDATE_FOLDER_NAME]:  { requiredRole: null },
    [RouteAction.CREATE_EVENT]:          { requiredRole: UserRole.ADMIN },
    [RouteAction.UPDATE_EVENT]:          { requiredRole: UserRole.ADMIN },
    [RouteAction.LIST_EVENTS]:           { requiredRole: null }, // all users can list events
    [RouteAction.CREATE_CLUB]:           { requiredRole: UserRole.ADMIN },
    [RouteAction.UPDATE_CLUB]:           { requiredRole: UserRole.ADMIN },
    [RouteAction.DEACTIVATE_CLUB]:       { requiredRole: UserRole.ADMIN },
    [RouteAction.LIST_CLUBS]:            { requiredRole: null }, // all authenticated users
  };
}

// ─── doGet dispatcher ─────────────────────────────────────────────────────────

/**
 * Handles all GET requests. Returns an HtmlOutput (browser) or TextOutput (API).
 * Called from doGet() in main.ts.
 *
 * Phase 5: if an `api_key` query parameter is present the request is treated
 * as a machine-to-machine API call and routed through the API client handlers,
 * bypassing the GAS session auth flow entirely.
 */
export function handleGet(
  e: GoogleAppsScript.Events.DoGet
): GoogleAppsScript.HTML.HtmlOutput | GoogleAppsScript.Content.TextOutput {
  try {
    const action = (e.parameter['action'] as RouteAction | undefined) ?? RouteAction.DASHBOARD;
    const params = e.parameter as Record<string, string>;
    Logger.log(`[Router.handleGet] action="${action}" params=${JSON.stringify(params)}`);

    // ── Phase 5: API client requests (machine-to-machine) ─────────────────────
    if (params['api_key']) {
      Logger.log(`[Router.handleGet] API key present — routing to API handler`);
      return dispatchApiGetHandler(action, params);
    }

    // ── Standard browser request ──────────────────────────────────────────────

    // Login page doesn't require auth
    if (action === RouteAction.LOGIN) {
      Logger.log(`[Router.handleGet] Serving login page (no auth required)`);
      return loginPage();
    }

    // Healthcheck — deployment diagnostic, no auth required.
    // Visit ?action=healthcheck immediately after any deploy to verify
    // session detection, deployment URL, and execution context.
    if (action === RouteAction.HEALTHCHECK) {
      Logger.log(`[Router.handleGet] Serving healthcheck`);
      return healthcheckPage(e);
    }

    // Authenticate — split into two steps so we can pass the detected email
    // to the login page even when the user isn't registered in the Users sheet.
    Logger.log(`[Router.handleGet] Authenticating request…`);
    const sessionResult = getCurrentUser();
    const detectedEmail = sessionResult.data?.email ?? '';
    Logger.log(`[Router.handleGet] Session email: "${detectedEmail}"`);

    const authResult = detectedEmail
      ? resolveUser(detectedEmail)
      : sessionResult as typeof authResult;
    Logger.log(`[Router.handleGet] Auth result: status=${authResult.status} message="${authResult.message}" role=${authResult.data?.role ?? 'n/a'}`);

    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      Logger.log(`[Router.handleGet] Auth failed — redirecting to login`);
      return loginPage(authResult.message, detectedEmail);
    }

    const user = authResult.data;
    const route = getGetRoutes()[action];
    Logger.log(`[Router.handleGet] Route lookup for "${action}": ${route ? `requiredRole=${String(route.requiredRole)}` : 'NOT FOUND'}`);

    if (!route) {
      Logger.log(`[Router.handleGet] Unknown action "${action}" — returning 404`);
      return notFoundPage(action);
    }

    // Role check
    if (route.requiredRole) {
      const guard = requireRole(user.role, route.requiredRole);
      Logger.log(`[Router.handleGet] Role check: userRole=${user.role} required=${route.requiredRole} result=${guard.status} msg="${guard.message}"`);
      if (guard.status !== ResultStatus.SUCCESS) {
        Logger.log(`[Router.handleGet] Role check failed — returning access denied`);
        return accessDeniedPage(guard.message);
      }
    }

    Logger.log(`[Router.handleGet] Dispatching to handler for action="${action}"`);
    return dispatchGetHandler(action, user);
  } catch (err) {
    Logger.log(`[Router.handleGet] Unhandled error: ${String(err)}`);
    return errorPage('An unexpected error occurred. Please try again or contact an administrator.');
  }
}

/**
 * Routes Phase 5 API GET requests (authenticated via api_key param).
 * Returns a JSON TextOutput in all cases — never HTML.
 */
function dispatchApiGetHandler(
  action: RouteAction,
  params: Record<string, string>
): GoogleAppsScript.Content.TextOutput {
  switch (action) {
    case RouteAction.API_CHECK_FOLDER:
      return handleApiCheckFolder(params);
    case RouteAction.API_LIST_FILES:
      return handleApiListFiles(params);
    default:
      return ContentService
        .createTextOutput(JSON.stringify({
          status: 'error', code: 404,
          message: `Unknown API action: "${action}"`,
        }))
        .setMimeType(ContentService.MimeType.JSON);
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
    case RouteAction.ADMIN_CLUBS:
      return adminClubsPage(user);
    case RouteAction.ADMIN_SUMMARY:
      return adminSummaryPage(user);
    case RouteAction.ADMIN_AUDIT:
      return adminAuditPage(user);
    case RouteAction.UPLOAD:
      return uploadPage(user);
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
    Logger.log(`[Router.handlePost] action="${String(action)}"`);

    if (!action) {
      Logger.log(`[Router.handlePost] Missing action parameter`);
      return jsonError('Missing required parameter: action', 400);
    }

    // Authenticate
    Logger.log(`[Router.handlePost] Authenticating request…`);
    const authResult = authenticateRequest();
    Logger.log(`[Router.handlePost] Auth result: status=${authResult.status} email=${authResult.data?.email ?? 'n/a'} role=${authResult.data?.role ?? 'n/a'}`);

    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      Logger.log(`[Router.handlePost] Auth failed: ${authResult.message}`);
      return jsonError(authResult.message, 403);
    }

    const user = authResult.data;
    const route = getPostRoutes()[action];
    Logger.log(`[Router.handlePost] Route lookup for "${action}": ${route ? `requiredRole=${String(route.requiredRole)}` : 'NOT FOUND'}`);

    if (!route) {
      Logger.log(`[Router.handlePost] Unknown action "${action}"`);
      return handleUnknownAction(action);
    }

    // Role check
    if (route.requiredRole) {
      const guard = requireRole(user.role, route.requiredRole);
      Logger.log(`[Router.handlePost] Role check: userRole=${user.role} required=${route.requiredRole} result=${guard.status}`);
      if (guard.status !== ResultStatus.SUCCESS) {
        Logger.log(`[Router.handlePost] Role check failed: ${guard.message}`);
        return handleForbidden(guard.message);
      }
    }

    // Parse request body
    let payload: Record<string, unknown> = {};
    if (e.postData?.contents) {
      try {
        payload = JSON.parse(e.postData.contents) as Record<string, unknown>;
        Logger.log(`[Router.handlePost] Parsed payload keys: ${Object.keys(payload).join(', ')}`);
      } catch {
        Logger.log(`[Router.handlePost] Failed to parse request body`);
        return jsonError('Request body must be valid JSON', 400);
      }
    }

    Logger.log(`[Router.handlePost] Dispatching to handler for action="${action}"`);
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
    case RouteAction.CREATE_CLUB:
      return handleCreateClub(payload, user);
    case RouteAction.UPDATE_CLUB:
      return handleUpdateClub(payload, user);
    case RouteAction.DEACTIVATE_CLUB:
      return handleDeactivateClub(payload, user);
    case RouteAction.LIST_CLUBS:
      return handleListClubs(payload);
    case RouteAction.API_UPLOAD_FILE:
      // Phase 5: API upload; auth is inside the handler (api_key in body)
      return handleApiUploadFile(payload);
    default:
      return handleUnknownAction(action);
  }
}

// ─── Healthcheck page ─────────────────────────────────────────────────────────

/**
 * Deployment diagnostic page — visit ?action=healthcheck right after any deploy.
 *
 * Reports without requiring a registered user account:
 *   - Session email detected (or empty — means OAuth flow not completed)
 *   - Deployment URL (confirms the right version is live)
 *   - Execution timestamp
 *   - Query parameters received (useful for routing debugging)
 *
 * This catches the two most common post-deploy issues before real testing:
 *   1. Blank page / X-Frame-Options error  → page loads = framing is fine
 *   2. Session email empty                 → OAuth not yet authorized
 */
function healthcheckPage(
  e: GoogleAppsScript.Events.DoGet
): GoogleAppsScript.HTML.HtmlOutput {
  /* global ScriptApp, Session */
  let sessionEmail = '';
  let sessionError = '';
  try {
    sessionEmail = Session.getActiveUser().getEmail() || '';
  } catch (err) {
    sessionError = String(err);
  }

  const deployUrl = ScriptApp.getService().getUrl();
  const timestamp = new Date().toISOString();
  const params = JSON.stringify(e.parameter, null, 2);

  const ok = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px;color:#555;">${label}</td>` +
    `<td style="padding:6px 12px;font-family:monospace;color:#1b5e20;font-weight:bold;">${value}</td></tr>`;
  const warn = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px;color:#555;">${label}</td>` +
    `<td style="padding:6px 12px;font-family:monospace;color:#b71c1c;font-weight:bold;">${value}</td></tr>`;

  const rows = [
    sessionEmail
      ? ok('Session email', sessionEmail)
      : warn('Session email', sessionError ? `ERROR: ${sessionError}` : '(empty — OAuth not completed)'),
    ok('Deployment URL', deployUrl),
    ok('Timestamp', timestamp),
    ok('Query params', `<pre style="margin:0;">${params}</pre>`),
  ].join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Healthcheck</title>
    <style>body{font-family:sans-serif;padding:32px;background:#f5f5f5;}
    .card{background:#fff;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.12);
          padding:24px;max-width:700px;margin:0 auto;}
    h2{margin:0 0 16px;color:#333;}
    table{border-collapse:collapse;width:100%;}
    td{border-bottom:1px solid #eee;vertical-align:top;}
    .badge{display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;}
    .ok{background:#e8f5e9;color:#2e7d32;} .fail{background:#ffebee;color:#c62828;}
    </style></head><body><div class="card">
    <h2>🩺 Deployment Healthcheck</h2>
    <span class="badge ${sessionEmail ? 'ok' : 'fail'}">${sessionEmail ? '✓ Session OK' : '✗ No session'}</span>
    <table style="margin-top:16px;">${rows}</table>
    <p style="margin-top:20px;font-size:12px;color:#aaa;">
      This page is public (no login required). Remove or restrict it before going to production.
    </p></div></body></html>`;

  return HtmlService.createHtmlOutput(html)
    .setTitle('Healthcheck')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
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
