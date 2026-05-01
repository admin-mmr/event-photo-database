/**
 * uploadHandlers.ts — google.script.run handlers for the upload pipeline.
 *
 * Covers: serverListEventsForUpload, serverGetClubFolderTree,
 *         serverEnsureClubFolder, serverStartUploadSession,
 *         serverUploadFile, serverUploadFiles, serverCompleteUpload,
 *         serverGetDriveTree.
 */

import { ResultStatus, UploadSource, UserRole, AuditAction } from '../types/enums';
import { ServerResponse, WithSession } from '../types/responses';
import { authenticateRequest } from '../middleware/authMiddleware';
import { listAll as listAllEvents } from '../services/eventService';
import {
  getClubFolderTree,
  getOrCreateClubFolder,
  createBatchFolder,
  getEventDriveTree,
  invalidateEventDriveTreeCache,
  trashBatchFolder,
} from '../services/driveService';
import { appendAuditLog } from '../services/auditLogService';
import { appendUploadLog } from '../services/uploadLogService';
import { enqueueBatchSync } from '../services/syncQueueService';
import { ADMIN_CLUB_ID } from '../config/constants';
import { buildLayer3FolderName } from '../utils/folderNameValidator';
import { toBatchTimestamp } from '../utils/dateFormatter';

/* global Logger, DriveApp, Utilities */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverListEventsForUpload(payload: WithSession): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }
    const sort   = (payload.sort === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';
    const result = listAllEvents(1, 200, sort);
    let filtered = result.items as typeof result.items;
    if (payload.dateFrom) filtered = filtered.filter((e) => e.eventDate >= payload.dateFrom!);
    if (payload.dateTo)   filtered = filtered.filter((e) => e.eventDate <= payload.dateTo!);
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverGetClubFolderTree(payload: WithSession): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }
    const { eventFolderId, clubFolderName } = payload;
    if (!eventFolderId || !clubFolderName) {
      return { status: 'error', message: 'eventFolderId and clubFolderName are required' };
    }
    const result = getClubFolderTree(eventFolderId as string, clubFolderName as string);
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverGetClubFolderTree error: ${String(err)}`);
    return { status: 'error', message: 'Internal error fetching club folder tree' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverEnsureClubFolder(payload: WithSession): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }
    const { eventFolderId, clubFolderName } = payload;
    if (!eventFolderId || !clubFolderName) {
      return { status: 'error', message: 'eventFolderId and clubFolderName are required' };
    }
    const result = getOrCreateClubFolder(eventFolderId as string, clubFolderName as string);
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverEnsureClubFolder error: ${String(err)}`);
    return { status: 'error', message: 'Internal error ensuring club folder' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverStartUploadSession(payload: WithSession<{
  eventFolderId:  string;
  clubFolderName: string;
  usernameHint:   string;
}>): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }
    const { eventFolderId, clubFolderName, usernameHint } = payload;
    if (!eventFolderId || !clubFolderName) {
      return { status: 'error', message: 'eventFolderId and clubFolderName are required' };
    }
    if (clubFolderName === ADMIN_CLUB_ID) {
      return {
        status: 'error',
        message: 'Uploads to the admin club are not allowed. Please select a real club before uploading.',
      };
    }
    const clubResult = getOrCreateClubFolder(eventFolderId, clubFolderName);
    if (clubResult.status !== ResultStatus.SUCCESS || !clubResult.data) {
      return { status: 'error', message: clubResult.message };
    }
    const timestamp    = toBatchTimestamp(new Date());
    const safeUsername = (usernameHint || authResult.data.email)
      .split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '');
    const batchFolderName = buildLayer3FolderName(timestamp, safeUsername);
    const batchResult = createBatchFolder(clubResult.data.folderId, batchFolderName);
    if (batchResult.status !== ResultStatus.SUCCESS || !batchResult.data) {
      return { status: 'error', message: batchResult.message };
    }
    return {
      status: 'success',
      message: `Upload session started: ${batchFolderName}`,
      data: {
        batchFolderId:   batchResult.data.folderId,
        batchFolderName: batchResult.data.folderName,
        clubFolderId:    clubResult.data.folderId,
      },
    };
  } catch (err) {
    Logger.log(`serverStartUploadSession error: ${String(err)}`);
    return { status: 'error', message: 'Internal error starting upload session' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverUploadFile(payload: WithSession<{
  batchFolderId: string;
  fileName:      string;
  mimeType:      string;
  base64Data:    string;
}>): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }
    const { batchFolderId, fileName, mimeType, base64Data } = payload;
    if (!batchFolderId || !fileName || !base64Data) {
      return { status: 'error', message: 'batchFolderId, fileName, and base64Data are required' };
    }
    const bytes  = Utilities.base64Decode(base64Data);
    const blob   = Utilities.newBlob(bytes, mimeType || 'application/octet-stream', fileName);
    const folder = DriveApp.getFolderById(batchFolderId);
    const file   = folder.createFile(blob);
    return {
      status: 'success',
      message: `File "${fileName}" uploaded`,
      data: { fileId: file.getId(), fileName: file.getName(), sizeBytes: file.getSize() },
    };
  } catch (err) {
    Logger.log(`serverUploadFile error: ${String(err)}`);
    return { status: 'error', message: `Failed to upload file: ${String(err)}` };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverUploadFiles(payload: WithSession<{
  batchFolderId: string;
  files: Array<{ fileName: string; mimeType: string; base64Data: string }>;
}>): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }
    const { batchFolderId, files } = payload;
    if (!batchFolderId || !files || !files.length) {
      return { status: 'error', message: 'batchFolderId and files are required' };
    }
    const folder  = DriveApp.getFolderById(batchFolderId);
    const results = files.map((f) => {
      try {
        const bytes = Utilities.base64Decode(f.base64Data);
        const blob  = Utilities.newBlob(bytes, f.mimeType || 'application/octet-stream', f.fileName);
        const saved = folder.createFile(blob);
        return { fileName: f.fileName, success: true, fileId: saved.getId(), sizeBytes: saved.getSize() };
      } catch (e) {
        Logger.log(`serverUploadFiles: failed to save "${f.fileName}": ${String(e)}`);
        return { fileName: f.fileName, success: false, error: String(e) };
      }
    });
    const successCount = results.filter((r) => r.success).length;
    return {
      status:  'success',
      message: `${successCount} of ${files.length} files saved to Drive`,
      data:    { results },
    };
  } catch (err) {
    Logger.log(`serverUploadFiles error: ${String(err)}`);
    return { status: 'error', message: `Failed to upload files: ${String(err)}` };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverCompleteUpload(payload: WithSession<{
  eventId:           string;
  clubFolderName:    string;
  batchFolderName:   string;
  batchFolderId:     string;
  fileCount:         number;
  totalSizeMb:       number;
  skippedDuplicates: number;
  skippedNonPhoto:   number;
  durationMs?:       number;
}>): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }
    const result = appendUploadLog({
      eventId:           payload.eventId,
      clubName:          payload.clubFolderName,
      uploadedBy:        authResult.data.email,
      batchFolderName:   payload.batchFolderName,
      batchFolderId:     payload.batchFolderId,
      fileCount:         Number(payload.fileCount)         || 0,
      totalSizeMb:       Number(payload.totalSizeMb)       || 0,
      skippedDuplicates: Number(payload.skippedDuplicates) || 0,
      skippedNonPhoto:   Number(payload.skippedNonPhoto)   || 0,
      source:            UploadSource.WEB_APP,
      durationMs:        Number(payload.durationMs)        || 0,
    });
    if (Number(payload.fileCount) > 0) {
      try {
        enqueueBatchSync({
          eventId:         payload.eventId,
          clubName:        payload.clubFolderName,
          batchFolderId:   payload.batchFolderId,
          batchFolderName: payload.batchFolderName,
        });
        Logger.log(`[serverCompleteUpload] Batch enqueued — event=${payload.eventId} batch=${payload.batchFolderName}`);
      } catch (enqueueErr) {
        Logger.log(`[serverCompleteUpload] enqueueBatchSync failed (non-fatal): ${String(enqueueErr)}`);
      }
      invalidateEventDriveTreeCache(payload.eventId);
    }
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverCompleteUpload error: ${String(err)}`);
    return { status: 'error', message: 'Internal error completing upload session' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverGetDriveTree(payload: WithSession): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }
    const { eventId, driveFolderId } = payload;
    if (!eventId || !driveFolderId) {
      return { status: 'error', message: 'eventId and driveFolderId are required' };
    }
    const result = getEventDriveTree(eventId as string, driveFolderId as string);
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverGetDriveTree error: ${String(err)}`);
    return { status: 'error', message: `Internal error fetching drive tree: ${String(err)}` };
  }
}

/**
 * Moves a Layer-3 batch folder to Drive trash (soft delete).
 *
 * Required payload fields: batchFolderId, clubName, eventId
 *
 * Permissions:
 *   - CLUB_ADMIN  may only delete batch folders belonging to their own club.
 *   - SUPER_ADMIN may delete any club's batch folders.
 *
 * The service layer performs an additional Drive-level ownership check so that
 * a crafted request cannot trash folders outside the declared club.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverDeleteBatchFolder(payload: WithSession): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }
    const user = authResult.data;

    const batchFolderId = String(payload.batchFolderId ?? '').trim();
    const clubName      = String(payload.clubName      ?? '').trim();
    const eventId       = String(payload.eventId       ?? '').trim();

    if (!batchFolderId || !clubName || !eventId) {
      return { status: 'error', message: 'batchFolderId, clubName, and eventId are required' };
    }

    // Club admins are scoped to their own club only.
    if (user.role === UserRole.CLUB_ADMIN && user.clubId !== clubName) {
      return {
        status: 'error',
        message: `You administer "${user.clubId}" and cannot delete folders for "${clubName}".`,
      };
    }

    const result = trashBatchFolder(batchFolderId, clubName);
    if (result.status !== ResultStatus.SUCCESS || !result.data) {
      return { status: 'error', message: result.message };
    }

    // Invalidate the cached drive tree so the next expand reflects the removal.
    invalidateEventDriveTreeCache(eventId);

    // Audit trail.
    appendAuditLog({
      actorEmail:   user.email,
      action:       AuditAction.FOLDER_DELETED,
      resourceType: 'folder',
      resourceId:   batchFolderId,
      details:      {
        folderName: result.data.folderName,
        clubName,
        eventId,
      },
    });

    Logger.log(
      `[serverDeleteBatchFolder] "${result.data.folderName}" (${batchFolderId}) ` +
      `trashed by ${user.email} — event=${eventId} club=${clubName}`
    );

    return { status: 'success', message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverDeleteBatchFolder error: ${String(err)}`);
    return { status: 'error', message: `Internal error deleting batch folder: ${String(err)}` };
  }
}
