import { UserRecord } from '../types/models';
import { UserRole } from '../types/enums';
import { getConfig, APPROVED_CLUBS } from '../config/constants';
import { listAll } from '../services/userService';
import { listAll as listAllEvents } from '../services/eventService';

/* global HtmlService */

/**
 * PageRoutes — handlers that return HtmlOutput for doGet routes.
 *
 * Each function creates a GAS HTML template, injects data into its scope,
 * evaluates it, and returns a fully-rendered HtmlOutput.
 *
 * Template naming convention:
 *   src/ui/templates/<name>.html  → templatePath('templates/<name>')
 *   src/ui/templates/admin/<name>.html → templatePath('templates/admin/<name>')
 *
 * The include() helper (defined in app.html) pulls in CSS/JS partials.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderTemplate(
  templateName: string,
  data: Record<string, unknown>
): GoogleAppsScript.HTML.HtmlOutput {
  const template = HtmlService.createTemplateFromFile(`ui/templates/${templateName}`);
  Object.assign(template, data);
  return template
    .evaluate()
    .setTitle('湘舍动公益文件系统')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DENY);
}

// ─── Page handlers ────────────────────────────────────────────────────────────

/**
 * Login / welcome page shown to unauthenticated users.
 */
export function loginPage(errorMessage = ''): GoogleAppsScript.HTML.HtmlOutput {
  return renderTemplate('login', { errorMessage });
}

/**
 * Access denied page — shown when a user lacks the required role.
 */
export function accessDeniedPage(message: string): GoogleAppsScript.HTML.HtmlOutput {
  return renderTemplate('access_denied', { message });
}

/**
 * Generic 404 page for unknown route actions.
 */
export function notFoundPage(action: string): GoogleAppsScript.HTML.HtmlOutput {
  return renderTemplate('not_found', { action });
}

/**
 * Generic 500 error page.
 */
export function errorPage(message: string): GoogleAppsScript.HTML.HtmlOutput {
  return renderTemplate('error', { message });
}

/**
 * Dashboard — the landing page after login.
 * Shows a role-appropriate summary: admin sees management links,
 * regular users see their club and the upload interface.
 */
export function dashboardPage(user: UserRecord): GoogleAppsScript.HTML.HtmlOutput {
  const isAdmin = user.role === UserRole.ADMIN;
  return renderTemplate('dashboard', {
    userEmail: user.email,
    userRole: user.role,
    runningClub: user.runningClub,
    isAdmin,
  });
}

/**
 * Admin — User Management page.
 * Lists all users with add/edit/deactivate controls.
 * Admin-only; role is enforced at the router level before this is called.
 */
export function adminUsersPage(user: UserRecord): GoogleAppsScript.HTML.HtmlOutput {
  const result = listAll(1, 200); // Load first 200 users for initial render
  const approvedClubs = APPROVED_CLUBS.map((c) => ({
    display: c.displayName,
    value: c.normalizedName,
  }));
  const roleOptions = Object.values(UserRole).filter((r) => r !== UserRole.API_CLIENT);

  return renderTemplate('admin/users', {
    userEmail: user.email,
    users: result.items,
    total: result.total,
    approvedClubs,
    roleOptions,
  });
}

/**
 * Admin — Event Management page.
 * Pre-loads the first page of events for instant display.
 * Subsequent interactions (create, filter, paginate) use google.script.run.
 * Admin-only; role is enforced at the router level before this is called.
 */
export function adminEventsPage(user: UserRecord): GoogleAppsScript.HTML.HtmlOutput {
  const events = listAllEvents(1, 20, 'desc');

  return renderTemplate('admin/events', {
    userEmail: user.email,
    userRole: user.role,
    isAdmin: user.role === UserRole.ADMIN,
    events: JSON.stringify(events.items),
    totalEvents: events.total,
  });
}
