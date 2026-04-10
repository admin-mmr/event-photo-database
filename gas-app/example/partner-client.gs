/**
 * partner-client.gs — 湘舍动公益文件系统 API Client Example
 * ─────────────────────────────────────────────────────────────────────────────
 * Copy this file into your own Google Apps Script project to upload photos
 * to 湘舍动 from your club's GAS automation (e.g. post-race scripts).
 *
 * Prerequisites
 * ─────────────
 *   1. Your club email has been registered in 湘舍动 with role = "api_client".
 *      Ask an admin to set this up — they use the Admin → Users page.
 *
 *   2. Set the following Script Properties in your GAS project:
 *        XIANGSHEIDONG_BASE_URL  → the deployed web app URL
 *                                  (e.g. https://script.google.com/macros/s/…/exec)
 *        XIANGSHEIDONG_API_KEY   → your registered api_client email address
 *
 *      In the GAS editor: Extensions → Apps Script → Project Settings → Script Properties
 *
 * Rate limits
 * ───────────
 *   Each API key is limited to 60 requests per hour.
 *   If you exceed this, you will receive a { "code": 429 } error. Wait until
 *   the next hour window to retry. Each file upload = 1 request, so upload
 *   large batches in scheduled triggers spread across multiple hours if needed.
 *
 * Error handling
 * ──────────────
 *   All responses use the shape: { status, code, message, data? }
 *   status === "success" (code 200) → check data for the result
 *   status === "error"              → check message for the reason
 *   code 401  → invalid or missing api_key
 *   code 403  → key exists but lacks API_CLIENT role
 *   code 404  → event name not found
 *   code 429  → rate limit exceeded
 *   code 500  → internal server error (contact admin)
 */

// ─── Configuration ─────────────────────────────────────────────────────────────

/**
 * Reads the base URL and API key from Script Properties.
 * Throws a descriptive error if either is missing.
 */
function getApiConfig_() {
  var props = PropertiesService.getScriptProperties();
  var baseUrl = props.getProperty('XIANGSHEIDONG_BASE_URL');
  var apiKey  = props.getProperty('XIANGSHEIDONG_API_KEY');

  if (!baseUrl) throw new Error(
    'Missing Script Property: XIANGSHEIDONG_BASE_URL. ' +
    'Set it in Project Settings → Script Properties.'
  );
  if (!apiKey) throw new Error(
    'Missing Script Property: XIANGSHEIDONG_API_KEY. ' +
    'Set it in Project Settings → Script Properties.'
  );

  return { baseUrl: baseUrl.replace(/\/$/, ''), apiKey: apiKey };
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolves an event name to its Drive folder information.
 *
 * @param {string} eventName  Human-readable event name, e.g. "NYC Marathon"
 * @returns {{ found, eventId, eventName, eventDate, driveFolderId } | { found: false }}
 *
 * Example:
 *   var result = checkFolder('NYC Marathon');
 *   if (result.found) {
 *     Logger.log('Folder ID: ' + result.driveFolderId);
 *   }
 */
function checkFolder(eventName) {
  var cfg = getApiConfig_();
  var url = cfg.baseUrl
    + '?action=api_check_folder'
    + '&api_key=' + encodeURIComponent(cfg.apiKey)
    + '&event_name=' + encodeURIComponent(eventName);

  var res  = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var body = JSON.parse(res.getContentText());

  if (body.status !== 'success') {
    throw new Error('[checkFolder] ' + body.message + ' (code ' + body.code + ')');
  }
  return body.data;
}

/**
 * Lists all files already uploaded to a club folder.
 * Use this to perform your own duplicate-detection before uploading.
 *
 * @param {string} clubFolderId  The Layer-2 club Drive folder ID.
 *                               Pass the clubFolderId returned by uploadFile().
 * @returns {{ files: Array<{ name, fileId, sizeBytes, batchFolderName }>, count: number }}
 *
 * Example:
 *   var existing = listFiles(clubFolderId);
 *   Logger.log('Already uploaded: ' + existing.count + ' files');
 */
function listFiles(clubFolderId) {
  var cfg = getApiConfig_();
  var url = cfg.baseUrl
    + '?action=api_list_files'
    + '&api_key=' + encodeURIComponent(cfg.apiKey)
    + '&folder_id=' + encodeURIComponent(clubFolderId);

  var res  = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var body = JSON.parse(res.getContentText());

  if (body.status !== 'success') {
    throw new Error('[listFiles] ' + body.message + ' (code ' + body.code + ')');
  }
  return body.data;
}

/**
 * Uploads a single photo file from Google Drive into 湘舍动.
 *
 * The file must be a JPEG, PNG, or HEIC image. It will be placed in a
 * new batch folder inside the club subfolder for the named event.
 *
 * @param {string} eventName   Human-readable event name (must already exist in the system).
 * @param {string} clubName    Normalized club folder name, e.g. "New_Bee".
 * @param {string} driveFileId Google Drive file ID of the photo to upload.
 * @returns {{
 *   fileId, fileName, sizeBytes,
 *   batchFolderId, batchFolderName, clubFolderId, logId
 * }}
 *
 * Example:
 *   var result = uploadFile('NYC Marathon', 'New_Bee', '1aBcDeFgHiJkLmNoPqRsT');
 *   Logger.log('Uploaded as: ' + result.fileName + ' (' + result.sizeBytes + ' bytes)');
 *   Logger.log('Club folder: ' + result.clubFolderId);
 */
function uploadFile(eventName, clubName, driveFileId) {
  var cfg  = getApiConfig_();
  var file = DriveApp.getFileById(driveFileId);

  // Validate MIME type before sending
  var mime = file.getMimeType();
  var allowed = ['image/jpeg', 'image/png', 'image/heic'];
  if (allowed.indexOf(mime) === -1) {
    throw new Error(
      '[uploadFile] Unsupported file type: ' + mime + '. ' +
      'Only JPEG, PNG, and HEIC images are accepted.'
    );
  }

  // Read and base64-encode the file content
  var bytes      = file.getBlob().getBytes();
  var base64Data = Utilities.base64Encode(bytes);

  var payload = JSON.stringify({
    api_key:     cfg.apiKey,
    event_name:  eventName,
    club_name:   clubName,
    file_name:   file.getName(),
    mime_type:   mime,
    base64_data: base64Data,
  });

  var url = cfg.baseUrl + '?action=api_upload_file';
  var options = {
    method:             'post',
    contentType:        'application/json',
    payload:            payload,
    muteHttpExceptions: true,
  };

  var res  = UrlFetchApp.fetch(url, options);
  var body = JSON.parse(res.getContentText());

  if (body.status !== 'success') {
    throw new Error('[uploadFile] ' + body.message + ' (code ' + body.code + ')');
  }
  return body.data;
}

// ─── Batch upload helper ───────────────────────────────────────────────────────

/**
 * Uploads all JPEG/PNG/HEIC files from a Google Drive folder to an event.
 *
 * Skips files that already exist in the club folder (same name + same size).
 * Logs each result to the Apps Script execution log.
 *
 * Rate limit: this function uploads files one by one. If your folder contains
 * more than 60 files, split the run across multiple time-triggered executions.
 *
 * @param {string} eventName     Human-readable event name.
 * @param {string} clubName      Normalized club folder name.
 * @param {string} sourceFolderId Drive folder ID containing the photos to upload.
 * @returns {{ uploaded: number, skipped: number, failed: number }}
 *
 * Example:
 *   var summary = uploadFolder('NYC Marathon', 'New_Bee', '1aBcDeFgHiJkLmNoPqRsT');
 *   Logger.log('Done: ' + JSON.stringify(summary));
 */
function uploadFolder(eventName, clubName, sourceFolderId) {
  var cfg = getApiConfig_();

  // Step 1: verify event exists
  var folderInfo = checkFolder(eventName);
  if (!folderInfo.found) {
    throw new Error('[uploadFolder] Event not found: "' + eventName + '"');
  }

  // Step 2: build a set of existing files for duplicate detection
  // (clubFolderId is unknown until the first upload; skip pre-check on empty folder)
  var existingNames = {};  // { "filename|size": true }

  // Step 3: iterate source folder
  var folder  = DriveApp.getFolderById(sourceFolderId);
  var files   = folder.getFiles();
  var allowed = ['image/jpeg', 'image/png', 'image/heic'];

  var uploaded = 0, skipped = 0, failed = 0;
  var clubFolderId = null;

  while (files.hasNext()) {
    var file = files.next();
    var mime = file.getMimeType();
    if (allowed.indexOf(mime) === -1) {
      Logger.log('[SKIP] ' + file.getName() + ' — unsupported type: ' + mime);
      skipped++;
      continue;
    }

    // Lazy-load existing files after the first upload creates the club folder
    var key = file.getName().toLowerCase() + '|' + file.getSize();
    if (clubFolderId && existingNames[key]) {
      Logger.log('[SKIP] ' + file.getName() + ' — duplicate (name + size match)');
      skipped++;
      continue;
    }

    try {
      var result = uploadFile(eventName, clubName, file.getId());
      Logger.log('[OK]   ' + result.fileName + ' (' + result.sizeBytes + ' bytes)');
      uploaded++;

      // Capture club folder ID on first success so we can list existing files
      if (!clubFolderId && result.clubFolderId) {
        clubFolderId = result.clubFolderId;
        try {
          var existing = listFiles(clubFolderId);
          existing.files.forEach(function (f) {
            existingNames[f.name.toLowerCase() + '|' + f.sizeBytes] = true;
          });
        } catch (listErr) {
          Logger.log('[WARN] Could not load existing files for duplicate check: ' + listErr);
        }
      }
    } catch (err) {
      Logger.log('[FAIL] ' + file.getName() + ' — ' + err.message);
      failed++;
    }
  }

  Logger.log(
    '[uploadFolder] Done — uploaded: ' + uploaded +
    ', skipped: ' + skipped + ', failed: ' + failed
  );
  return { uploaded: uploaded, skipped: skipped, failed: failed };
}

// ─── Quick smoke test (run manually from the GAS editor) ──────────────────────

/**
 * Run this function once from the GAS editor to verify your credentials.
 * It calls api_check_folder with the provided event name and logs the result.
 *
 * Edit the eventName below to match a real event in the system.
 */
function smokeTest() {
  var eventName = 'NYC Marathon'; // ← change to a real event name
  try {
    var result = checkFolder(eventName);
    Logger.log('smokeTest PASSED');
    Logger.log(JSON.stringify(result, null, 2));
  } catch (err) {
    Logger.log('smokeTest FAILED: ' + err.message);
  }
}
