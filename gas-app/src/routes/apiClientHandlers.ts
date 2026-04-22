import { ResultStatus, PhotoMimeType, UploadSource } from '../types/enums';
import { UserRecord } from '../types/models';
import { getAllRows } from '../services/sheetService';
import { toEventRecord } from '../utils/sheetMapper';
import {
  getOrCreateClubFolder,
  createBatchFolder,
  listFilesInClubFolder,
} from '../services/driveService';
import { appendUploadLog } from '../services/uploadLogService';
import { buildLayer3FolderName } from '../utils/folderNameValidator';
import { toBatchTimestamp } from '../utils/dateFormatter';
import { getConfig } from '../config/constants';

/* global ContentService, DriveApp, Utilities, Logger */

/**
 * ApiClientHandlers — HTTP handlers for the Phase 5 Cross-Org REST API.
 *
 * These handlers are called from the router when an `api_key` parameter
 * is present on the request, bypassing the GAS session auth flow.
 *
 * Every handler follows the same pipeline:
 *   1. Authenticate: validate the api_key
 *   2. Rate-limit: check + increment per-key hourly counter
 *   3. Validate: check required parameters
 *   4. Execute: call the appropriate service
 *   5. Respond: return a JSON envelope via jsonOk/jsonError
 *
 * Error response codes match HTTP semantics (carried in the JSON body,
 * since GAS doGet/doPost always returns HTTP 200).
 */

// ─── Response helpers ─────────────────────────────────────────────────────────

function jsonOk(
  data: unknown,
  message = 'OK'
): GoogleAppsScript.Content.TextOutput {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'success', code: 200, message, data }))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonError(
  message: string,
  code = 400
): GoogleAppsScript.Content.TextOutput {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'error', code, message }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── Auth + rate-limit pipeline ───────────────────────────────────────────────

/**
 * Runs the full API auth + rate-limit pipeline.
 *
 * NOTE: The API_CLIENT role has been removed as part of the Phase 1 redesign.
 * Machine-to-machine API access via api_key is deprecated; all uploads now go
 * through upload links. These handlers are retained temporarily for reference
 * but always return 410 Gone.
 */
function gatekeep(
  _apiKey: string
): { ok: true; user: UserRecord } | { ok: false; response: GoogleAppsScript.Content.TextOutput } {
  return {
    ok: false,
    response: jsonError(
      'The API key authentication method has been removed. Use upload links instead.',
      410
    ),
  };
}

// ─── Handler: api_check_folder ────────────────────────────────────────────────

/**
 * GET ?action=api_check_folder&api_key=<key>&event_name=<name>
 *
 * Resolves an event name to its Drive folder ID.
 * Matching is case-insensitive and trims whitespace.
 *
 * Returns:
 *   { eventId, eventName, eventDate, driveFolderId }  when found
 *   { found: false }                                  when not found
 */
export function handleApiCheckFolder(
  params: Record<string, string>
): GoogleAppsScript.Content.TextOutput {
  const gate = gatekeep(params['api_key'] ?? '');
  if (!gate.ok) return gate.response;

  const rawName = (params['event_name'] ?? '').trim();
  if (!rawName) {
    return jsonError('event_name parameter is required', 400);
  }

  const config = getConfig();
  let rows: unknown[][];
  try {
    rows = getAllRows(config.SHEET_NAMES.EVENTS);
  } catch (err) {
    return jsonError(`Failed to read Events sheet: ${String(err)}`, 500);
  }

  const needle = rawName.toLowerCase();
  const event = rows
    .map(toEventRecord)
    .find((r) => r !== null && r.eventName.toLowerCase() === needle);

  if (!event) {
    Logger.log(`[ApiCheckFolder] Event not found: "${rawName}"`);
    return jsonOk({ found: false }, `No event matching "${rawName}"`);
  }

  Logger.log(`[ApiCheckFolder] Found: ${event.eventName} (${event.driveFolderId})`);
  return jsonOk(
    {
      found: true,
      eventId:      event.eventId,
      eventName:    event.eventName,
      eventDate:    event.eventDate,
      driveFolderId: event.driveFolderId,
    },
    `Event found: ${event.eventName}`
  );
}

// ─── Handler: api_list_files ──────────────────────────────────────────────────

/**
 * GET ?action=api_list_files&api_key=<key>&folder_id=<clubFolderId>
 *
 * Lists all files inside a club folder (across all batch subfolders).
 * `folder_id` is the Layer-2 club folder ID as returned by the upload API
 * or retrieved from Drive directly.
 *
 * Returns: { files: ClubFolderFileEntry[] }
 */
export function handleApiListFiles(
  params: Record<string, string>
): GoogleAppsScript.Content.TextOutput {
  const gate = gatekeep(params['api_key'] ?? '');
  if (!gate.ok) return gate.response;

  const folderId = (params['folder_id'] ?? '').trim();
  if (!folderId) {
    return jsonError('folder_id parameter is required', 400);
  }

  const result = listFilesInClubFolder(folderId);
  if (result.status !== ResultStatus.SUCCESS || !result.data) {
    return jsonError(result.message, 500);
  }

  Logger.log(`[ApiListFiles] folder=${folderId}, count=${result.data.length}`);
  return jsonOk({ files: result.data, count: result.data.length }, result.message);
}

// ─── Handler: api_upload_file ─────────────────────────────────────────────────

/**
 * POST ?action=api_upload_file
 * Body (JSON):
 * {
 *   api_key:       string  — registered API_CLIENT email
 *   event_name:    string  — human-readable event name to look up
 *   club_name:     string  — normalized club folder name (e.g. "New_Bee")
 *   file_name:     string  — target filename including extension
 *   mime_type:     string  — must be image/jpeg, image/png, or image/heic
 *   base64_data:   string  — base64-encoded file content (no data URL prefix)
 * }
 *
 * Returns:
 * {
 *   fileId, fileName, sizeBytes,
 *   batchFolderId, batchFolderName, clubFolderId,
 *   logId
 * }
 *
 * The handler always creates a new batch folder for each API call.
 * Bulk uploads should batch files into a single session by calling the
 * web-app upload flow instead (see the partner-client example).
 */
export function handleApiUploadFile(
  body: Record<string, unknown>
): GoogleAppsScript.Content.TextOutput {
  const apiKey = String(body['api_key'] ?? '').trim().toLowerCase();
  const gate = gatekeep(apiKey);
  if (!gate.ok) return gate.response;

  const user = gate.user;

  // ── Validate payload ──────────────────────────────────────────────────────

  const eventName  = String(body['event_name']  ?? '').trim();
  const clubName   = String(body['club_name']   ?? '').trim();
  const fileName   = String(body['file_name']   ?? '').trim();
  const mimeType   = String(body['mime_type']   ?? '').trim();
  const base64Data = String(body['base64_data'] ?? '').trim();

  const missing: string[] = [];
  if (!eventName)  missing.push('event_name');
  if (!clubName)   missing.push('club_name');
  if (!fileName)   missing.push('file_name');
  if (!mimeType)   missing.push('mime_type');
  if (!base64Data) missing.push('base64_data');
  if (missing.length > 0) {
    return jsonError(`Missing required fields: ${missing.join(', ')}`, 400);
  }

  const config = getConfig();
  const allowed = config.PHOTO_MIME_TYPES as ReadonlyArray<string>;
  if (!allowed.includes(mimeType)) {
    return jsonError(
      `Unsupported mime_type "${mimeType}". Allowed: ${allowed.join(', ')}`,
      400
    );
  }

  // ── Resolve event → Drive folder ──────────────────────────────────────────

  let rows: unknown[][];
  try {
    rows = getAllRows(config.SHEET_NAMES.EVENTS);
  } catch (err) {
    return jsonError(`Failed to read Events sheet: ${String(err)}`, 500);
  }

  const needle = eventName.toLowerCase();
  const event = rows
    .map(toEventRecord)
    .find((r) => r !== null && r.eventName.toLowerCase() === needle);

  if (!event) {
    return jsonError(`Event not found: "${eventName}"`, 404);
  }

  // ── Ensure club folder (Layer 2) ──────────────────────────────────────────

  const clubResult = getOrCreateClubFolder(event.driveFolderId, clubName);
  if (clubResult.status !== ResultStatus.SUCCESS || !clubResult.data) {
    return jsonError(clubResult.message, 500);
  }
  const clubFolderId = clubResult.data.folderId;

  // ── Create batch folder (Layer 3) — one per API upload call ───────────────

  const timestamp = toBatchTimestamp(new Date());
  const safeUsername = apiKey.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const batchFolderName = buildLayer3FolderName(timestamp, safeUsername);

  const batchResult = createBatchFolder(clubFolderId, batchFolderName);
  if (batchResult.status !== ResultStatus.SUCCESS || !batchResult.data) {
    return jsonError(batchResult.message, 500);
  }
  const batchFolderId = batchResult.data.folderId;

  // ── Write file to Drive ───────────────────────────────────────────────────

  let file: GoogleAppsScript.Drive.File;
  try {
    const bytes = Utilities.base64Decode(base64Data);
    const blob  = Utilities.newBlob(bytes, mimeType as PhotoMimeType, fileName);
    const folder = DriveApp.getFolderById(batchFolderId);
    file = folder.createFile(blob);
  } catch (err) {
    return jsonError(`Failed to write file to Drive: ${String(err)}`, 500);
  }

  // ── Write Upload_Log entry ────────────────────────────────────────────────

  const sizeMb = file.getSize() / (1024 * 1024);
  const logResult = appendUploadLog({
    eventId:           event.eventId,
    clubName,
    uploadedBy:        user.email,
    batchFolderName,
    batchFolderId,
    fileCount:         1,
    totalSizeMb:       Math.round(sizeMb * 1000) / 1000,
    skippedDuplicates: 0,
    skippedNonPhoto:   0,
    source:            UploadSource.LINK,
  });

  Logger.log(
    `[ApiUploadFile] key=${apiKey}, event="${eventName}", club=${clubName}, ` +
    `file="${fileName}", batch=${batchFolderName}`
  );

  return jsonOk(
    {
      fileId:         file.getId(),
      fileName:       file.getName(),
      sizeBytes:      file.getSize(),
      batchFolderId,
      batchFolderName,
      clubFolderId,
      logId:          logResult.data?.logId ?? null,
    },
    `File "${fileName}" uploaded successfully`
  );
}
