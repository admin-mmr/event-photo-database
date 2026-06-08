import { UserRecord } from '../types/models';
import { UserRole } from '../types/enums';
import { isAdmin, isSuperAdmin } from '../middleware/roleGuard';
import { getAuditLogs } from '../services/auditLogService';
import { listAll } from '../services/userService';
import { listAll as listAllEvents } from '../services/eventService';
import { listAll as listAllClubs, listActive as listActiveClubs } from '../services/clubService';
import { generateSummary } from '../services/summaryService';
import { getPublicSpreadsheetUrl } from '../services/publicSpreadsheetService';
import { getPreferencesFor } from '../services/emailPreferenceService';
import { findByClub } from '../services/uploadLinkService';
import { getCanonicalScriptUrl } from '../utils/scriptUrl';
import { safeJsonForScript } from '../utils/safeJson';
import { isCreditRenameEnabled } from '../config/constants';
import { BUILD_TIME, BUILD_COMMIT } from '../buildInfo';
/* global HtmlService, PropertiesService */

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
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    // Apply viewport meta tag on the OUTER script.google.com wrapper page so
    // mobile browsers render at device width instead of the default ~980px
    // desktop fallback. The <meta name="viewport"> in our own templates only
    // affects the inner googleusercontent.com iframe — without this call the
    // outer page stays at desktop width and the inner iframe gets squeezed,
    // forcing users to pinch-zoom to read the login card. This is the canonical
    // Apps Script mobile fix and has no effect outside of mobile viewports.
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ─── Page handlers ────────────────────────────────────────────────────────────

/**
 * Login / welcome page shown to unauthenticated users.
 *
 * Build stamp: the commit hash + build timestamp are NOT exposed to
 * unauthenticated visitors by default. Admins can opt in by setting the
 * SHOW_LOGIN_BUILD_STAMP Script Property to 'true' when actively verifying
 * a deployment from the public login URL; otherwise we leak nothing
 * useful (and the same info is always available to admins via the
 * ?action=healthcheck page and via the build-stamp-header badge on every
 * authenticated page).
 */
export function loginPage(errorMessage = ''): GoogleAppsScript.HTML.HtmlOutput {
  let clientId = '';
  try {
    const props = PropertiesService.getScriptProperties();
    clientId = props.getProperty('GOOGLE_CLIENT_ID') ?? '';
  } catch {
    clientId = '';
  }
  return renderTemplate('login', {
    errorMessage,
    clientId,
    // Always show the build stamp on the login card so admins can verify
    // which deployment version is live without needing to sign in.
    buildTime:   BUILD_TIME,
    buildCommit: BUILD_COMMIT,
    // Public folder index — when configured, the login page links straight to
    // the published spreadsheet so visitors can browse without signing in.
    publicSpreadsheetUrl: getPublicSpreadsheetUrl(),
  });
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
  return renderTemplate('dashboard', { sessionToken,
    userEmail:    user.email,
    userRole:     user.role,
    clubId:       user.clubId,
    isAdmin:      isAdmin(user.role),
    isSuperAdmin: isSuperAdmin(user.role),
    runningClub:  isSuperAdmin(user.role) ? '' : (user.clubId ?? ''),
    // Public folder index URL — empty string when the feature is unconfigured;
    // the dashboard template hides the "Browse public folder list" card in that
    // case so we never show a broken link.
    publicSpreadsheetUrl: getPublicSpreadsheetUrl(),
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
  const roleOptions = Object.values(UserRole);

  return renderTemplate('admin/users', { sessionToken,
    userEmail:    user.email,
    userRole:     user.role,
    userClubId:   user.clubId ?? '',
    isSuperAdmin: isSuperAdmin(user.role),
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
    userEmail:    user.email,
    userRole:     user.role,
    isAdmin:      isAdmin(user.role),
    isSuperAdmin: isSuperAdmin(user.role),
    events:       safeJsonForScript(events.items),
    totalEvents:  events.total,
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

  // Super admins have no fixed club — they must select one from approvedClubs.
  // Club admins are bound to their assigned club.
  const runningClub = isSuperAdmin(user.role) ? '' : (user.clubId ?? '');

  // Photographer display name: "First Last" if both are set, else the email
  // local-part. Used as the second component of the credited filename
  // (see utils/creditedFileName.ts). The client also receives the email so
  // it can fall back if the lookup yielded an empty display name.
  const photographerDisplayName = [user.firstName, user.lastName]
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(' ');

  return renderTemplate('upload', { sessionToken,
    userEmail:     user.email,
    userRole:      user.role,
    clubId:        user.clubId,
    isAdmin:       isAdmin(user.role),
    isSuperAdmin:  isSuperAdmin(user.role),
    runningClub,
    events:        safeJsonForScript(events.items),
    approvedClubs: safeJsonForScript(approvedClubs),
    photographerDisplayName,
    creditRenameEnabled: isCreditRenameEnabled(),
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
    userEmail:  user.email,
    userRole:   user.role,
    isAdmin:    isAdmin(user.role),
    clubs:      safeJsonForScript(result.items),
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
    userEmail:      user.email,
    userRole:       user.role,
    isAdmin:        isAdmin(user.role),
    isSuperAdmin:   isSuperAdmin(user.role),
    // Pass the initial summary as JSON; null if generation failed
    initialSummary: hasSummary ? safeJsonForScript(summaryResult.data) : 'null',
    initialError:   hasSummary ? '' : (summaryResult.message ?? 'Failed to load summary'),
  });
}

/**
 * Public Sheet page — manual refresh + folder-rebuild controls.
 *
 * Open to every authenticated user (no role gate at the router level). The
 * page exposes three buttons, each backed by a server action:
 *   • Refresh PUBLIC SHEET       → serverRefreshPublicSheet
 *   • Rebuild Photos_NNN folders → serverRebuildPhotoFolders
 *   • Rebuild Videos folders     → serverRebuildVideoFolders
 *
 * The sheet auto-refreshes after every successful upload (best-effort hook)
 * and on a 30-minute scheduled trigger; this page is the manual escape hatch
 * for the (rare) case where both of those fail or where someone wants an
 * immediate refresh without waiting for the trigger to fire.
 */
export function publicSheetPage(user: UserRecord, sessionToken = ''): GoogleAppsScript.HTML.HtmlOutput {
  return renderTemplate('public_sheet', {
    sessionToken,
    userEmail:            user.email,
    userRole:             user.role,
    isAdmin:              isAdmin(user.role),
    isSuperAdmin:         isSuperAdmin(user.role),
    publicSpreadsheetUrl: getPublicSpreadsheetUrl(),
  });
}

/**
 * Duplicate Cleanup page (admins; club admins see only their club's results).
 *
 * Pre-loads the event list for the scan dropdown. The scan itself runs via
 * serverScanDuplicateFiles and the confirmed deletions via
 * serverTrashDuplicateFiles (see routes/duplicateHandlers.ts). Nothing is
 * ever deleted without explicit review — the page renders the proposed
 * keep/delete pairs with checkboxes first.
 */
export function duplicatesPage(user: UserRecord, sessionToken = ''): GoogleAppsScript.HTML.HtmlOutput {
  const events = listAllEvents(1, 200, 'desc');
  return renderTemplate('duplicates', {
    sessionToken,
    userEmail:    user.email,
    userRole:     user.role,
    clubId:       user.clubId ?? '',
    isAdmin:      isAdmin(user.role),
    isSuperAdmin: isSuperAdmin(user.role),
    events:       safeJsonForScript(events.items),
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
    userEmail:   user.email,
    userRole:    user.role,
    clubId:      user.clubId ?? '',
    isAdmin:     isAdmin(user.role),
    isSuperAdmin: isSuperAdmin(user.role),
    events:      safeJsonForScript(events.items),
  });
}

/**
 * Admin — Email Preferences page (Phase 7).
 *
 * Pre-loads the calling admin's own preferences so the toggles render in
 * their saved state. Saves go through serverUpdateMyEmailPrefs via
 * google.script.run on form submit.
 *
 * Admin-only; role is enforced at the router level before this is called.
 */
export function adminEmailPrefsPage(user: UserRecord, sessionToken = ''): GoogleAppsScript.HTML.HtmlOutput {
  const prefs = getPreferencesFor(user.email);
  return renderTemplate('admin/email_prefs', {
    sessionToken,
    userEmail:    user.email,
    userRole:     user.role,
    isAdmin:      isAdmin(user.role),
    isSuperAdmin: isSuperAdmin(user.role),
    prefs:        safeJsonForScript(prefs),
  });
}

/**
 * Admin — Audit Log page.
 *
 * Pre-loads the last 7 days of audit entries so the page reflects its
 * default filter from the first paint (no flash of un-filtered content).
 * The same defaults are passed to the template so the date inputs render
 * pre-populated and the "7d" quick-range chip starts in the selected state.
 *
 * Admin-only; role is enforced at the router level before this is called.
 */
export function adminAuditPage(user: UserRecord, sessionToken = ""): GoogleAppsScript.HTML.HtmlOutput {
  // Default range: last 7 days, ending today. Inclusive on both ends —
  // matches how getAuditLogs() interprets dateFrom/dateTo.
  const today = new Date();
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
  const defaultDateFrom = isoDate(sevenDaysAgo);
  const defaultDateTo   = isoDate(today);

  const result = getAuditLogs({
    page:     1,
    pageSize: 50,
    dateFrom: defaultDateFrom,
    dateTo:   defaultDateTo,
  });
  return renderTemplate('admin/audit', { sessionToken,
    userEmail:    user.email,
    userRole:     user.role,
    isAdmin:      isAdmin(user.role),
    isSuperAdmin: isSuperAdmin(user.role),
    initialLogs:  result.data ? safeJsonForScript(result.data.items) : '[]',
    initialTotal: result.data ? result.data.total                 : 0,
    initialError: result.data ? '' : (result.message ?? 'Failed to load audit log'),
    defaultDateFrom,
    defaultDateTo,
  });
}

/**
 * Admin — Upload Link Management page.
 *
 * Pre-loads all events for the selectors and, for club admins, pre-loads
 * their club's existing links so the page renders useful data immediately.
 * Super admins start with an empty list and filter by event/club on demand.
 *
 * Club admins can only view/manage links for their own club.
 * Super admins can view and manage any club's links.
 *
 * Admin-only; role is enforced at the router level before this is called.
 */
export function adminLinksPage(user: UserRecord, sessionToken = "", preselectEventId = ""): GoogleAppsScript.HTML.HtmlOutput {
  const events = listAllEvents(1, 200, 'desc');
  const activeClubs = listActiveClubs();

  // Pre-load the calling club admin's own links so the page is immediately
  // useful. Super admins start empty and filter on demand.
  let initialLinks: unknown[] = [];
  if (user.clubId) {
    initialLinks = findByClub(user.clubId);
  }

  return renderTemplate('admin/links', { sessionToken,
    userEmail:    user.email,
    userRole:     user.role,
    clubId:       user.clubId,
    isAdmin:      isAdmin(user.role),
    isSuperAdmin: isSuperAdmin(user.role),
    events:       safeJsonForScript(events.items),
    clubs:        safeJsonForScript(activeClubs),
    initialLinks: safeJsonForScript(initialLinks),
    preselectEventId: preselectEventId || '',
  });
}
