/**
 * main.ts — GAS Web App entry points, spreadsheet triggers, and editor helpers.
 *
 * doGet(e)  → delegates to Router.handleGet (page routing)
 * doPost(e) → delegates to Router.handlePost (JSON API routing)
 *
 * google.script.run handler implementations live in per-area route modules:
 *   routes/userHandlers.ts     — auth, user CRUD
 *   routes/eventHandlers.ts    — events, clubs, Drive scan
 *   routes/uploadHandlers.ts   — upload pipeline, Drive tree
 *   routes/photosHandlers.ts   — Photos albums, sync jobs, sync queue
 *   routes/reportHandlers.ts   — summaries, audit log, email prefs, triggers
 *   routes/linkHandlers.ts     — upload link management
 *   routes/volunteerRoutes.ts  — volunteer upload flow
 *   routes/uploadPrepRoutes.ts — upload-prep sidebar
 *
 * Importing those modules here ensures esbuild bundles them and their exported
 * functions land at global scope after the IIFE is unwrapped by the build script.
 */

// ─── Side-effect imports — pull all handler modules into the bundle ───────────
// (esbuild entry point is main.ts; any module not imported here is excluded)
import './routes/userHandlers';
import './routes/eventHandlers';
import './routes/uploadHandlers';
import './routes/photosHandlers';
import './routes/reportHandlers';
import './routes/linkHandlers';
import './routes/volunteerRoutes';
import './routes/uploadPrepRoutes';

// ─── Remaining direct imports used by functions declared below ────────────────
import { handleGet, handlePost } from './routes/router';
import { purgeDeletedFiles as _purgeDeletedFiles } from './services/deleteService';
import { migrateFromLegacy } from './services/migrationService';
import { rebuildPublicAlbumIndex as _rebuildPublicAlbumIndex } from './services/publicSpreadsheetService';
import { getSuperAdmins } from './config/superAdmins';
import { getAlbumAdminEmail, getConfig } from './config/constants';
import { auditUnsharedAlbums } from './services/albumShareAuditService';
import {
  notifyAlbumNeedsShare,
  notifyAlbumReconciliationReport,
} from './services/emailService';
import {
  buildReconciliationReport,
  writeReconciliationTab,
  RECONCILIATION_TAB,
} from './services/albumReconciliationService';
import { showUploadPrepSidebar as _showUploadPrepSidebar } from './routes/uploadPrepRoutes';
import {
  uploadPrep_listEvents as _uploadPrep_listEvents,
  uploadPrep_getStatus as _uploadPrep_getStatus,
  uploadPrep_start as _uploadPrep_start,
  uploadPrep_runBatch as _uploadPrep_runBatch,
} from './routes/uploadPrepRoutes';
import { ServerResponse } from './types/responses';

/* global Logger, SpreadsheetApp, Session, PropertiesService, ScriptApp, UrlFetchApp, DriveApp */

// ─── Web App entry points ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function doGet(
  e: GoogleAppsScript.Events.DoGet
): GoogleAppsScript.HTML.HtmlOutput | GoogleAppsScript.Content.TextOutput {
  e = e || {};
  e.parameter = e.parameter || {};
   return handleGet(e);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function doPost(
  e: GoogleAppsScript.Events.DoPost
): GoogleAppsScript.Content.TextOutput {
  e = e || {};
  e.parameter = e.parameter || {};
   return handlePost(e);
}

// ─── Debug helpers (editor-only; guarded to super-admins) ────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function debugClientId(): void {
  const callerEmail = Session.getActiveUser().getEmail();
  if (!getSuperAdmins().includes(callerEmail)) {
    Logger.log(`[debugClientId] Permission denied for ${callerEmail}`);
    return;
  }
  const clientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID') ?? '(not set)';
  Logger.log('GOOGLE_CLIENT_ID = [' + clientId + ']');
  Logger.log('Length = ' + clientId.length);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function debugConfig(): void {
  const callerEmail = Session.getActiveUser().getEmail();
  if (!getSuperAdmins().includes(callerEmail)) {
    Logger.log(`[debugConfig] Permission denied for ${callerEmail}`);
    return;
  }
  const clientId     = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID')     ?? '(not set)';
  const clientSecret = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_SECRET') ?? '(not set)';
  const deployUrl    = ScriptApp.getService().getUrl();
  const activeEmail  = Session.getActiveUser().getEmail()    || '(empty)';
  const effectEmail  = Session.getEffectiveUser().getEmail() || '(empty)';

  Logger.log('=== debugConfig ===');
  Logger.log('GOOGLE_CLIENT_ID:     [' + clientId + ']');
  Logger.log('GOOGLE_CLIENT_SECRET: ' + (clientSecret !== '(not set)' ? clientSecret.substring(0, 10) + '…' : '(not set)'));
  Logger.log('Deployment URL:       ' + deployUrl);
  Logger.log('Active user email:    ' + activeEmail);
  Logger.log('Effective user email: ' + effectEmail);
  Logger.log('===================');
}

// ─── Spreadsheet on-open trigger ─────────────────────────────────────────────

/**
 * Adds the "Super Admin → Prep Upload Files…" menu when the spreadsheet opens.
 * Set up in GAS Triggers panel: Function onOpen / From spreadsheet → On open.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function onOpen(): void {
  try {
    const email = Session.getEffectiveUser().getEmail();
    if (getSuperAdmins().includes(email.toLowerCase())) {
      SpreadsheetApp.getUi()
        .createMenu('Super Admin')
        .addItem('Prep Upload Files…', 'showUploadPrepSidebar')
        .addToUi();
      Logger.log(`[onOpen] Super Admin menu added for ${email}`);
    }
  } catch (err) {
    Logger.log(`[onOpen] Could not build menu: ${String(err)}`);
  }
}

// ─── Upload Prep sidebar ──────────────────────────────────────────────────────
// These thin wrappers are required because esbuild resolves name conflicts by
// renaming imports; declaring them explicitly here avoids the *2 suffix problem.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function showUploadPrepSidebar(): void { _showUploadPrepSidebar(); }

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function uploadPrep_listEvents(): ServerResponse { return _uploadPrep_listEvents(); }

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function uploadPrep_getStatus(eventFolderId: string): ServerResponse {
  return _uploadPrep_getStatus(eventFolderId);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function uploadPrep_start(
  eventFolderId: string,
  options: { dryRun?: boolean; force?: boolean }
): ServerResponse {
  return _uploadPrep_start(eventFolderId, options);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function uploadPrep_runBatch(
  runId: string,
  eventFolderId: string,
  continuationToken: string | undefined,
  options: { dryRun?: boolean; force?: boolean }
): ServerResponse {
  return _uploadPrep_runBatch(runId, eventFolderId, continuationToken, options);
}

// ─── Maintenance triggers ─────────────────────────────────────────────────────

/**
 * Daily purge trigger — permanently removes Drive files that have been in the
 * soft-delete trash for longer than SOFT_DELETE_RETENTION_DAYS.
 * Set up in GAS Triggers panel: Function purgeDeletedFilesTrigger / Day timer.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function purgeDeletedFilesTrigger(): void {
  Logger.log('[purgeDeletedFilesTrigger] Starting daily purge run');
  const { purged, errors } = _purgeDeletedFiles();
  Logger.log(`[purgeDeletedFilesTrigger] Complete — purged=${purged} errors=${errors}`);
  if (errors > 0) {
    Logger.log('[purgeDeletedFilesTrigger] WARNING: some files could not be purged — check logs above');
  }
}

// ─── Public album index spreadsheet ──────────────────────────────────────────

/**
 * Rebuilds the public, view-only album index spreadsheet from scratch.
 *
 * Use this when:
 *   - Setting up the feature for the first time after configuring
 *     PUBLIC_ALBUM_INDEX_SHEET_ID in Script Properties.
 *   - Recovering from a corrupted public sheet (the function clears + rewrites
 *     the entire "Albums" tab).
 *   - You manually edited Photo_Albums in the database and want the public
 *     view to catch up immediately.
 *
 * Day-to-day refreshes happen automatically when albums are created or batches
 * finish syncing (see publicSpreadsheetService.tryRebuildPublicAlbumIndex
 * call sites in photosService.ts), so this is only for manual / recovery use.
 *
 * Super-admin only — guarded by Session.getActiveUser().
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function rebuildPublicAlbumIndex(): void {
  const callerEmail = Session.getActiveUser().getEmail();
  if (!getSuperAdmins().includes(callerEmail.toLowerCase())) {
    Logger.log(`[rebuildPublicAlbumIndex] Permission denied for ${callerEmail}`);
    return;
  }
  Logger.log(`[rebuildPublicAlbumIndex] Manual rebuild started by ${callerEmail}`);
  const rowCount = _rebuildPublicAlbumIndex();
  Logger.log(`[rebuildPublicAlbumIndex] Done — ${rowCount} row(s) written`);
}

// ─── Album sharing audit ──────────────────────────────────────────────────────

/**
 * Scans every album in the Photo_Albums sheet and sends a
 * notifyAlbumNeedsShare email to all super-admins for each album that has
 * not yet been shared publicly in Google Photos.
 *
 * Run this:
 *   • Manually from the GAS Script Editor (select function → Run).
 *   • Or set up a time-driven trigger (e.g. weekly) via
 *     Triggers → Add trigger → auditAlbumSharing → Time-driven → Week timer.
 *
 * The function is intentionally non-destructive: it only sends notification
 * emails and never modifies sheet data or album settings.
 *
 * How sharing is detected:
 *   The Photos Library API `albums.get` endpoint returns a `shareInfo` object
 *   only when the album has been shared via "Anyone with the link".  If the
 *   field is absent the album is treated as private.
 *
 * Super-admin only — guarded by Session.getActiveUser().
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function auditAlbumSharing(): void {
  const callerEmail = Session.getActiveUser().getEmail().toLowerCase();
  const admins = getSuperAdmins();

  if (!admins.includes(callerEmail)) {
    Logger.log(`[auditAlbumSharing] Permission denied for ${callerEmail}`);
    return;
  }

  Logger.log(`[auditAlbumSharing] Started by ${callerEmail}`);

  const result = auditUnsharedAlbums();

  Logger.log(
    `[auditAlbumSharing] Audit complete — ` +
    `checked: ${result.checked}, unshared: ${result.unshared.length}, ` +
    `skipped: ${result.skipped}`
  );

  if (result.unshared.length === 0) {
    Logger.log('[auditAlbumSharing] All albums are already shared — no emails sent.');
    return;
  }

  // Reminder emails go to the album-admin mailbox, NOT the super-admin list.
  // Only the Google account that owns the album can flip the share toggle, and
  // that's the deploying identity behind admin@mmrunners.org. Other super
  // admins on different accounts can't act on this even if they're CC'd.
  const recipients = [getAlbumAdminEmail()];
  Logger.log(`[auditAlbumSharing] Reminder recipients: ${recipients.join(', ')}`);

  let emailsSent = 0;
  let emailsFailed = 0;

  for (const entry of result.unshared) {
    try {
      const emailResult = notifyAlbumNeedsShare(
        entry.album.albumTitle,
        entry.album.albumUrl,
        entry.scope,
        {
          eventName:       entry.eventName,
          eventDate:       entry.eventDate,
          clubDisplayName: entry.clubDisplayName || undefined,
          tag:             entry.album.tag || undefined,
        },
        recipients,
      );

      if (emailResult.status === 'success') {
        emailsSent++;
        Logger.log(`[auditAlbumSharing] Email sent for: "${entry.album.albumTitle}"`);
      } else {
        emailsFailed++;
        Logger.log(
          `[auditAlbumSharing] Email send failed for "${entry.album.albumTitle}": ` +
          emailResult.message
        );
      }
    } catch (err) {
      emailsFailed++;
      Logger.log(
        `[auditAlbumSharing] Unexpected error sending email for ` +
        `"${entry.album.albumTitle}": ${String(err)}`
      );
    }
  }

  Logger.log(
    `[auditAlbumSharing] Done — ${emailsSent} email(s) sent, ${emailsFailed} failed.`
  );
}

// ─── Album reconciliation ────────────────────────────────────────────────────

/**
 * Reconciles the Photo_Albums sheet against the live list of albums this app
 * owns in Google Photos. Writes the report to the "Reconciliation" tab in
 * the main spreadsheet AND emails a summary to the album-admin mailbox.
 *
 * Run this:
 *   • Manually from the GAS Script Editor (select function → Run) whenever
 *     the public Albums sheet has rows that look stale or "My albums" in
 *     photos.google.com shows entries that don't appear in the spreadsheet.
 *   • Or set up a weekly time-driven trigger (Triggers → Add trigger →
 *     reconcileAlbums → Time-driven → Week timer).
 *
 * Output channels:
 *   1. The "Reconciliation" tab in the main spreadsheet (rewritten in place).
 *      Visit it from Photo_Albums for a side-by-side comparison.
 *   2. An email summary to getAlbumAdminEmail() (defaults to
 *      admin@mmrunners.org), sent only when drift is detected.
 *
 * Drift categories surfaced:
 *   - Orphan in Sheet — Photo_Albums row exists, but the Photos album is
 *     gone. Usually means an admin deleted the album in photos.google.com.
 *   - Orphan in Photos — Album exists in Photos but no Photo_Albums row.
 *     Often a backfill that bypassed the create-album flow, or a manual
 *     test album.
 *   - Matched (drift) — Both sides exist, but title or count disagrees.
 *     Self-heals on the next sync; flagged for visibility.
 *
 * Super-admin only — guarded by Session.getActiveUser().
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function reconcileAlbums(): void {
  const callerEmail = Session.getActiveUser().getEmail().toLowerCase();
  if (!getSuperAdmins().includes(callerEmail)) {
    Logger.log(`[reconcileAlbums] Permission denied for ${callerEmail}`);
    return;
  }
  Logger.log(`[reconcileAlbums] Started by ${callerEmail}`);

  const report = buildReconciliationReport();
  Logger.log(
    `[reconcileAlbums] Sheet=${report.checkedSheet}, Photos=${report.checkedPhotos}, ` +
    `OrphansSheet=${report.orphansInSheet.length}, ` +
    `OrphansPhotos=${report.orphansInPhotos.length}, ` +
    `Drift=${report.matchedDrift.length}` +
    (report.photosApiError ? `, ApiError=${report.photosApiError}` : '')
  );

  const rowsWritten = writeReconciliationTab(report);
  Logger.log(`[reconcileAlbums] ${rowsWritten} row(s) written to ${RECONCILIATION_TAB}`);

  // Build a deep-link to the Reconciliation tab so the email lands the user
  // exactly where they need to take action. Without a #gid we'd send them
  // to the first sheet of the workbook.
  const config = getConfig();
  const ss = SpreadsheetApp.openById(config.SPREADSHEET_ID);
  const tab = ss.getSheetByName(RECONCILIATION_TAB);
  const gid = tab ? tab.getSheetId() : 0;
  const spreadsheetUrl =
    `https://docs.google.com/spreadsheets/d/${config.SPREADSHEET_ID}/edit#gid=${gid}`;

  const recipients = [getAlbumAdminEmail()];
  const emailResult = notifyAlbumReconciliationReport(
    {
      orphansInSheet:  report.orphansInSheet.length,
      orphansInPhotos: report.orphansInPhotos.length,
      matchedDrift:    report.matchedDrift.length,
      checkedSheet:    report.checkedSheet,
      checkedPhotos:   report.checkedPhotos,
      photosApiError:  report.photosApiError,
      spreadsheetUrl,
    },
    recipients,
  );

  if (emailResult.status === 'success') {
    Logger.log(
      `[reconcileAlbums] Email sent to ${(emailResult.data?.to ?? []).join(', ') || '(no recipients)'}`
    );
  } else {
    Logger.log(`[reconcileAlbums] Email send failed: ${emailResult.message}`);
  }
}

// ─── Legacy migration ─────────────────────────────────────────────────────────

/**
 * One-time migration helper (Phase 7). Run from the GAS Script Editor console.
 * Idempotent. See migrationService.ts for full documentation.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function runLegacyMigration(dryRun = true): ReturnType<typeof migrateFromLegacy> {
  Logger.log(`[runLegacyMigration] Invoked with dryRun=${dryRun}`);
  const result = migrateFromLegacy({ dryRun });
  Logger.log('[runLegacyMigration] Result: ' + JSON.stringify(result));
  return result;
}

// ─── OAuth scope warmer ───────────────────────────────────────────────────────

/**
 * Dev-only: touches every scope in the manifest so a single consent dialog
 * grants them all. Remove after first-deploy authorization is complete.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function warmAllScopes(): void {
  const props   = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty('SPREADSHEET_ID') ?? '';

  try { if (sheetId) SpreadsheetApp.openById(sheetId); } catch (e) { console.log('[warm] Spreadsheet:', e); }
  try { DriveApp.getRootFolder(); }                     catch (e) { console.log('[warm] Drive:',       e); }
  try { UrlFetchApp.fetch('https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=x'); }
                                                         catch (e) { console.log('[warm] UrlFetch:',   e); }
  try { Session.getActiveUser().getEmail(); }            catch (e) { console.log('[warm] Session:',    e); }
  try { ScriptApp.getService().getUrl(); }               catch (e) { console.log('[warm] ScriptApp:',  e); }
}
