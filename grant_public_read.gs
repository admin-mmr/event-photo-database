/**
 * grant_public_read.gs — ONE-OFF remediation tool.
 *
 * Recursively grants "Anyone with the link → Viewer" (role=reader, type=anyone)
 * on EVERYTHING reachable from a root folder:
 *   • the root folder itself
 *   • every sub-folder
 *   • every real file (e.g. the Photos_NNN materialized JPGs)
 *   • every SHORTCUT's TARGET file (Album/ and Videos/ shortcuts) — this is the
 *     bit that actually fixes "can't download the shortcut", because a Drive
 *     shortcut inherits the TARGET's permissions, not the folder's.
 *
 * How to run
 * ──────────
 *  1. Paste this file into the Apps Script editor of a project that already
 *     requests the `https://www.googleapis.com/auth/drive` scope (your gas-app
 *     project does). If you run it in a fresh standalone project, add that
 *     scope to the manifest first, or the permission writes will 403.
 *  2. Set ROOT_FOLDER_ID below.
 *  3. Run `grantPublicReadDryRun` once to see counts WITHOUT changing anything.
 *  4. Run `grantPublicRead` to apply. Re-run it until it logs "DONE — queue
 *     empty": Apps Script kills executions at ~6 min, so the script checkpoints
 *     its folder queue to ScriptProperties and resumes where it left off.
 *  5. When finished, run `grantPublicReadReset` to clear the saved checkpoint.
 *
 * Safe to re-run: re-granting an already-public item is a no-op ("exists").
 */

/* global DriveApp, UrlFetchApp, ScriptApp, PropertiesService, Logger, Utilities */

// ─── CONFIG ───────────────────────────────────────────────────────────────────

/** The folder to open up. Default = the folder from the bug report. */
var ROOT_FOLDER_ID = '1JBlePo8Fxwo7iHIlwcuI1cqgEBwhtOVg';

/** Stop this many ms before Apps Script's ~6-min cap and checkpoint. */
var TIME_BUDGET_MS = 5 * 60 * 1000;

var DRIVE_API = 'https://www.googleapis.com/drive/v3';
var QUEUE_PROP = 'GPR_PENDING_FOLDERS';

// ─── Entry points ───────────────────────────────────────────────────────────

function grantPublicReadDryRun() { run_(true); }
function grantPublicRead()       { run_(false); }

/** Clear the resume checkpoint (run after a completed pass, or to start over). */
function grantPublicReadReset() {
  PropertiesService.getScriptProperties().deleteProperty(QUEUE_PROP);
  Logger.log('Checkpoint cleared.');
}

// ─── Core walk ────────────────────────────────────────────────────────────────

/**
 * Forces Apps Script to request the full Drive scope.
 *
 * The walk uses raw UrlFetchApp calls to the Drive REST API, which the scope
 * auto-detector can't see — so without a literal DriveApp reference the project
 * never asks for auth/drive and every REST call 403s with "insufficient
 * authentication scopes". Referencing DriveApp here makes the editor request
 * `https://www.googleapis.com/auth/drive` on the next run. (Equivalent
 * alternative: add that scope to the manifest under Project Settings →
 * "Show appsscript.json" → oauthScopes.)
 */
function forceDriveScope_() {
  DriveApp.getRootFolder();
}

function run_(dryRun) {
  var start = Date.now();
  forceDriveScope_();
  var props = PropertiesService.getScriptProperties();

  // Resume from checkpoint if present; otherwise seed with the root and grant
  // the root folder itself.
  var pending;
  var saved = props.getProperty(QUEUE_PROP);
  if (saved) {
    pending = JSON.parse(saved);
    Logger.log('Resuming — ' + pending.length + ' folder(s) still queued.');
  } else {
    pending = [ROOT_FOLDER_ID];
    grantOne_(ROOT_FOLDER_ID, dryRun, 'root-folder');
  }

  var seenTargets = {};          // dedupe shortcut targets within this run
  var stats = { folders: 0, files: 0, shortcuts: 0, granted: 0, exists: 0, errors: 0 };

  while (pending.length > 0) {
    if (Date.now() - start > TIME_BUDGET_MS) {
      props.setProperty(QUEUE_PROP, JSON.stringify(pending));
      Logger.log('Time budget hit. Checkpointed ' + pending.length +
                 ' folder(s). Re-run grantPublicRead to continue.');
      logStats_(stats, dryRun);
      return;
    }

    var folderId = pending.shift();
    stats.folders++;

    var pageToken = null;
    do {
      var resp = listChildren_(folderId, pageToken);
      var files = resp.files || [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i];

        if (f.mimeType === 'application/vnd.google-apps.folder') {
          grantOne_(f.id, dryRun, 'folder:' + f.name, stats);
          pending.push(f.id);

        } else if (f.mimeType === 'application/vnd.google-apps.shortcut') {
          stats.shortcuts++;
          var targetId = f.shortcutDetails && f.shortcutDetails.targetId;
          if (targetId && !seenTargets[targetId]) {
            seenTargets[targetId] = true;
            grantOne_(targetId, dryRun, 'shortcut-target:' + f.name, stats);
          }
          // The shortcut object itself is harmless to leave as-is; its
          // visibility already follows the (now-shared) parent folder.

        } else {
          stats.files++;
          grantOne_(f.id, dryRun, 'file:' + f.name, stats);
        }
      }
      pageToken = resp.nextPageToken;
    } while (pageToken);
  }

  props.deleteProperty(QUEUE_PROP);
  Logger.log('DONE — queue empty.');
  logStats_(stats, dryRun);
}

// ─── Drive REST helpers ───────────────────────────────────────────────────────

/** List immediate children of a folder (one page). */
function listChildren_(folderId, pageToken) {
  var url = DRIVE_API + '/files'
    + '?q=' + encodeURIComponent("'" + folderId + "' in parents and trashed=false")
    + '&fields=' + encodeURIComponent('nextPageToken,files(id,name,mimeType,shortcutDetails(targetId))')
    + '&pageSize=1000'
    + '&supportsAllDrives=true&includeItemsFromAllDrives=true'
    + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');

  var r = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  if (r.getResponseCode() !== 200) {
    Logger.log('LIST FAILED for ' + folderId + ': HTTP ' + r.getResponseCode() +
               ' ' + r.getContentText().slice(0, 200));
    return { files: [] };
  }
  return JSON.parse(r.getContentText());
}

/** Grant Anyone→reader on a single file/folder ID. Idempotent. */
function grantOne_(fileId, dryRun, label, stats) {
  if (dryRun) {
    Logger.log('[DRY] would grant: ' + label + ' (' + fileId + ')');
    if (stats) stats.granted++;
    return;
  }

  var url = DRIVE_API + '/files/' + encodeURIComponent(fileId) + '/permissions'
    + '?supportsAllDrives=true&sendNotificationEmail=false&fields=id';
  var body = { role: 'reader', type: 'anyone', allowFileDiscovery: false };

  var r = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  var code = r.getResponseCode();
  var text = r.getContentText();
  if (code >= 200 && code < 300) {
    if (stats) stats.granted++;
  } else if (code === 400 && /duplicate|exist/i.test(text)) {
    if (stats) stats.exists++;                      // already public — fine
  } else {
    if (stats) stats.errors++;
    Logger.log('GRANT FAILED ' + label + ' (' + fileId + '): HTTP ' + code +
               ' ' + text.slice(0, 200));
  }
}

function logStats_(s, dryRun) {
  Logger.log((dryRun ? '[DRY RUN] ' : '') +
    'folders=' + s.folders + ' files=' + s.files + ' shortcuts=' + s.shortcuts +
    ' | granted=' + s.granted + ' alreadyPublic=' + s.exists + ' errors=' + s.errors);
}
