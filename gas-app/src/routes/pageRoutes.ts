import { UserRecord } from '../types/models';
import { UserRole } from '../types/enums';
import { listAll } from '../services/userService';
import { listAll as listAllEvents } from '../services/eventService';
import { listAll as listAllClubs, listActive as listActiveClubs } from '../services/clubService';
import { generateSummary } from '../services/summaryService';

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
  /* global ScriptApp */
  const template = HtmlService.createTemplateFromFile(`ui/templates/${templateName}`);
  // Inject the deployment URL so client-side navigate() can route correctly.
  // window.top navigation requires the real script.google.com URL, not the
  // googleusercontent.com iframe URL that window.location gives.
  Object.assign(template, { scriptUrl: ScriptApp.getService().getUrl(), ...data });
  return template
    .evaluate()
    .setTitle('湘舍动公益文件系统')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
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
  const activeClubs = listActiveClubs();
  const approvedClubs = activeClubs.map((c) => ({
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

/**
 * Upload page — Phase 3 entry point for regular users.
 *
 * Pre-loads the full event list for instant rendering of the event picker.
 * Events are sorted newest-first so the most recent races appear at the top.
 * The club folder tree is loaded on-demand (after event selection) via
 * google.script.run to avoid Drive API calls on every page load.
 *
 * Available to all authenticated users (admins can upload too).
 */
export function uploadPage(user: UserRecord): GoogleAppsScript.HTML.HtmlOutput {
  const events = listAllEvents(1, 200, 'desc');
  const activeClubs = listActiveClubs();
  const approvedClubs = activeClubs.map((c) => ({
    display: c.displayName,
    value: c.normalizedName,
  }));

  return renderTemplate('upload', {
    userEmail: user.email,
    userRole: user.role,
    runningClub: user.runningClub,
    isAdmin: user.role === UserRole.ADMIN,
    events: JSON.stringify(events.items),
    approvedClubs: JSON.stringify(approvedClubs),
  });
}

/**
 * Admin — Club Management page.
 * Lists all clubs (active and inactive) with add/edit/deactivate controls.
 * Clubs are loaded from the Clubs sheet, not the static constant.
 * Admin-only; role is enforced at the router level before this is called.
 */
export function adminClubsPage(user: UserRecord): GoogleAppsScript.HTML.HtmlOutput {
  const result = listAllClubs(1, 100);

  return renderTemplate('admin/clubs', {
    userEmail: user.email,
    userRole: user.role,
    isAdmin: user.role === UserRole.ADMIN,
    clubs: JSON.stringify(result.items),
    totalClubs: result.total,
  });
}

/**
 * Admin — Summary & Reconciliation dashboard (Phase 4).
 *
 * Pre-loads the full system summary on page load (no date filter applied).
 * The admin can then re-run with a date range from the UI, which calls
 * serverGetSummary via google.script.run for a filtered view.
 *
 * Admin-only; role is enforced at the router level before this is called.
 */
export function adminSummaryPage(user: UserRecord): GoogleAppsScript.HTML.HtmlOutput {
  // Load initial summary with no date filter
  const summaryResult = generateSummary();
  const hasSummary = summaryResult.data !== undefined;

  return renderTemplate('admin/summary', {
    userEmail: user.email,
    userRole: user.role,
    isAdmin: user.role === UserRole.ADMIN,
    // Pass the initial summary as JSON; null if generation failed
    initialSummary: hasSummary ? JSON.stringify(summaryResult.data) : 'null',
    initialError: hasSummary ? '' : (summaryResult.message ?? 'Failed to load summary'),
  });
}
