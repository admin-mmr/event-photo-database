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
import './routes/reportHandlers';
import './routes/linkHandlers';
import './routes/volunteerRoutes';
import './routes/uploadPrepRoutes';
import './routes/publicSheetHandlers';
import './routes/duplicateHandlers';

// ─── Remaining direct imports used by functions declared below ────────────────
import { handleGet, handlePost } from './routes/router';
import { purgeDeletedFiles as _purgeDeletedFiles } from './services/deleteService';
import { migrateFromLegacy } from './services/migrationService';
import { rebuildPublicFoldersIndex as _rebuildPublicFoldersIndex } from './services/publicSpreadsheetService';
import {
  backfillSpecialFoldersSharing as _backfillSpecialFoldersSharing,
  getLatestRefreshedAt,
} from './services/specialFoldersService';
import { getLatestUploadTimestamp } from './services/uploadLogService';
import { getSuperAdmins } from './config/superAdmins';
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

// ─── Public folder index spreadsheet ─────────────────────────────────────────

/**
 * Rebuilds the public, view-only folder index spreadsheet from scratch.
 *
 * Writes two tabs:
 *   - "Photo Folders" — one row per Photos_NNN Drive bucket (event-level).
 *   - "Video Folders" — one row per (event, club, tag) Videos folder.
 *
 * Use this when:
 *   - Setting up the feature for the first time after configuring
 *     PUBLIC_ALBUM_INDEX_SHEET_ID in Script Properties (the property name is
 *     kept for backward compatibility; treat it as the public spreadsheet ID).
 *   - Recovering from a corrupted public sheet — the function clears + rewrites
 *     both tabs.
 *   - You manually edited Special_Folders in the database and want the public
 *     view to catch up immediately.
 *
 * Day-to-day refreshes happen automatically after upload batches and folder
 * creation (see publicSpreadsheetService.tryRebuildPublicFoldersIndex call
 * sites), so this is only for manual / recovery use.
 *
 * Super-admin only — guarded by Session.getActiveUser().
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function rebuildPublicFoldersIndex(): void {
  const callerEmail = Session.getActiveUser().getEmail();
  if (!getSuperAdmins().includes(callerEmail.toLowerCase())) {
    Logger.log(`[rebuildPublicFoldersIndex] Permission denied for ${callerEmail}`);
    return;
  }
  Logger.log(`[rebuildPublicFoldersIndex] Manual rebuild started by ${callerEmail}`);
  const rowCount = _rebuildPublicFoldersIndex();
  Logger.log(`[rebuildPublicFoldersIndex] Done — ${rowCount} row(s) written`);
}

/**
 * One-shot routine to share every Drive shortcut folder
 * ("Anyone with link → Viewer") tracked in Special_Folders.
 *
 * Run this once after the sharing hook is deployed so historical Photos_NNN
 * and Videos folders become public; new folders created from then on are
 * shared automatically at creation time by specialFoldersService.
 *
 * Idempotent — safe to re-run any time. Super-admin guarded.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function backfillSpecialFoldersSharing(): void {
  const callerEmail = Session.getActiveUser().getEmail();
  if (!getSuperAdmins().includes(callerEmail.toLowerCase())) {
    Logger.log(`[backfillSpecialFoldersSharing] Permission denied for ${callerEmail}`);
    return;
  }
  Logger.log(`[backfillSpecialFoldersSharing] Started by ${callerEmail}`);
  const summary = _backfillSpecialFoldersSharing();
  Logger.log(
    `[backfillSpecialFoldersSharing] Done — created=${summary.created} ` +
    `alreadyShared=${summary.alreadyShared} errors=${summary.errors}`
  );
}

// ─── Public-sheet scheduled refresh trigger ──────────────────────────────────

/**
 * Trigger handler invoked by the time-driven trigger every 30 minutes.
 *
 * Two-phase refresh:
 *   1. Rebuild every event's Photos_NNN buckets so any new photos that were
 *      uploaded without a successful post-upload hook still get a shortcut.
 *   2. Rewrite the public folder index spreadsheet so visitors see the
 *      latest folder list.
 *
 * Errors are logged but never thrown — a transient Drive / Sheets failure on
 * a single event must not abort the run for the rest. This function is the
 * SAFETY NET for the post-upload hot path in serverCompleteVolunteerUpload;
 * day-to-day freshness comes from that hot path, this trigger heals anything
 * that silently slipped through.
 *
 * Public on purpose so GAS's trigger UI can dispatch to it. Not callable
 * from google.script.run (no auth gate — only the trigger framework calls it).
 *
 * Install / uninstall via installPublicSheetRefreshTrigger() /
 * removePublicSheetRefreshTrigger() below (run them from the GAS editor as
 * the script owner).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function scheduledPublicSheetRefresh(): void {
  Logger.log('[scheduledPublicSheetRefresh] Starting periodic refresh');

  try {
    const rows = _rebuildPublicFoldersIndex();
    Logger.log(`[scheduledPublicSheetRefresh] Wrote ${rows} row(s) to public sheet`);
  } catch (err) {
    Logger.log(`[scheduledPublicSheetRefresh] Public sheet rewrite failed: ${String(err)}`);
  }
}

/**
 * Installs the 2-hour time-driven trigger for scheduledPublicSheetRefresh
 * (force update — always rewrites the public sheet unconditionally).
 *
 * Run ONCE from the GAS editor (Run → installPublicSheetRefreshTrigger) as the
 * script owner. Idempotent — if a trigger for this function already exists,
 * the existing one is removed first so we never accumulate duplicates.
 *
 * Why 2 hours:
 *   Day-to-day freshness comes from two sources:
 *     1. The post-upload hot path (tryRebuildPublicFoldersIndex after each
 *        successful batch) — near-real-time on the happy path.
 *     2. The lazy trigger (scheduledPublicSheetRefreshLazy, every 15 min) —
 *        catches any upload whose hot-path hook misfired.
 *   This force trigger is the last-resort safety net: it heals edge cases
 *   the lazy check cannot see (e.g. a super-admin manually edited
 *   Special_Folders, or an Upload_Log row has a corrupted timestamp). 2 hours
 *   is more than enough for those rare scenarios without burning quota.
 *
 *   Run installPublicSheetRefreshLazyTrigger() as well to get the faster
 *   lazy check alongside this force rebuild.
 *
 * Super-admin only — guarded by Session.getActiveUser() so a club_admin
 * who somehow reached this function can't reshape the deployment's triggers.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function installPublicSheetRefreshTrigger(): void {
  const callerEmail = Session.getActiveUser().getEmail();
  if (!getSuperAdmins().includes(callerEmail.toLowerCase())) {
    Logger.log(`[installPublicSheetRefreshTrigger] Permission denied for ${callerEmail}`);
    return;
  }

  // Remove existing triggers for the same handler to keep the install idempotent.
  let removed = 0;
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'scheduledPublicSheetRefresh') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  }

  ScriptApp.newTrigger('scheduledPublicSheetRefresh')
    .timeBased()
    .everyHours(2)
    .create();

  Logger.log(
    `[installPublicSheetRefreshTrigger] Installed — replaced ${removed} existing trigger(s); ` +
    `next run within 2 hours`
  );
}

/**
 * Removes the force-update scheduled trigger (e.g. before tearing down a deployment).
 * Idempotent — removing when nothing is installed is a no-op.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function removePublicSheetRefreshTrigger(): void {
  const callerEmail = Session.getActiveUser().getEmail();
  if (!getSuperAdmins().includes(callerEmail.toLowerCase())) {
    Logger.log(`[removePublicSheetRefreshTrigger] Permission denied for ${callerEmail}`);
    return;
  }
  let removed = 0;
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'scheduledPublicSheetRefresh') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  }
  Logger.log(`[removePublicSheetRefreshTrigger] Removed ${removed} trigger(s)`);
}

// ─── Lazy public-sheet refresh trigger ──────────────────────────────────────

/**
 * Lazy variant of scheduledPublicSheetRefresh. Fires every 15 minutes but
 * skips the actual rebuild when nothing new has arrived since the last
 * shortcut sync — keeping quota consumption near-zero on days with no uploads.
 *
 * Decision rule (all comparisons are ISO 8601 string lexicographic, which is
 * equivalent to chronological ordering for the timestamps we generate):
 *
 *   latestUpload  = max uploadTimestamp across all Upload_Log rows
 *   latestRefresh = max lastRefreshedAt across all Special_Folders rows
 *
 *   if latestUpload is null           → no uploads ever; skip (nothing to publish)
 *   if latestRefresh is null          → shortcuts not yet built; run rebuild
 *   if latestUpload > latestRefresh   → new upload arrived after last shortcut
 *                                       sync; run rebuild
 *   otherwise                         → public sheet is current; skip
 *
 * Why this is sufficient:
 *   On the happy upload path:
 *     upload finishes → tryRebuildSpecialFoldersForBatch updates lastRefreshedAt
 *     → tryRebuildPublicFoldersIndex rewrites the public sheet.
 *   So normally latestRefresh ≥ latestUpload and this trigger is a pure no-op.
 *   When the hot-path hook misfires (transient Drive error, GAS timeout),
 *   latestUpload > latestRefresh and this trigger catches it within 15 min.
 *
 * Edge cases handled:
 *   - Empty Upload_Log (no uploads ever) → safe skip; nothing to publish.
 *   - Empty Special_Folders (shortcuts never built) → trigger runs so the
 *     public sheet at least gets an up-to-date (empty) index.
 *   - Corrupted/null timestamps → conservative: treated as "something may have
 *     changed", trigger runs.
 *
 * Not callable from google.script.run — only the trigger framework invokes it.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function scheduledPublicSheetRefreshLazy(): void {
  Logger.log('[scheduledPublicSheetRefreshLazy] Checking whether refresh is needed');

  let latestUpload: string | null = null;
  let latestRefresh: string | null = null;

  try {
    latestUpload = getLatestUploadTimestamp();
  } catch (err) {
    Logger.log(`[scheduledPublicSheetRefreshLazy] Could not read Upload_Log: ${String(err)} — running rebuild to be safe`);
  }

  try {
    latestRefresh = getLatestRefreshedAt();
  } catch (err) {
    Logger.log(`[scheduledPublicSheetRefreshLazy] Could not read Special_Folders: ${String(err)} — running rebuild to be safe`);
  }

  // No uploads at all — nothing to publish yet.
  if (latestUpload === null) {
    Logger.log('[scheduledPublicSheetRefreshLazy] Upload_Log is empty — skipping (nothing to publish)');
    return;
  }

  // latestRefresh being null means shortcuts have never been built yet — run so
  // the public sheet at least renders an empty (but valid) index.
  if (latestRefresh !== null && latestUpload <= latestRefresh) {
    Logger.log(
      `[scheduledPublicSheetRefreshLazy] Up to date ` +
      `(latestUpload=${latestUpload} ≤ latestRefresh=${latestRefresh}) — skipping`
    );
    return;
  }

  Logger.log(
    `[scheduledPublicSheetRefreshLazy] Stale detected ` +
    `(latestUpload=${latestUpload ?? 'n/a'}, latestRefresh=${latestRefresh ?? 'none'}) — rebuilding`
  );

  try {
    const rows = _rebuildPublicFoldersIndex();
    Logger.log(`[scheduledPublicSheetRefreshLazy] Wrote ${rows} row(s) to public sheet`);
  } catch (err) {
    Logger.log(`[scheduledPublicSheetRefreshLazy] Public sheet rewrite failed: ${String(err)}`);
  }
}

/**
 * Installs the 15-minute time-driven trigger for scheduledPublicSheetRefreshLazy.
 *
 * Run ONCE from the GAS editor alongside installPublicSheetRefreshTrigger().
 * Idempotent — removes any pre-existing trigger for the same handler first.
 *
 * Why 15 minutes:
 *   The lazy check is extremely cheap: two sheet reads + a string compare.
 *   Running every 15 minutes means a missed hot-path refresh is visible to
 *   public viewers within 15 minutes, without meaningful quota cost on days
 *   with no activity (the trigger bails in milliseconds when nothing changed).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function installPublicSheetRefreshLazyTrigger(): void {
  const callerEmail = Session.getActiveUser().getEmail();
  if (!getSuperAdmins().includes(callerEmail.toLowerCase())) {
    Logger.log(`[installPublicSheetRefreshLazyTrigger] Permission denied for ${callerEmail}`);
    return;
  }

  let removed = 0;
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'scheduledPublicSheetRefreshLazy') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  }

  ScriptApp.newTrigger('scheduledPublicSheetRefreshLazy')
    .timeBased()
    .everyMinutes(15)
    .create();

  Logger.log(
    `[installPublicSheetRefreshLazyTrigger] Installed — replaced ${removed} existing trigger(s); ` +
    `next run within 15 minutes`
  );
}

/**
 * Removes the lazy scheduled trigger. Idempotent.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function removePublicSheetRefreshLazyTrigger(): void {
  const callerEmail = Session.getActiveUser().getEmail();
  if (!getSuperAdmins().includes(callerEmail.toLowerCase())) {
    Logger.log(`[removePublicSheetRefreshLazyTrigger] Permission denied for ${callerEmail}`);
    return;
  }
  let removed = 0;
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'scheduledPublicSheetRefreshLazy') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  }
  Logger.log(`[removePublicSheetRefreshLazyTrigger] Removed ${removed} trigger(s)`);
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
