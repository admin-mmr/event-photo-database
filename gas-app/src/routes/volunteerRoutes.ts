/**
 * volunteerRoutes.ts — Page handlers for the volunteer (non-admin) upload flow.
 *
 * Volunteer flow overview (DESIGN_DECISIONS.md §4, §12):
 *
 *   Step 1 — Confirm page (pre-login, public):
 *     ?action=upload_link&token=XYZ
 *     Shows the event + club name and the consent line. Requires no prior auth.
 *     The "Sign in with Google" button initiates OAuth with state=volunteer:TOKEN.
 *
 *   Step 2 — OAuth callback (handled in router.ts):
 *     ?code=XXX&state=volunteer:TOKEN
 *     Exchanges the code for an email, re-validates the link, creates a
 *     short-lived volunteer session (vsession), redirects to step 3.
 *
 *   Step 3 — Upload page (post-auth, vsession-gated):
 *     ?action=volunteer_upload&vsession=VSESSION
 *     Client calls serverGetVolunteerDriveToken() to get a short-lived Drive
 *     access token and a batch folder ID, then uploads bytes directly to the
 *     Drive REST API (bytes never pass through GAS — DESIGN_DECISIONS.md §12).
 *     After all files are uploaded the client calls serverCompleteVolunteerUpload()
 *     which writes the audit + upload-log entries and enqueues a sync job.
 *
 * Server functions (main.ts):
 *   serverGetVolunteerDriveToken  — validates vsession, creates batch folder, returns OAuth token
 *   serverCompleteVolunteerUpload — writes audit + upload log, enqueues sync
 *
 * Error pages:
 *   linkErrorPage — rendered when a token is unknown or the link is revoked.
 */

import { ResultStatus } from '../types/enums';
import { isCreditRenameEnabled } from '../config/constants';
import { validateLink } from '../services/uploadLinkService';
import { findById as findEventById } from '../services/eventService';
import { lookupSession, createSession, deleteSession } from '../services/sessionService';
import { exchangeOAuthCode } from '../services/tokenService';
import {
  getOrCreateClubFolder,
  getOrCreateTagFolder,
  createBatchFolder,
} from '../services/driveService';
import { appendUploadLog } from '../services/uploadLogService';
import { appendAuditLog } from '../services/auditLogService';
import { notifyUploadClientError } from '../services/emailService';
import { getPublicSpreadsheetUrl } from '../services/publicSpreadsheetService';
import { getCanonicalScriptUrl } from '../utils/scriptUrl';
import { buildLayer3FolderName } from '../utils/folderNameValidator';
import { toBatchTimestamp } from '../utils/dateFormatter';
import { AuditAction, UploadSource } from '../types/enums';

/* global HtmlService, PropertiesService, ScriptApp, Logger */

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Consent text displayed on the upload confirmation page (DESIGN_DECISIONS.md §4).
 * This wording was confirmed during Phase 2 requirements gathering.
 */
export const VOLUNTEER_CONSENT_LINE =
  'By uploading, I confirm I have permission to share these photos and they are appropriate for a public event audience.';

/**
 * Role prefix stored in the volunteer session payload.
 * The full role value is `VOLUNTEER_ROLE_PREFIX + linkToken`.
 */
const VOLUNTEER_ROLE_PREFIX = 'volunteer:';

// ─── Template helper ──────────────────────────────────────────────────────────

function renderVolunteerTemplate(
  templateName: string,
  data: Record<string, unknown>
): GoogleAppsScript.HTML.HtmlOutput {
  const template = HtmlService.createTemplateFromFile(
    `ui/templates/volunteer/${templateName}`
  );
  Object.assign(template, { scriptUrl: getCanonicalScriptUrl(), ...data });
  return template
    .evaluate()
    .setTitle('Photo Upload')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    // Force device-width viewport on the outer script.google.com wrapper — without
    // this the iframe renders at desktop width on mobile, forcing volunteers to
    // pinch-zoom the upload page. See renderTemplate() in pageRoutes.ts.
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ─── Session helpers ──────────────────────────────────────────────────────────

/**
 * Creates a short-lived volunteer session that encodes the link token in the
 * role field. The vsession token is passed back to the client and used for
 * all subsequent server calls within this upload session.
 *
 * @param photographerName  Optional display name typed on the confirm page.
 *                          Carried through to every upload as the credit line.
 */
export function createVolunteerSession(
  email: string,
  linkToken: string,
  photographerName = '',
): string {
  return createSession(email, VOLUNTEER_ROLE_PREFIX + linkToken, photographerName);
}

/**
 * Validates a volunteer session and returns { email, linkToken, photographerName }
 * if valid. photographerName is an empty string when none was captured (legacy
 * sessions, or volunteers who hit the page before this feature shipped).
 * Returns null if the session is expired or not a volunteer session.
 */
export function lookupVolunteerSession(
  vsession: string
): { email: string; linkToken: string; photographerName: string } | null {
  const payload = lookupSession(vsession);
  if (!payload) return null;
  if (!payload.role.startsWith(VOLUNTEER_ROLE_PREFIX)) return null;
  const linkToken = payload.role.slice(VOLUNTEER_ROLE_PREFIX.length);
  return {
    email: payload.email,
    linkToken,
    photographerName: (payload.displayName ?? '').trim(),
  };
}

// ─── Step 1: Confirm page (pre-login) ────────────────────────────────────────

/**
 * Renders the volunteer confirmation page for a given upload link token.
 *
 * Called from router.ts when ?action=upload_link&token=XYZ (or just ?token=XYZ).
 * No authentication required — this is the first page a volunteer sees.
 *
 * The page shows the event name, club name, and consent line. The "Sign in"
 * button constructs an OAuth URL with state=volunteer:TOKEN so the token
 * survives the OAuth round-trip.
 */
export function volunteerConfirmPage(
  token: string
): GoogleAppsScript.HTML.HtmlOutput {
  // Validate the link
  const linkResult = validateLink({ token });
  if (linkResult.status !== ResultStatus.SUCCESS || !linkResult.data) {
    return linkErrorPage(
      linkResult.message ?? 'This link is not valid.',
      linkResult.message?.includes('revoked')
    );
  }

  const link = linkResult.data;

  // Look up the event name
  const event = findEventById(link.eventId);
  const eventName = event ? event.eventName : link.eventId; // fallback to ID if event not found

  // Get the client ID for the OAuth button
  let clientId = '';
  try {
    clientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID') ?? '';
  } catch {
    clientId = '';
  }

  return renderVolunteerTemplate('confirm', {
    eventName,
    clubName:    link.clubName,
    linkToken:   token,
    consentLine: VOLUNTEER_CONSENT_LINE,
    clientId,
  });
}

// ─── Step 2: OAuth callback for volunteers ────────────────────────────────────

/**
 * Handles the Google OAuth redirect for volunteer flows.
 * Called from router.ts when ?code=XXX&state=volunteer:TOKEN.
 *
 * 1. Exchanges the auth code for the user's email.
 * 2. Re-validates the link token (may have been revoked during OAuth flow).
 * 3. Creates a volunteer session encoding the link token.
 * 4. Redirects to the volunteer upload page.
 */
export function handleVolunteerOAuthCallback(
  code: string,
  linkToken: string,
  photographerName = '',
): GoogleAppsScript.HTML.HtmlOutput {
  const redirectUri = getCanonicalScriptUrl();

  // Exchange auth code for email
  const tokenResult = exchangeOAuthCode(code, redirectUri);
  Logger.log(`[VolunteerRoutes] OAuth token result: status=${tokenResult.status}`);

  if (tokenResult.status !== ResultStatus.SUCCESS || !tokenResult.data) {
    return linkErrorPage(
      `Google sign-in failed: ${tokenResult.message ?? 'Unknown error'}`,
      false
    );
  }

  const email = tokenResult.data.email;

  // Re-validate the link (it could have been revoked while the user was on the confirm page)
  const linkResult = validateLink({ token: linkToken });
  if (linkResult.status !== ResultStatus.SUCCESS || !linkResult.data) {
    return linkErrorPage(
      linkResult.message ?? 'This upload link is no longer valid.',
      linkResult.message?.includes('revoked')
    );
  }

  // Create the volunteer session and redirect to upload page.
  // The typed photographer name (if any) is bound to the session so every
  // uploaded file carries the same credit line.
  const vsession = createVolunteerSession(email, linkToken, photographerName);
  const uploadUrl = `${redirectUri}?action=volunteer_upload&vsession=${encodeURIComponent(vsession)}`;

  Logger.log(`[VolunteerRoutes] Volunteer session created for ${email} — redirecting to upload page`);

  const safeEmail  = email.replace(/[<>&"']/g, '');
  const safeUrl    = uploadUrl.replace(/'/g, '%27');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Signed in</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#f5f5f5;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
  .card { background:#fff; padding:32px 40px; border-radius:8px;
          box-shadow:0 2px 12px rgba(0,0,0,.12); text-align:center; max-width:360px; }
  h3  { margin:0 0 8px; color:#333; }
  p   { color:#666; margin:0 0 20px; font-size:14px; }
  a.btn { display:inline-block; background:#2e7d32; color:#fff; text-decoration:none;
          padding:12px 28px; border-radius:4px; font-size:15px; font-weight:500; }
  a.btn:hover { background:#1b5e20; }
</style></head>
<body>
  <div class="card">
    <h3>Signed in ✓</h3>
    <p>Welcome, ${safeEmail}</p>
    <a class="btn" href="${safeUrl}" target="_top">Continue to Upload</a>
  </div>
  <script>
    try { window.top.location.href = '${safeUrl}'; } catch (e) {}
  </script>
</body></html>`;

  return HtmlService
    .createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ─── Step 3: Upload page (post-auth) ─────────────────────────────────────────

/**
 * Renders the volunteer upload interface.
 * Called from router.ts when ?action=volunteer_upload&vsession=SESSION.
 *
 * Validates the vsession, re-validates the link, looks up event details, and
 * returns the upload page template with all data injected.
 */
export function volunteerUploadPage(
  vsession: string
): GoogleAppsScript.HTML.HtmlOutput {
  // Validate the vsession
  const sessionData = lookupVolunteerSession(vsession);
  if (!sessionData) {
    return linkErrorPage(
      'Your session has expired or is not valid. Please open the original upload link again.',
      false
    );
  }

  const { email, linkToken, photographerName } = sessionData;

  // Re-validate the link (final check before serving the upload interface)
  const linkResult = validateLink({ token: linkToken });
  if (linkResult.status !== ResultStatus.SUCCESS || !linkResult.data) {
    deleteSession(vsession);
    return linkErrorPage(
      linkResult.message ?? 'This upload link is no longer valid.',
      linkResult.message?.includes('revoked')
    );
  }

  const link = linkResult.data;

  // Look up the event
  const event = findEventById(link.eventId);
  const eventName = event ? event.eventName : link.eventId;
  const eventDate = event ? event.eventDate : '';

  Logger.log(`[VolunteerRoutes] Serving upload page for ${email} — event="${eventName}" club="${link.clubName}"` +
    (photographerName ? ` photographer="${photographerName}"` : ''));

  return renderVolunteerTemplate('upload', {
    vsession,
    eventName,
    eventDate,
    clubName:            link.clubName,
    uploaderEmail:       email,
    consentLine:         VOLUNTEER_CONSENT_LINE,
    photographerName,
    creditRenameEnabled: isCreditRenameEnabled(),
    // URL of the public read-only folder-index sheet — used by the post-upload
    // confirmation page's "View Public Sheet" button. Empty string when the
    // PUBLIC_ALBUM_INDEX_SHEET_ID Script Property is unset (feature off).
    publicSpreadsheetUrl: getPublicSpreadsheetUrl(),
  });
}

// ─── Error page ───────────────────────────────────────────────────────────────

/**
 * Renders the link error page.
 *
 * @param message    Human-readable reason (e.g., "link revoked").
 * @param isRevoked  If true, suggests contacting the club admin for a new link.
 */
/**
 * Payload sent from the browser when a Drive API call fails during upload.
 * All fields are optional except vsession so the server can still log partial
 * information if the client had not yet received a batch folder.
 */
export interface ClientErrorPayload {
  vsession:        string;
  fileName:        string;
  errorMessage:    string;
  httpStatus?:     number;
  driveResponse?:  string;
  batchFolderId?:  string;
  batchFolderName?: string;
}

/**
 * Called by the client (google.script.run) when a Drive REST API call returns
 * a non-200 status.  Writes an audit log entry and emails opted-in admins with
 * full error details so failures are visible without digging through Logs Explorer.
 *
 * Design notes:
 *   - Best-effort: never throws.  A logging failure must not disrupt the
 *     upload UX (the file error icon is already shown client-side).
 *   - The client deduplicates: only the FIRST Drive error per upload session
 *     is reported, to avoid flooding admins when all files in a batch fail
 *     for the same root cause (e.g. expired token).
 *   - vsession validation is advisory: even if the session has just expired
 *     we still log as much as we can with email='unknown'.
 */
export function serverReportClientError(payload: ClientErrorPayload): void {
  try {
    const {
      vsession,
      fileName,
      errorMessage,
      httpStatus,
      driveResponse,
      batchFolderId,
      batchFolderName,
    } = payload;

    // Resolve email from session — non-fatal if expired.
    let email = 'unknown';
    try {
      const sessionData = lookupVolunteerSession(vsession);
      if (sessionData) email = sessionData.email;
    } catch { /* ignore */ }

    Logger.log(
      `[VolunteerRoutes.serverReportClientError] ` +
      `email=${email} file="${fileName}" httpStatus=${httpStatus ?? 'N/A'} ` +
      `error="${errorMessage}" ` +
      `driveResponse="${driveResponse ?? ''}" ` +
      `batchFolder="${batchFolderName ?? ''}" (${batchFolderId ?? ''})`
    );

    appendAuditLog({
      actorEmail:   email,
      action:       AuditAction.UPLOAD_CLIENT_ERROR,
      resourceType: 'upload',
      resourceId:   batchFolderId ?? '',
      details: {
        fileName,
        errorMessage,
        httpStatus,
        driveResponse,
        batchFolderName,
        batchFolderId,
      },
    });

    notifyUploadClientError(
      email,
      fileName,
      errorMessage,
      httpStatus,
      driveResponse,
      batchFolderName,
    );
  } catch (err) {
    // Swallow — logging must not disrupt the upload UI.
    Logger.log(`[VolunteerRoutes.serverReportClientError] unexpected error: ${String(err)}`);
  }
}

export function linkErrorPage(
  message: string,
  isRevoked = false
): GoogleAppsScript.HTML.HtmlOutput {
  return renderVolunteerTemplate('link_error', {
    message,
    isRevoked,
    contactHint: isRevoked
      ? 'Please contact your club administrator to request a new upload link.'
      : 'If you believe this is an error, please contact your club administrator.',
  });
}

// ─── Server functions (called via google.script.run) ─────────────────────────

/**
 * Validates the volunteer session, creates the Drive batch folder, and returns
 * a short-lived Drive access token for client-side direct upload.
 *
 * Per DESIGN_DECISIONS.md §12: upload bytes go directly from the browser to
 * Drive via the REST API; GAS only handles the token exchange and metadata.
 *
 * @returns { accessToken, batchFolderId, batchFolderName, linkId } on success,
 *          or { error } on failure.
 */
export function serverGetVolunteerDriveToken(
  vsession: string
): Record<string, unknown> {
  try {
    const sessionData = lookupVolunteerSession(vsession);
    if (!sessionData) {
      return { error: 'Session expired. Please open the upload link again.' };
    }

    const { email, linkToken } = sessionData;

    const linkResult = validateLink({ token: linkToken });
    if (linkResult.status !== ResultStatus.SUCCESS || !linkResult.data) {
      return { error: linkResult.message ?? 'Upload link is no longer valid.' };
    }

    const link = linkResult.data;

    // Look up the event to get its Drive folder
    const event = findEventById(link.eventId);
    if (!event) {
      return { error: `Event not found: ${link.eventId}` };
    }

    if (!event.driveFolderId) {
      return { error: 'Event has no Drive folder. Contact the club administrator.' };
    }

    // Get or create the club folder inside the event folder
    const clubFolderResult = getOrCreateClubFolder(event.driveFolderId, link.clubName);
    if (clubFolderResult.status !== ResultStatus.SUCCESS || !clubFolderResult.data) {
      return { error: `Could not access club folder: ${clubFolderResult.message}` };
    }

    // If this link has a tag, route uploads into a tag-named subfolder inside
    // the club folder (e.g. Club / finish_line / Batch).
    // Links with no tag go straight into the club folder (original behaviour).
    const tag = (link.tag ?? '').trim();
    let uploadParentFolderId = clubFolderResult.data.folderId;
    if (tag) {
      const tagFolderResult = getOrCreateTagFolder(clubFolderResult.data.folderId, tag);
      if (tagFolderResult.status !== ResultStatus.SUCCESS || !tagFolderResult.data) {
        return { error: `Could not access tag folder "${tag}": ${tagFolderResult.message}` };
      }
      uploadParentFolderId = tagFolderResult.data.folderId;
      Logger.log(
        `[VolunteerRoutes.serverGetVolunteerDriveToken] using tag subfolder "${tag}" ` +
        `(${uploadParentFolderId}) for ${email}`
      );
    }

    // Create the batch folder (Layer 3: YYYYMMDD-HHMMSS_username)
    const batchTimestamp  = toBatchTimestamp(new Date());
    const batchFolderName = buildLayer3FolderName(batchTimestamp, email);
    const batchResult     = createBatchFolder(uploadParentFolderId, batchFolderName);
    if (batchResult.status !== ResultStatus.SUCCESS || !batchResult.data) {
      return { error: `Could not create upload folder: ${batchResult.message}` };
    }

    const accessToken = ScriptApp.getOAuthToken();
    Logger.log(
      `[VolunteerRoutes.serverGetVolunteerDriveToken] batch folder created: ` +
      `"${batchFolderName}" (${batchResult.data.folderId}) for ${email}` +
      (tag ? ` [tag: ${tag}]` : '') +
      ` | eventDriveFolderId=${event.driveFolderId}` +
      ` | uploadParentFolderId=${uploadParentFolderId}` +
      ` | tokenLength=${accessToken ? accessToken.length : 0}`
    );

    return {
      accessToken,
      batchFolderId:  batchResult.data.folderId,
      batchFolderName,
      linkId:         link.linkId,
    };
  } catch (err) {
    Logger.log(`[VolunteerRoutes.serverGetVolunteerDriveToken] error: ${String(err)}`);
    return { error: `Unexpected error: ${String(err)}` };
  }
}

/**
 * Payload from the client after all files have been uploaded to Drive.
 */
export interface CompleteUploadPayload {
  vsession:         string;
  batchFolderId:    string;
  batchFolderName:  string;
  linkId:           string;
  fileCount:        number;
  totalSizeMb:      number;
  skippedDuplicates: number;
  skippedNonMedia:  number;
  /** Wall-clock upload duration in ms, measured in the browser. Optional for
   *  backward-compat with older client bundles; treated as 0 (unknown) if absent. */
  durationMs?:      number;
}

/**
 * Completes a volunteer upload session after the client has finished uploading
 * bytes to Drive.
 *
 * 1. Validates the vsession.
 * 2. Re-validates the link.
 * 3. Writes an UploadLog entry.
 * 4. Writes an Audit_Log entry.
 * 5. Enqueues a Drive→Photos sync job.
 *
 * @returns { ok: true, receiptData } on success, or { error } on failure.
 */
export function serverCompleteVolunteerUpload(
  payload: CompleteUploadPayload
): Record<string, unknown> {
  try {
    const {
      vsession,
      batchFolderId,
      batchFolderName,
      linkId,
      fileCount,
      totalSizeMb,
      skippedDuplicates,
      skippedNonMedia,
      durationMs,
    } = payload;

    Logger.log(
      `[VolunteerRoutes.serverCompleteVolunteerUpload] incoming payload: ` +
      `fileCount=${fileCount} totalSizeMb=${totalSizeMb} ` +
      `skippedDuplicates=${skippedDuplicates} skippedNonMedia=${skippedNonMedia} ` +
      `batchFolder="${batchFolderName}" (${batchFolderId}) linkId=${linkId}`
    );

    // Validate session
    const sessionData = lookupVolunteerSession(vsession);
    if (!sessionData) {
      return { error: 'Session expired — upload record could not be saved.' };
    }

    const { email, linkToken } = sessionData;

    // Re-validate link
    const linkResult = validateLink({ token: linkToken });
    if (linkResult.status !== ResultStatus.SUCCESS || !linkResult.data) {
      return { error: linkResult.message ?? 'Upload link is no longer valid.' };
    }

    const link = linkResult.data;

    // Look up event for metadata
    const eventRecord = findEventById(link.eventId);
    const eventName   = eventRecord?.eventName ?? link.eventId;

    const now = new Date().toISOString();

    // Write UploadLog entry (logId and uploadTimestamp are auto-generated by appendUploadLog)
    appendUploadLog({
      eventId:          link.eventId,
      clubName:         link.clubName,
      uploadedBy:       email,
      batchFolderName,
      batchFolderId,
      fileCount,
      totalSizeMb,
      skippedDuplicates,
      skippedNonPhoto:  skippedNonMedia,
      source:           UploadSource.LINK,
      linkId,
      durationMs,
    });

    // Write Audit_Log entry
    appendAuditLog({
      actorEmail:   email,
      action:       AuditAction.UPLOAD_COMPLETED,
      resourceType: 'upload',
      resourceId:   batchFolderId,
      details: {
        eventId:          link.eventId,
        eventName,
        clubName:         link.clubName,
        batchFolderName,
        fileCount,
        totalSizeMb,
        skippedDuplicates,
        skippedNonMedia,
        source:           UploadSource.LINK,
      },
      linkId,
    });

    Logger.log(
      `[VolunteerRoutes.serverCompleteVolunteerUpload] ` +
      `${fileCount} files recorded for ${email} / ${link.clubName} / event ${link.eventId}`
    );

    return {
      ok: true,
      receiptData: {
        fileCount,
        totalSizeMb,
        skippedDuplicates,
        skippedNonMedia,
        eventName,
        clubName: link.clubName,
        uploadedAt: now,
      },
    };
  } catch (err) {
    Logger.log(`[VolunteerRoutes.serverCompleteVolunteerUpload] error: ${String(err)}`);
    return { error: `Unexpected error: ${String(err)}` };
  }
}
