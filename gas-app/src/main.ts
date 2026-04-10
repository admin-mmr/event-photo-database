/**
 * main.ts — GAS Web App entry points.
 *
 * doGet(e)  → serves HTML pages (dashboard, login, admin panels)
 * doPost(e) → handles API actions (user CRUD, validation) — returns JSON
 *
 * Both functions follow the same pipeline:
 *   1. Authenticate (session → email)
 *   2. Resolve user (email → UserRecord with role)
 *   3. Check route and role
 *   4. Dispatch to handler
 *
 * Error handling strategy:
 *   - Auth failures → show login/access-denied page (doGet) or 403 JSON (doPost)
 *   - Unknown routes → 404
 *   - Unhandled exceptions → logged to Stackdriver, 500 returned to client
 */

import { ResultStatus, RouteAction } from './types/enums';
import { authenticateRequest } from './middleware/authMiddleware';
import { requireRole } from './middleware/roleGuard';

/* global HtmlService, ContentService, Logger */

// ─── doGet ────────────────────────────────────────────────────────────────────

/**
 * Entry point for all HTTP GET requests to the Web App.
 * Returns an HtmlOutput page appropriate to the user's role and the action param.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function doGet(
  e: GoogleAppsScript.Events.DoGet
): GoogleAppsScript.HTML.HtmlOutput {
  try {
    const action = (e.parameter['action'] as RouteAction | undefined) ?? RouteAction.DASHBOARD;

    // Authenticate
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return renderPage('login', { errorMessage: authResult.message });
    }

    const user = authResult.data;

    // Route dispatch
    switch (action) {
      case RouteAction.DASHBOARD:
        return renderPage('dashboard', { user });

      case RouteAction.ADMIN_USERS: {
        const guard = requireRole(user.role, 'admin' as typeof user.role);
        if (guard.status !== ResultStatus.SUCCESS) {
          return renderPage('access_denied', { message: guard.message });
        }
        return renderPage('admin_users', { user });
      }

      case RouteAction.LOGIN:
        return renderPage('login', { errorMessage: '' });

      default:
        return renderPage('not_found', { action });
    }
  } catch (err) {
    Logger.log(`doGet error: ${String(err)}`);
    return renderPage('error', { message: 'An unexpected error occurred. Please try again.' });
  }
}

// ─── doPost ───────────────────────────────────────────────────────────────────

/**
 * Entry point for all HTTP POST requests to the Web App.
 * Returns a JSON TextOutput using the ApiResponse envelope.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function doPost(
  e: GoogleAppsScript.Events.DoPost
): GoogleAppsScript.Content.TextOutput {
  try {
    const action = e.parameter['action'] as RouteAction | undefined;
    if (!action) {
      return jsonResponse({ status: ResultStatus.ERROR, code: 400, message: 'Missing action parameter' });
    }

    // Authenticate
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return jsonResponse({ status: ResultStatus.ERROR, code: 403, message: authResult.message });
    }

    const user = authResult.data;

    // Parse JSON body if present
    let payload: Record<string, unknown> = {};
    if (e.postData && e.postData.contents) {
      try {
        payload = JSON.parse(e.postData.contents) as Record<string, unknown>;
      } catch {
        return jsonResponse({ status: ResultStatus.ERROR, code: 400, message: 'Invalid JSON body' });
      }
    }

    // Route dispatch (admin-only actions for Phase 1)
    switch (action) {
      case RouteAction.VALIDATE_FOLDER_NAME: {
        // Available to all authenticated users (useful for upload UI validation)
        const { folderName, layer } = payload as { folderName?: string; layer?: number };
        if (!folderName || !layer) {
          return jsonResponse({ status: ResultStatus.ERROR, code: 400, message: 'folderName and layer are required' });
        }
        // Import inline to avoid circular dependency in future refactors
        const { validateFolderName } = require('./utils/folderNameValidator') as typeof import('./utils/folderNameValidator');
        const result = validateFolderName({ folderName, layer: layer as 1 | 2 | 3 });
        return jsonResponse({ status: ResultStatus.SUCCESS, code: 200, message: 'Validation complete', data: result });
      }

      default:
        return jsonResponse({ status: ResultStatus.ERROR, code: 404, message: `Unknown action: ${String(action)}` });
    }
  } catch (err) {
    Logger.log(`doPost error: ${String(err)}`);
    return jsonResponse({ status: ResultStatus.ERROR, code: 500, message: 'Internal server error' });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Renders an HtmlOutput from a template file in src/ui/templates/.
 * templateName maps to the .html file without extension.
 */
function renderPage(
  templateName: string,
  templateData: Record<string, unknown>
): GoogleAppsScript.HTML.HtmlOutput {
  const template = HtmlService.createTemplateFromFile(
    `ui/templates/${templateName}`
  );
  // Inject data into template scope
  Object.assign(template, templateData);
  return template
    .evaluate()
    .setTitle('湘舍动公益文件系统')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DENY);
}

/**
 * Wraps a response object in a JSON TextOutput.
 */
function jsonResponse(response: Record<string, unknown>): GoogleAppsScript.Content.TextOutput {
  return ContentService
    .createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}
