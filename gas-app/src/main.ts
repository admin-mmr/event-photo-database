/**
 * main.ts — GAS Web App entry points and google.script.run server functions.
 *
 * doGet(e)  → delegates to Router.handleGet (page routing)
 * doPost(e) → delegates to Router.handlePost (JSON API routing)
 *
 * serverXxx functions are exposed to the browser via google.script.run.
 * They all authenticate the caller and enforce admin-only access where needed.
 */

import { ResultStatus, UserRole, UserStatus, UploadSource } from './types/enums';
import { authenticateRequest } from './middleware/authMiddleware';
import { requireRole } from './middleware/roleGuard';
import { handleGet, handlePost } from './routes/router';
import { createUser, deactivateUser, reactivateUser, updateUser } from './services/userService';
import { createEvent, updateEvent, listAll as listAllEvents, findById as findEventById } from './services/eventService';
import {
  scanAllViolations,
  getOrCreateClubFolder,
  getClubFolderTree,
  createBatchFolder,
} from './services/driveService';
import { appendUploadLog } from './services/uploadLogService';
import { generateSummary, summaryToCsv, buildExceptionEmailBody } from './services/summaryService';
import { buildLayer3FolderName } from './utils/folderNameValidator';
import { toBatchTimestamp } from './utils/dateFormatter';

/* global Logger, DriveApp, Utilities, MailApp */

// ─── Web App entry points ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function doGet(
  e: GoogleAppsScript.Events.DoGet
): GoogleAppsScript.HTML.HtmlOutput {
  return handleGet(e);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function doPost(
  e: GoogleAppsScript.Events.DoPost
): GoogleAppsScript.Content.TextOutput {
  return handlePost(e);
}

// ─── google.script.run server functions ──────────────────────────────────────

type ServerResponse = { status: string; message: string; data?: unknown; errors?: unknown };

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverCreateUser(
  payload: { email: string; runningClub: string; role: string }
): ServerResponse {
  try {
    const auth = requireAdminOrFail();
    if (!auth.ok) return auth.response;
    const result = createUser(
      { email: payload.email, runningClub: payload.runningClub, role: payload.role as UserRole },
      auth.adminEmail
    );
    return { status: result.status, message: result.message, data: result.data, errors: result.errors };
  } catch (err) {
    Logger.log(`serverCreateUser error: ${String(err)}`);
    return { status: 'error', message: 'Internal error creating user' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverUpdateUser(
  payload: { email: string; runningClub?: string; role?: string; status?: string }
): ServerResponse {
  try {
    const auth = requireAdminOrFail();
    if (!auth.ok) return auth.response;
    const result = updateUser(
      {
        email: payload.email,
        ...(payload.runningClub !== undefined && { runningClub: payload.runningClub }),
        ...(payload.role !== undefined && { role: payload.role as UserRole }),
        ...(payload.status !== undefined && { status: payload.status as UserStatus }),
      },
      auth.adminEmail
    );
    return { status: result.status, message: result.message, data: result.data, errors: result.errors };
  } catch (err) {
    Logger.log(`serverUpdateUser error: ${String(err)}`);
    return { status: 'error', message: 'Internal error updating user' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverDeactivateUser(payload: { email: string }): ServerResponse {
  try {
    const auth = requireAdminOrFail();
    if (!auth.ok) return auth.response;
    const result = deactivateUser(payload.email);
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverDeactivateUser error: ${String(err)}`);
    return { status: 'error', message: 'Internal error deactivating user' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverReactivateUser(payload: { email: string }): ServerResponse {
  try {
    const auth = requireAdminOrFail();
    if (!auth.ok) return auth.response;
    const result = reactivateUser(payload.email);
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverReactivateUser error: ${String(err)}`);
    return { status: 'error', message: 'Internal error reactivating user' };
  }
}

// ─── Event server functions ───────────────────────────────────────────────────

/**
 * google.script.run entry point for creating an event from the admin UI.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverCreateEvent(
  payload: { eventName: string; eventDate: string }
): ServerResponse {
  try {
    const auth = requireAdminOrFail();
    if (!auth.ok) return auth.response;

    const result = createEvent(
      { eventName: payload.eventName, eventDate: payload.eventDate },
      auth.adminEmail
    );
    return {
      status: result.status,
      message: result.message,
      data: result.data,
      errors: result.errors,
    };
  } catch (err) {
    Logger.log(`serverCreateEvent error: ${String(err)}`);
    return { status: 'error', message: 'Internal error creating event' };
  }
}

/**
 * google.script.run entry point for updating an event from the admin UI.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverUpdateEvent(
  payload: { eventId: string; eventName?: string; eventDate?: string }
): ServerResponse {
  try {
    const auth = requireAdminOrFail();
    if (!auth.ok) return auth.response;

    const result = updateEvent(
      {
        eventId: payload.eventId,
        ...(payload.eventName !== undefined && { eventName: payload.eventName }),
        ...(payload.eventDate !== undefined && { eventDate: payload.eventDate }),
      },
      auth.adminEmail
    );
    return {
      status: result.status,
      message: result.message,
      data: result.data,
      errors: result.errors,
    };
  } catch (err) {
    Logger.log(`serverUpdateEvent error: ${String(err)}`);
    return { status: 'error', message: 'Internal error updating event' };
  }
}

/**
 * google.script.run entry point for listing events.
 * Available to all authenticated users (needed by Phase 3 upload flow).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverListEvents(
  payload: { page?: number; pageSize?: number; sort?: string; dateFrom?: string; dateTo?: string }
): ServerResponse {
  try {
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const page = payload.page ?? 1;
    const pageSize = Math.min(payload.pageSize ?? 20, 100);
    const sort = (payload.sort === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';

    const result = listAllEvents(page, pageSize, sort);

    // Optional client-side date range filter
    let filtered = result.items as typeof result.items;
    if (payload.dateFrom) {
      filtered = filtered.filter((e) => e.eventDate >= payload.dateFrom!);
    }
    if (payload.dateTo) {
      filtered = filtered.filter((e) => e.eventDate <= payload.dateTo!);
    }

    return {
      status: 'success',
      message: `Found ${filtered.length} event(s)`,
      data: { items: filtered, total: filtered.length, page, pageSize },
    };
  } catch (err) {
    Logger.log(`serverListEvents error: ${String(err)}`);
    return { status: 'error', message: 'Internal error listing events' };
  }
}

/**
 * google.script.run entry point that triggers a full Drive folder scan.
 * Returns all naming violations found across Layer 1 and Layer 2.
 * Called from the admin events page on load (background, non-blocking).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverScanViolations(): ServerResponse {
  try {
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const result = scanAllViolations();
    return {
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (err) {
    Logger.log(`serverScanViolations error: ${String(err)}`);
    return { status: 'error', message: 'Internal error scanning violations' };
  }
}

// ─── Phase 3 — Upload flow server functions ───────────────────────────────────

/**
 * google.script.run entry point for the upload page's event picker.
 * Returns all events (with optional date-range filter) available for upload.
 * Identical to serverListEvents but named separately for clarity in the UI.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverListEventsForUpload(
  payload: { dateFrom?: string; dateTo?: string; sort?: string }
): ServerResponse {
  try {
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const sort = (payload.sort === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';
    const result = listAllEvents(1, 200, sort);

    let filtered = result.items as typeof result.items;
    if (payload.dateFrom) {
      filtered = filtered.filter((e) => e.eventDate >= payload.dateFrom!);
    }
    if (payload.dateTo) {
      filtered = filtered.filter((e) => e.eventDate <= payload.dateTo!);
    }

    return {
      status: 'success',
      message: `Found ${filtered.length} event(s)`,
      data: { items: filtered, total: filtered.length },
    };
  } catch (err) {
    Logger.log(`serverListEventsForUpload error: ${String(err)}`);
    return { status: 'error', message: 'Internal error listing events for upload' };
  }
}

/**
 * google.script.run entry point for reading the club's current folder tree.
 *
 * Called after the user selects an event. Returns the existing file list for
 * the club subfolder (so the UI can show what's already uploaded).
 * Does NOT create the club folder — that happens only when uploading.
 *
 * Payload: { eventFolderId: string, clubFolderName: string }
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverGetClubFolderTree(
  payload: { eventFolderId: string; clubFolderName: string }
): ServerResponse {
  try {
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const { eventFolderId, clubFolderName } = payload;
    if (!eventFolderId || !clubFolderName) {
      return { status: 'error', message: 'eventFolderId and clubFolderName are required' };
    }

    const result = getClubFolderTree(eventFolderId, clubFolderName);
    return {
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (err) {
    Logger.log(`serverGetClubFolderTree error: ${String(err)}`);
    return { status: 'error', message: 'Internal error fetching club folder tree' };
  }
}

/**
 * google.script.run entry point to ensure the club folder exists before upload.
 * Gets or creates the Layer 2 club folder inside the selected event folder.
 *
 * Called just before the actual file upload begins (Step 3 → Step 4 transition).
 *
 * Payload: { eventFolderId: string, clubFolderName: string }
 * Returns: { folderId: string, folderName: string }
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverEnsureClubFolder(
  payload: { eventFolderId: string; clubFolderName: string }
): ServerResponse {
  try {
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const { eventFolderId, clubFolderName } = payload;
    if (!eventFolderId || !clubFolderName) {
      return { status: 'error', message: 'eventFolderId and clubFolderName are required' };
    }

    const result = getOrCreateClubFolder(eventFolderId, clubFolderName);
    return {
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (err) {
    Logger.log(`serverEnsureClubFolder error: ${String(err)}`);
    return { status: 'error', message: 'Internal error ensuring club folder' };
  }
}

// ─── Phase 3 — Upload execution server functions ──────────────────────────────

/**
 * google.script.run entry point: creates the upload batch folder.
 *
 * Called once when the user confirms their file list and clicks "Upload".
 * Creates (or retrieves) the club folder, then creates a new timestamped
 * batch folder inside it. The returned IDs are used by subsequent
 * serverUploadFile calls.
 *
 * Payload: { eventFolderId, clubFolderName, usernameHint }
 * Returns: { batchFolderId, batchFolderName, clubFolderId }
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverStartUploadSession(payload: {
  eventFolderId: string;
  clubFolderName: string;
  usernameHint: string;   // Email local-part used in the batch folder name
}): ServerResponse {
  try {
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const { eventFolderId, clubFolderName, usernameHint } = payload;
    if (!eventFolderId || !clubFolderName) {
      return { status: 'error', message: 'eventFolderId and clubFolderName are required' };
    }

    // Ensure club folder exists (Layer 2)
    const clubResult = getOrCreateClubFolder(eventFolderId, clubFolderName);
    if (clubResult.status !== ResultStatus.SUCCESS || !clubResult.data) {
      return { status: 'error', message: clubResult.message };
    }

    // Build batch folder name: YYYYMMDD-HHMMSS_username
    const timestamp = toBatchTimestamp(new Date());
    const safeUsername = (usernameHint || authResult.data.email)
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '');
    const batchFolderName = buildLayer3FolderName(timestamp, safeUsername);

    // Create batch folder (Layer 3) — always new (unique timestamp)
    const batchResult = createBatchFolder(clubResult.data.folderId, batchFolderName);
    if (batchResult.status !== ResultStatus.SUCCESS || !batchResult.data) {
      return { status: 'error', message: batchResult.message };
    }

    return {
      status: 'success',
      message: `Upload session started: ${batchFolderName}`,
      data: {
        batchFolderId: batchResult.data.folderId,
        batchFolderName: batchResult.data.folderName,
        clubFolderId: clubResult.data.folderId,
      },
    };
  } catch (err) {
    Logger.log(`serverStartUploadSession error: ${String(err)}`);
    return { status: 'error', message: 'Internal error starting upload session' };
  }
}

/**
 * google.script.run entry point: uploads a single file to Drive.
 *
 * Receives the file as a base64-encoded string and writes it into the
 * given batch folder using DriveApp.createFile(blob). Called once per
 * file, sequentially, from the browser-side upload loop.
 *
 * GAS constraint: max ~50 MB per google.script.run argument.
 * Files larger than this are pre-filtered client-side and never sent.
 *
 * Payload: { batchFolderId, fileName, mimeType, base64Data }
 * Returns: { fileId, fileName, sizeBytes }
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverUploadFile(payload: {
  batchFolderId: string;
  fileName: string;
  mimeType: string;
  base64Data: string;  // base64-encoded file content (no data URL prefix)
}): ServerResponse {
  try {
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const { batchFolderId, fileName, mimeType, base64Data } = payload;
    if (!batchFolderId || !fileName || !base64Data) {
      return { status: 'error', message: 'batchFolderId, fileName, and base64Data are required' };
    }

    // Decode base64 → byte array → Drive Blob
    const bytes = Utilities.base64Decode(base64Data);
    const blob = Utilities.newBlob(bytes, mimeType || 'application/octet-stream', fileName);

    const folder = DriveApp.getFolderById(batchFolderId);
    const file = folder.createFile(blob);

    return {
      status: 'success',
      message: `File "${fileName}" uploaded`,
      data: {
        fileId: file.getId(),
        fileName: file.getName(),
        sizeBytes: file.getSize(),
      },
    };
  } catch (err) {
    Logger.log(`serverUploadFile error: ${String(err)}`);
    return { status: 'error', message: `Failed to upload file: ${String(err)}` };
  }
}

/**
 * google.script.run entry point: finalises the upload session.
 *
 * Called after all files have been uploaded (or attempted). Writes one
 * row to the Upload_Log sheet summarising the session. Returns the log
 * record so the UI can display the final summary screen.
 *
 * Payload: {
 *   eventId, clubFolderName, batchFolderName, batchFolderId,
 *   fileCount, totalSizeMb, skippedDuplicates, skippedNonPhoto
 * }
 * Returns: UploadLogRecord
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverCompleteUpload(payload: {
  eventId: string;
  clubFolderName: string;
  batchFolderName: string;
  batchFolderId: string;
  fileCount: number;
  totalSizeMb: number;
  skippedDuplicates: number;
  skippedNonPhoto: number;
}): ServerResponse {
  try {
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const result = appendUploadLog({
      eventId:           payload.eventId,
      clubName:          payload.clubFolderName,
      uploadedBy:        authResult.data.email,
      batchFolderName:   payload.batchFolderName,
      batchFolderId:     payload.batchFolderId,
      fileCount:         Number(payload.fileCount) || 0,
      totalSizeMb:       Number(payload.totalSizeMb) || 0,
      skippedDuplicates: Number(payload.skippedDuplicates) || 0,
      skippedNonPhoto:   Number(payload.skippedNonPhoto) || 0,
      source:            UploadSource.WEB_APP,
    });

    return {
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (err) {
    Logger.log(`serverCompleteUpload error: ${String(err)}`);
    return { status: 'error', message: 'Internal error completing upload session' };
  }
}

// ─── Phase 4 — Admin Summary server functions ─────────────────────────────────

/**
 * google.script.run entry point: generates a system summary report.
 *
 * Admin-only. Loads all events and upload logs, applies optional date filter,
 * groups uploads by event and club, and scans Drive for naming violations.
 *
 * Payload: { dateFrom?: string; dateTo?: string }   (ISO "YYYY-MM-DD")
 * Returns: SystemSummary
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverGetSummary(payload: {
  dateFrom?: string;
  dateTo?: string;
}): ServerResponse {
  try {
    const auth = requireAdminOrFail();
    if (!auth.ok) return auth.response;

    const result = generateSummary(payload.dateFrom, payload.dateTo);
    return {
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (err) {
    Logger.log(`serverGetSummary error: ${String(err)}`);
    return { status: 'error', message: 'Internal error generating summary' };
  }
}

/**
 * google.script.run entry point: generates a CSV string for download.
 *
 * Admin-only. Calls generateSummary() with the same date filters,
 * then serialises the result to a UTF-8 BOM CSV and returns the raw string.
 * The client receives this string and triggers a browser download via Blob.
 *
 * Payload: { dateFrom?: string; dateTo?: string }
 * Returns: { csv: string }   (the full CSV text)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverExportSummaryCsv(payload: {
  dateFrom?: string;
  dateTo?: string;
}): ServerResponse {
  try {
    const auth = requireAdminOrFail();
    if (!auth.ok) return auth.response;

    const result = generateSummary(payload.dateFrom, payload.dateTo);
    if (!result.data) {
      return { status: 'error', message: result.message };
    }

    const csv = summaryToCsv(result.data);
    return {
      status: 'success',
      message: 'CSV generated',
      data: { csv },
    };
  } catch (err) {
    Logger.log(`serverExportSummaryCsv error: ${String(err)}`);
    return { status: 'error', message: 'Internal error exporting CSV' };
  }
}

/**
 * google.script.run entry point: sends exception notification emails.
 *
 * Admin-only. Generates a fresh summary and emails the body to the
 * requesting admin (and any additional recipients). Only sends if there
 * are actual violations or inactive events; returns SUCCESS with a "nothing
 * to report" message otherwise.
 *
 * Payload: { additionalRecipients?: string[] }
 * Returns: { recipientCount: number }
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverSendExceptionEmail(payload: {
  additionalRecipients?: string[];
}): ServerResponse {
  try {
    const auth = requireAdminOrFail();
    if (!auth.ok) return auth.response;

    const result = generateSummary();
    if (!result.data) {
      return { status: 'error', message: result.message };
    }

    const summary = result.data;
    const hasExceptions =
      summary.violations.length > 0 || summary.eventsWithoutUploads.length > 0;

    if (!hasExceptions) {
      return {
        status: 'success',
        message: 'No exceptions found — email not sent',
        data: { recipientCount: 0 },
      };
    }

    const body = buildExceptionEmailBody(summary);
    const subject = `湘舍动公益文件系统 — Exception Alert (${new Date().toISOString().slice(0, 10)})`;

    // Always include the requesting admin
    const recipients = [auth.adminEmail, ...(payload.additionalRecipients ?? [])];
    // Deduplicate and normalise
    const uniqueRecipients = [...new Set(recipients.map((r) => r.toLowerCase().trim()))];

    for (const recipient of uniqueRecipients) {
      MailApp.sendEmail(recipient, subject, body);
    }

    Logger.log(`[serverSendExceptionEmail] Sent to ${uniqueRecipients.join(', ')}`);
    return {
      status: 'success',
      message: `Exception email sent to ${uniqueRecipients.length} recipient(s)`,
      data: { recipientCount: uniqueRecipients.length },
    };
  } catch (err) {
    Logger.log(`serverSendExceptionEmail error: ${String(err)}`);
    return { status: 'error', message: `Failed to send exception email: ${String(err)}` };
  }
}

// ─── Internal auth helper ─────────────────────────────────────────────────────

type AdminCheckResult =
  | { ok: true; adminEmail: string }
  | { ok: false; response: ServerResponse };

function requireAdminOrFail(): AdminCheckResult {
  const authResult = authenticateRequest();
  if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
    return { ok: false, response: { status: 'error', message: 'Authentication required' } };
  }
  const guard = requireRole(authResult.data.role, UserRole.ADMIN);
  if (guard.status !== ResultStatus.SUCCESS) {
    return { ok: false, response: { status: 'error', message: guard.message } };
  }
  return { ok: true, adminEmail: authResult.data.email };
}
