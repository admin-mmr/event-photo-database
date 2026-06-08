import { ResultStatus, RouteAction, UserRole } from '../types/enums';
import { UserRecord } from '../types/models';
import { authenticateRequest, authenticateBySession, getCurrentUser, resolveUser } from '../middleware/authMiddleware';
import { exchangeOAuthCode } from '../services/tokenService';
import { createSession } from '../services/sessionService';
import { recordLogin } from '../services/userService';
import { requireRole } from '../middleware/roleGuard';
import { getCanonicalScriptUrl } from '../utils/scriptUrl';
import { notifySecurityEvent } from '../services/emailService';
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
  adminEmailPrefsPage,
  adminLinksPage,
  driveTreePage,
  uploadPage,
  publicSheetPage,
  duplicatesPage,
} from './pageRoutes';
import {
  volunteerConfirmPage,
  volunteerUploadPage,
  linkErrorPage,
  handleVolunteerOAuthCallback,
} from './volunteerRoutes';
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
  handleGenerateLink,
  handleRevokeLink,
  handleRotateLink,
  handleListLinks,
  handleDeleteFile,
  handleRestoreFile,
  handleListDeleted,
  handleLogout,
  handleUnknownAction,
  handleForbidden,
} from './apiRoutes';

/* global Logger, ContentService, Utilities */

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
    [RouteAction.ADMIN_USERS]:   { requiredRole: UserRole.CLUB_ADMIN },
    [RouteAction.ADMIN_EVENTS]:  { requiredRole: UserRole.CLUB_ADMIN },
    [RouteAction.ADMIN_CLUBS]:   { requiredRole: UserRole.SUPER_ADMIN },
    [RouteAction.ADMIN_SUMMARY]: { requiredRole: UserRole.CLUB_ADMIN },
    [RouteAction.ADMIN_AUDIT]:   { requiredRole: UserRole.CLUB_ADMIN },
    [RouteAction.ADMIN_EMAIL_PREFS]: { requiredRole: UserRole.CLUB_ADMIN },
    [RouteAction.ADMIN_LINKS]:   { requiredRole: UserRole.CLUB_ADMIN },
    [RouteAction.DRIVE_TREE]:    { requiredRole: null }, // all authenticated users
    [RouteAction.UPLOAD]:        { requiredRole: null }, // all authenticated users
    [RouteAction.PUBLIC_SHEET]:  { requiredRole: null }, // all authenticated users
    [RouteAction.DUPLICATES]:    { requiredRole: UserRole.CLUB_ADMIN }, // admins; club-scoping inside handlers
  };
}

function getPostRoutes(): Readonly<Record<string, RouteConfig>> {
  return {
    [RouteAction.CREATE_USER]:           { requiredRole: UserRole.SUPER_ADMIN },
    [RouteAction.UPDATE_USER]:           { requiredRole: UserRole.SUPER_ADMIN },
    [RouteAction.DEACTIVATE_USER]:       { requiredRole: UserRole.SUPER_ADMIN },
    [RouteAction.VALIDATE_FOLDER_NAME]:  { requiredRole: null },
    [RouteAction.CREATE_EVENT]:          { requiredRole: UserRole.CLUB_ADMIN },
    [RouteAction.UPDATE_EVENT]:          { requiredRole: UserRole.CLUB_ADMIN },
    [RouteAction.LIST_EVENTS]:           { requiredRole: null }, // all authenticated users can list events
    [RouteAction.CREATE_CLUB]:           { requiredRole: UserRole.SUPER_ADMIN },
    [RouteAction.UPDATE_CLUB]:           { requiredRole: UserRole.SUPER_ADMIN },
    [RouteAction.DEACTIVATE_CLUB]:       { requiredRole: UserRole.SUPER_ADMIN },
    [RouteAction.LIST_CLUBS]:            { requiredRole: null }, // all authenticated users
    [RouteAction.LOGOUT]:                { requiredRole: null }, // all authenticated users
    [RouteAction.GENERATE_LINK]:         { requiredRole: UserRole.CLUB_ADMIN },
    [RouteAction.REVOKE_LINK]:           { requiredRole: UserRole.CLUB_ADMIN },
    [RouteAction.ROTATE_LINK]:           { requiredRole: UserRole.CLUB_ADMIN },
    [RouteAction.LIST_LINKS]:            { requiredRole: UserRole.CLUB_ADMIN },
    [RouteAction.DELETE_FILE]:           { requiredRole: UserRole.CLUB_ADMIN },
    [RouteAction.RESTORE_FILE]:          { requiredRole: UserRole.CLUB_ADMIN },
    [RouteAction.LIST_DELETED]:          { requiredRole: UserRole.CLUB_ADMIN },
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

    // ── Volunteer upload link — pre-login confirmation page ───────────────────
    // ?action=upload_link&token=XYZ  (or just ?token=XYZ)
    // Served BEFORE authentication — this page is intentionally public.
    // The volunteer sees the event + club name and the consent line, then
    // clicks "Sign in with Google" which initiates OAuth with state=volunteer:TOKEN.
    if (action === RouteAction.UPLOAD_LINK || (params['token'] && !params['code'])) {
      const token = params['token'] ?? '';
      Logger.log(`[Router.handleGet] Volunteer confirm page — token present: ${!!token}`);
      if (!token) {
        return linkErrorPage('No upload token was provided. Please use the full upload link.', false);
      }
      return volunteerConfirmPage(token);
    }

    // ── Volunteer OAuth callback ───────────────────────────────────────────────
    // Google redirects here with ?code=XXX&state=volunteer:TOKEN(:NAME_B64URL)?
    // after the volunteer approves sign-in on the confirm page.
    //
    // The state may carry an optional third segment: base64url-encoded
    // photographer name (typed on the confirm page). When present, it is
    // threaded through to the volunteer session so every file the volunteer
    // uploads is renamed to <Club>_<Name>_<original>. Decoding failures
    // (truncated state, malformed base64) degrade gracefully to "no name" —
    // the rename then falls back to the email local-part.
    if (params['code'] && params['state']?.startsWith('volunteer:')) {
      const rest = params['state'].substring('volunteer:'.length);
      const colon = rest.indexOf(':');
      const linkToken = colon < 0 ? rest : rest.substring(0, colon);
      let photographerName = '';
      if (colon >= 0) {
        try {
          const b64 = rest.substring(colon + 1).replace(/-/g, '+').replace(/_/g, '/');
          const bytes = Utilities.base64Decode(b64);
          photographerName = Utilities.newBlob(bytes).getDataAsString('UTF-8');
        } catch (decErr) {
          Logger.log(`[Router.handleGet] Could not decode photographer name from state: ${String(decErr)}`);
        }
      }
      Logger.log(`[Router.handleGet] Volunteer OAuth callback — exchanging code` +
        (photographerName ? ` (photographer="${photographerName}")` : ''));
      return handleVolunteerOAuthCallback(params['code'], linkToken, photographerName);
    }

    // ── Volunteer upload page — post-auth, vsession-gated ────────────────────
    // Served after the volunteer OAuth callback creates a vsession.
    // Not a "real" admin route — bypasses the standard auth pipeline entirely.
    if (action === RouteAction.VOLUNTEER_UPLOAD) {
      const vsession = params['vsession'] ?? '';
      Logger.log(`[Router.handleGet] Volunteer upload page — vsession present: ${!!vsession}`);
      if (!vsession) {
        return linkErrorPage('Missing session. Please open the upload link again.', false);
      }
      return volunteerUploadPage(vsession);
    }

    // ── API key requests: deprecated since Phase 1 redesign ───────────────────
    if (params['api_key']) {
      Logger.log(`[Router.handleGet] API key rejected — api_key auth removed`);
      return ContentService
        .createTextOutput(JSON.stringify({
          status: 'error', code: 410,
          message: 'API key authentication has been removed. Use upload links instead.',
        }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── OAuth 2.0 authorization code callback ─────────────────────────────────
    // Google redirects here with ?code=XXX&state=oauth_login after the user
    // approves sign-in. We exchange the code for an ID token server-side,
    // verify the email, create a CacheService session, and redirect to dashboard.
    if (params['code'] && params['state'] === 'oauth_login') {
      Logger.log(`[Router.handleGet] OAuth callback received — exchanging code`);
      return handleOAuthCallback(params['code']);
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

    // ── Authenticate ─────────────────────────────────────────────────────────
    // Priority 1: GAS native session (getActiveUser — works with USER_ACCESSING)
    // Priority 2: session token from URL ?session=TOKEN (Path A: GIS login)
    Logger.log(`[Router.handleGet] Authenticating request…`);
    const sessionToken = params['session'] ?? '';
    const gasSession = getCurrentUser();
    const detectedEmail = gasSession.data?.email ?? '';
    Logger.log(`[Router.handleGet] GAS session email: "${detectedEmail}", session token present: ${!!sessionToken}`);

    let authResult: ReturnType<typeof resolveUser>;
    if (detectedEmail) {
      authResult = resolveUser(detectedEmail);
    } else if (sessionToken) {
      authResult = authenticateBySession(sessionToken);
    } else {
      authResult = gasSession as typeof authResult;
    }
    Logger.log(`[Router.handleGet] Auth result: status=${authResult.status} message="${authResult.message}" role=${authResult.data?.role ?? 'n/a'}`);

    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      Logger.log(`[Router.handleGet] Auth failed — redirecting to login`);
      // Distinguish "no auth attempt yet" from "auth was attempted and failed".
      // Under USER_DEPLOYING, an empty Session is the *normal* first-visit
      // state — the visitor hasn't clicked Sign in with Google yet. Surfacing
      // the authService "Not authenticated" banner here alarms legitimate
      // users on a fresh page load. Only show an error message when a real
      // attempt was made (sessionToken provided but invalid/expired, or the
      // GAS session lookup itself threw).
      const hadAuthAttempt = !!sessionToken || !!detectedEmail;
      return loginPage(hadAuthAttempt ? authResult.message : '');
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
    return dispatchGetHandler(action, user, sessionToken, params);
  } catch (err) {
    Logger.log(`[Router.handleGet] Unhandled error: ${String(err)}`);
    return errorPage(`An unexpected error occurred.\n\nDetails: ${String(err)}`);
  }
}

/**
 * Maps a validated action to its page handler.
 */
function dispatchGetHandler(
  action: RouteAction,
  user: UserRecord,
  sessionToken: string,
  params: Record<string, string> = {}
): GoogleAppsScript.HTML.HtmlOutput {
  switch (action) {
    case RouteAction.DASHBOARD:
      return dashboardPage(user, sessionToken);
    case RouteAction.ADMIN_USERS:
      return adminUsersPage(user, sessionToken);
    case RouteAction.ADMIN_EVENTS:
      return adminEventsPage(user, sessionToken);
    case RouteAction.ADMIN_CLUBS:
      return adminClubsPage(user, sessionToken);
    case RouteAction.ADMIN_SUMMARY:
      return adminSummaryPage(user, sessionToken);
    case RouteAction.ADMIN_AUDIT:
      return adminAuditPage(user, sessionToken);
    case RouteAction.ADMIN_EMAIL_PREFS:
      return adminEmailPrefsPage(user, sessionToken);
    case RouteAction.ADMIN_LINKS:
      return adminLinksPage(user, sessionToken, params['eventId']);
    case RouteAction.DRIVE_TREE:
      return driveTreePage(user, sessionToken);
    case RouteAction.UPLOAD:
      return uploadPage(user, sessionToken);
    case RouteAction.PUBLIC_SHEET:
      return publicSheetPage(user, sessionToken);
    case RouteAction.DUPLICATES:
      return duplicatesPage(user, sessionToken);
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

    // Parse request body BEFORE authenticating so we can extract sessionToken.
    // Under USER_DEPLOYING, Session.getActiveUser() returns empty and the
    // client-side GIS token is the only credential we have — it lives in the
    // JSON body (payload.sessionToken), not in e.parameter.
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

    // Authenticate (pass sessionToken from payload for USER_DEPLOYING + GIS)
    Logger.log(`[Router.handlePost] Authenticating request…`);
    const sessionToken = typeof payload.sessionToken === 'string'
      ? payload.sessionToken
      : undefined;
    const authResult = authenticateRequest(sessionToken);
    Logger.log(`[Router.handlePost] Auth result: status=${authResult.status} email=${authResult.data?.email ?? 'n/a'} role=${authResult.data?.role ?? 'n/a'} sessionTokenPresent=${!!sessionToken}`);

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
    case RouteAction.GENERATE_LINK:
      return handleGenerateLink(payload, user);
    case RouteAction.REVOKE_LINK:
      return handleRevokeLink(payload, user);
    case RouteAction.ROTATE_LINK:
      return handleRotateLink(payload, user);
    case RouteAction.LIST_LINKS:
      return handleListLinks(payload, user);
    case RouteAction.DELETE_FILE:
      return handleDeleteFile(payload, user);
    case RouteAction.RESTORE_FILE:
      return handleRestoreFile(payload, user);
    case RouteAction.LIST_DELETED:
      return handleListDeleted(payload, user);
    case RouteAction.LOGOUT:
      return handleLogout(payload);
    default:
      return handleUnknownAction(action);
  }
}

// ─── OAuth callback handler ───────────────────────────────────────────────────

/**
 * Handles the redirect from Google after the user approves the OAuth consent.
 * Exchanges the authorization code for an ID token, verifies the email,
 * looks up the user record, creates a session, and redirects to the dashboard.
 *
 * The returned HtmlOutput contains only a JS redirect — the page itself is
 * invisible. Using window.top ensures the outer script.google.com frame
 * navigates (not just the inner googleusercontent.com iframe).
 */
function handleOAuthCallback(code: string): GoogleAppsScript.HTML.HtmlOutput {
  // MUST use the canonical (non-Workspace) URL here — the redirect_uri sent
  // during code→token exchange must be byte-identical to the one sent at
  // authorize time. Since the login page injects getCanonicalScriptUrl() into
  // its OAuth URL, we use the same helper here.
  const redirectUri = getCanonicalScriptUrl();

  const tokenResult = exchangeOAuthCode(code, redirectUri);
  Logger.log(`[Router.handleOAuthCallback] token result: status=${tokenResult.status} msg="${tokenResult.message}"`);

  if (tokenResult.status !== ResultStatus.SUCCESS || !tokenResult.data) {
    return loginPage(
      '登录失败，请重试。如果问题持续，请联系 admin@mmrunners.org。\n' +
      `Sign-in failed — please try again. If the problem persists, email admin@mmrunners.org.\n` +
      `(Detail: ${tokenResult.message ?? 'Unknown error'})`
    );
  }

  const email = tokenResult.data.email;
  const userResult = resolveUser(email);
  Logger.log(`[Router.handleOAuthCallback] user lookup: status=${userResult.status} role=${userResult.data?.role ?? 'n/a'}`);

  if (userResult.status !== ResultStatus.SUCCESS || !userResult.data) {
    // Fire a security-event notification to opted-in admins. Non-fatal —
    // the user still sees the normal "not registered" login message.
    try {
      notifySecurityEvent(email, 'login_rejected_user_not_registered', {
        source: 'oauth_callback',
        authMessage: userResult.message,
      });
    } catch (emailErr) {
      Logger.log(`[Router.handleOAuthCallback] notifySecurityEvent failed (non-fatal): ${String(emailErr)}`);
    }
    return loginPage(
      `您是跑团联络员吗？请联系 admin@mmrunners.org 把您的邮箱权限设置好。我们现在没找到 ${email}。\n` +
      `Are you a club coordinator? Email admin@mmrunners.org to get ${email} added.`
    );
  }

  const sessionToken = createSession(email, userResult.data.role);
  // Record the login timestamp. Non-fatal — a failure here must not prevent
  // the user from reaching the dashboard.
  try {
    recordLogin(email);
  } catch (loginErr) {
    Logger.log(`[Router.handleOAuthCallback] recordLogin failed (non-fatal): ${String(loginErr)}`);
  }
  const dashUrl = `${redirectUri}?action=dashboard&session=${encodeURIComponent(sessionToken)}`;
  Logger.log(`[Router.handleOAuthCallback] session created — rendering continue page`);

  // NOTE: We cannot auto-redirect via `window.top.location.href = ...` here.
  // GAS serves the HTML in a googleusercontent.com iframe with sandbox flag
  // `allow-top-navigation-by-user-activation`, which means top-frame
  // navigation requires a user gesture (a click). An automatic JS redirect
  // is silently blocked by Chrome and the user sees a blank page.
  //
  // Instead, we render a small "Signed in — Continue" page. Clicking the
  // button provides the gesture Chrome requires, so the top-level navigation
  // succeeds. For browsers/contexts that still permit auto top-nav we also
  // attempt the JS redirect in an onload handler — if it's blocked, no harm,
  // the user just clicks the button.
  const safeEmail  = email.replace(/[<>&"']/g, '');
  const safeDash   = dashUrl.replace(/'/g, '%27');
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Signed in</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(135deg, #e8eaf6 0%, #f5f5f5 100%);
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; margin: 0; padding: 24px;
  }
  .card {
    background: #fff; padding: 40px 32px 36px;
    border-radius: 16px; box-shadow: 0 8px 32px rgba(0,0,0,.13);
    text-align: center; width: 100%; max-width: 420px;
  }
  .check-circle {
    width: 64px; height: 64px; border-radius: 50%;
    background: linear-gradient(135deg, #43a047, #66bb6a);
    display: flex; align-items: center; justify-content: center;
    margin: 0 auto 20px;
    box-shadow: 0 4px 14px rgba(67,160,71,.35);
  }
  .check-circle svg { width: 34px; height: 34px; }
  h3 { margin: 0 0 8px; color: #1a1a2e; font-size: 22px; font-weight: 700; }
  p  { color: #666; margin: 0 0 28px; font-size: 15px; word-break: break-all; }
  a.btn {
    display: block; width: 100%;
    background: linear-gradient(135deg, #3f51b5, #5c6bc0);
    color: #fff; text-decoration: none;
    padding: 18px 24px; border-radius: 12px;
    font-size: 18px; font-weight: 700; letter-spacing: 0.2px;
    box-shadow: 0 4px 16px rgba(63,81,181,.4);
    transition: transform .12s, box-shadow .12s;
    -webkit-tap-highlight-color: transparent;
  }
  a.btn:hover  { background: linear-gradient(135deg, #303f9f, #3f51b5); }
  a.btn:active { transform: scale(.97); box-shadow: 0 2px 8px rgba(63,81,181,.3); }
</style>
</head>
<body>
  <div class="card">
    <div class="check-circle">
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M5 13l4 4L19 7" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <h3>Signed in</h3>
    <p>Welcome, ${safeEmail}</p>
    <a class="btn" href="${safeDash}" target="_top">Continue to Dashboard</a>
  </div>
  <script>
    // Best-effort auto-redirect for browsers that allow it. Silently blocked
    // in Chrome without a gesture — that's fine, the button covers it.
    try { window.top.location.href = '${safeDash}'; } catch (e) {}
  </script>
</body></html>`;

  return HtmlService
    .createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
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
  /* global ScriptApp, Session, PropertiesService */
  let sessionEmail = '';
  let sessionError = '';
  try {
    sessionEmail = Session.getActiveUser().getEmail() || '';
  } catch (err) {
    sessionError = String(err);
  }

  const deployUrl    = ScriptApp.getService().getUrl();
  const timestamp    = new Date().toISOString();
  const params       = JSON.stringify(e.parameter, null, 2);
  const clientId     = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID')     ?? '(not set)';
  const clientSecret = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_SECRET') ?? '(not set)';
  const secretHint   = clientSecret !== '(not set)' ? clientSecret.substring(0, 8) + '… (length=' + clientSecret.length + ')' : '(not set)';

  const ok = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px;color:#555;white-space:nowrap;">${label}</td>` +
    `<td style="padding:6px 12px;font-family:monospace;color:#1b5e20;font-weight:bold;word-break:break-all;">${value}</td></tr>`;
  const warn = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px;color:#555;white-space:nowrap;">${label}</td>` +
    `<td style="padding:6px 12px;font-family:monospace;color:#b71c1c;font-weight:bold;word-break:break-all;">${value}</td></tr>`;

  const clientIdOk = clientId.includes('-k018eecas6s3mnqi84gec9m555de9r3a');
  const rows = [
    sessionEmail
      ? ok('Session email', sessionEmail)
      : warn('Session email', sessionError ? `ERROR: ${sessionError}` : '(empty — normal for USER_DEPLOYING)'),
    ok('Deployment URL', deployUrl),
    clientIdOk
      ? ok('GOOGLE_CLIENT_ID', clientId + ' ✓ (new client)')
      : warn('GOOGLE_CLIENT_ID', clientId + ' ← WRONG — update Script Properties'),
    ok('GOOGLE_CLIENT_SECRET', secretHint),
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
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
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
