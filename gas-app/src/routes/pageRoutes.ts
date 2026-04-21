import { UserRecord } from '../types/models';
import { UserRole } from '../types/enums';
import { getAuditLogs } from '../services/auditLogService';
import { listAll } from '../services/userService';
import { listAll as listAllEvents } from '../services/eventService';
import { listAll as listAllClubs, listActive as listActiveClubs } from '../services/clubService';
import { generateSummary } from '../services/summaryService';
import { listAllAlbums } from '../services/photosService';
import { getCanonicalScriptUrl } from '../utils/scriptUrl';
import { BUILD_TIME } from '../buildInfo';

/* global HtmlService, Session, PropertiesService */

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
  // Inject the deployment URL so client-side navigate() can route correctly.
  // window.top navigation requires the real script.google.com URL, not the
  // googleusercontent.com iframe URL that window.location gives.
  //
  // Use the canonical (non-Workspace) form so that the OAuth redirect_uri is
  // identical for every user regardless of account type — otherwise Workspace
  // users and external Gmail users send different redirect_uris to Google and
  // we'd need both registered on the OAuth client (and they'd mismatch during
  // code→token exchange whenever account context changed between phases).
  Object.assign(template, { scriptUrl: getCanonicalScriptUrl(), ...data });
  return template
    .evaluate()
    .setTitle('湘舍动公益文件系统')
    // MUST be ALLOWALL — not DEFAULT.
    // GAS serves the HTML content in an iframe from googleusercontent.com while
    // the outer wrapper page is on script.google.com (different origins).
    // DEFAULT sets X-Frame-Options: SAMEORIGIN which blocks GAS's own iframe
    // architecture and produces a blank "refused to connect" page.
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ─── Page handlers ────────────────────────────────────────────────────────────

/**
 * Login / welcome page shown to unauthenticated users.
 */
export function loginPage(errorMessage = '', detectedEmail = ''): GoogleAppsScript.HTML.HtmlOutput {
  let effectiveEmail = '';
  let clientId = '';
  try { effectiveEmail = Session.getEffectiveUser().getEmail(); } catch { effectiveEmail = 'error'; }
  try { clientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID') ?? ''; } catch { clientId = ''; }
  return renderTemplate('login', { errorMessage, detectedEmail, effectiveEmail, buildTime: BUILD_TIME, clientId });
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
export function dashboardPage(user: UserRecord, sessionToken = ""): GoogleAppsScript.HTML.HtmlOutput {
  const isAdmin = user.role === UserRole.ADMIN;
  return renderTemplate('dashboard', { sessionToken,
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
export function adminUsersPage(user: UserRecord, sessionToken = ""): GoogleAppsScript.HTML.HtmlOutput {
  const result = listAll(1, 200); // Load first 200 users for initial render
  const activeClubs = listActiveClubs();
  const approvedClubs = activeClubs.map((c) => ({
    display: c.displayName,
    value: c.normalizedName,
  }));
  const roleOptions = Object.values(UserRole).filter((r) => r !== UserRole.API_CLIENT);

  return renderTemplate('admin/users', { sessionToken,
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
export function adminEventsPage(user: UserRecord, sessionToken = ""): GoogleAppsScript.HTML.HtmlOutput {
  const events = listAllEvents(1, 20, 'desc');

  return renderTemplate('admin/events', { sessionToken,
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
export function uploadPage(user: UserRecord, sessionToken = ""): GoogleAppsScript.HTML.HtmlOutput {
  const events = listAllEvents(1, 200, 'desc');
  const activeClubs = listActiveClubs();
  const approvedClubs = activeClubs.map((c) => ({
    display: c.displayName,
    value: c.normalizedName,
  }));

  return renderTemplate('upload', { sessionToken,
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
export function adminClubsPage(user: UserRecord, sessionToken = ""): GoogleAppsScript.HTML.HtmlOutput {
  const result = listAllClubs(1, 100);

  return renderTemplate('admin/clubs', { sessionToken,
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
export function adminSummaryPage(user: UserRecord, sessionToken = ""): GoogleAppsScript.HTML.HtmlOutput {
  // Load initial summary with no date filter
  const summaryResult = generateSummary();
  const hasSummary = summaryResult.data !== undefined;

  return renderTemplate('admin/summary', { sessionToken,
    userEmail: user.email,
    userRole: user.role,
    isAdmin: user.role === UserRole.ADMIN,
    // Pass the initial summary as JSON; null if generation failed
    initialSummary: hasSummary ? JSON.stringify(summaryResult.data) : 'null',
    initialError: hasSummary ? '' : (summaryResult.message ?? 'Failed to load summary'),
  });
}

/**
 * Admin — Photos Overview page (Phase 6).
 *
 * Pre-loads all events and all Photo_Albums records so the page can render
 * the full upload/album matrix immediately without additional round-trips.
 * Admins can trigger a per-event sync or a full backfill from this page.
 *
 * Admin-only; role is enforced at the router level before this is called.
 */
export function adminPhotosPage(user: UserRecord, sessionToken = ""): GoogleAppsScript.HTML.HtmlOutput {
  const events = listAllEvents(1, 200, 'desc');
  const albums = listAllAlbums();

  return renderTemplate('admin/photos', { sessionToken,
    userEmail:    user.email,
    userRole:     user.role,
    isAdmin:      user.role === UserRole.ADMIN,
    events:       JSON.stringify(events.items),
    totalEvents:  events.total,
    albums:       JSON.stringify(albums),
  });
}

/**
 * Drive File System Tree page (all authenticated users).
 *
 * Pre-loads the full event list so the page can render the event list
 * immediately. The Drive hierarchy for each event (clubs → batches → file
 * counts) is loaded on-demand via google.script.run when the user expands
 * an event row — this avoids Drive API calls on every page load.
 */
export function driveTreePage(user: UserRecord, sessionToken = ""): GoogleAppsScript.HTML.HtmlOutput {
  const events = listAllEvents(1, 200, 'desc');

  return renderTemplate('drive_tree', { sessionToken,
    userEmail: user.email,
    userRole:  user.role,
    isAdmin:   user.role === UserRole.ADMIN,
    events:    JSON.stringify(events.items),
  });
}

/**
 * Admin — Audit Log page.
 * Pre-loads the 50 most recent audit entries for instant display.
 * Admin-only; role is enforced at the router level before this is called.
 */
export function adminAuditPage(user: UserRecord, sessionToken = ""): GoogleAppsScript.HTML.HtmlOutput {
  const result = getAuditLogs({ page: 1, pageSize: 50 });
  return renderTemplate('admin/audit', { sessionToken,
    userEmail: user.email,
    userRole:  user.role,
    isAdmin:   user.role === UserRole.ADMIN,
    initialLogs:  result.data ? JSON.stringify(result.data.items)    : '[]',
    initialTotal: result.data ? result.data.total                    : 0,
    initialError: result.data ? '' : (result.message ?? 'Failed to load audit log'),
  });
}
