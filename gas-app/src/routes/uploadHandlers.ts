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
  trashScopeFolder,
} from '../services/driveService';
import { appendAuditLog, appendAuditFailure } from '../services/auditLogService';
import { appendUploadLog } from '../services/uploadLogService';
import { enqueueBatchSync } from '../services/syncQueueService';
import { ADMIN_CLUB_ID, isCreditRenameEnabled } from '../config/constants';
import { buildLayer3FolderName } from '../utils/folderNameValidator';
import { toBatchTimestamp } from '../utils/dateFormatter';
import { buildCreditedFileName } from '../utils/creditedFileName';

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

/**
 * Re-applies the photographer-credit rename on the server as a defence-in-depth
 * step. The client already renames before sending, but we never trust the
 * browser to be the only place sanitisation happens — a malicious script
 * could send the original filename to bypass the credit line.
 *
 * Returns the original input unchanged when the feature flag is off, or when
 * the caller did not provide credit metadata (volunteer flow still does its
 * own rename client-side because bytes never touch GAS).
 */
function applyServerSideRename(
  fileName: string,
  clubShortName: string | undefined,
  photographerName: string | undefined,
  fallbackEmail: string,
): string {
  if (!isCreditRenameEnabled()) return fileName;
  if (!clubShortName) return fileName;
  return buildCreditedFileName({
    clubShortName,
    photographerName: photographerName ?? '',
    originalFileName: fileName,
    fallbackName: (fallbackEmail || '').split('@')[0],
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverUploadFile(payload: WithSession<{
  batchFolderId:    string;
  fileName:         string;
  mimeType:         string;
  base64Data:       string;
  clubShortName?:   string;
  photographerName?: string;
}>): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }
    const { batchFolderId, fileName, mimeType, base64Data,
            clubShortName, photographerName } = payload;
    if (!batchFolderId || !fileName || !base64Data) {
      return { status: 'error', message: 'batchFolderId, fileName, and base64Data are required' };
    }
    const finalName = applyServerSideRename(
      fileName, clubShortName, photographerName, authResult.data.email,
    );
    const bytes  = Utilities.base64Decode(base64Data);
    const blob   = Utilities.newBlob(bytes, mimeType || 'application/octet-stream', finalName);
    const folder = DriveApp.getFolderById(batchFolderId);
    const file   = folder.createFile(blob);
    return {
      status: 'success',
      message: `File "${finalName}" uploaded`,
      data: { fileId: file.getId(), fileName: file.getName(), sizeBytes: file.getSize() },
    };
  } catch (err) {
    Logger.log(`serverUploadFile error: ${String(err)}`);
    return { status: 'error', message: `Failed to upload file: ${String(err)}` };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverUploadFiles(payload: WithSession<{
  batchFolderId:    string;
  files: Array<{ fileName: string; mimeType: string; base64Data: string }>;
  /** Photographer-credit metadata. When set (and the feature flag is on),
   *  each file's name is re-derived server-side via buildCreditedFileName. */
  clubShortName?:    string;
  photographerName?: string;
}>): ServerResponse {
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }
    const { batchFolderId, files, clubShortName, photographerName } = payload;
    if (!batchFolderId || !files || !files.length) {
      return { status: 'error', message: 'batchFolderId and files are required' };
    }
    const folder  = DriveApp.getFolderById(batchFolderId);
    const callerEmail = authResult.data.email;
    const results = files.map((f) => {
      try {
        const finalName = applyServerSideRename(
          f.fileName, clubShortName, photographerName, callerEmail,
        );
        const bytes = Utilities.base64Decode(f.base64Data);
        const blob  = Utilities.newBlob(bytes, f.mimeType || 'application/octet-stream', finalName);
        const saved = folder.createFile(blob);
        return {
          fileName: saved.getName(),
          originalFileName: f.fileName,
          success: true,
          fileId: saved.getId(),
          sizeBytes: saved.getSize(),
        };
      } catch (e) {
        Logger.log(`serverUploadFiles: failed to save "${f.fileName}": ${String(e)}`);
        return { fileName: f.fileName, originalFileName: f.fileName, success: false, error: String(e) };
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
        // Derive the tag from the batch folder's parent. The Drive layout is
        // Event / Club / Tag / Batch — so the immediate parent of the batch
        // is the tag folder. The admin upload path doesn't accept a tag in
        // the payload, so we read it back from Drive here.
        let tag = '';
        try {
          const parents = DriveApp.getFolderById(payload.batchFolderId).getParents();
          if (parents.hasNext()) {
            const parentName = parents.next().getName();
            if (parentName !== payload.clubFolderName) tag = parentName;
          }
        } catch (tagErr) {
          Logger.log(`[serverCompleteUpload] could not derive tag for batch ${payload.batchFolderId}: ${String(tagErr)}`);
        }

        enqueueBatchSync({
          eventId:         payload.eventId,
          clubName:        payload.clubFolderName,
          tag,
          batchFolderId:   payload.batchFolderId,
          batchFolderName: payload.batchFolderName,
        });
        Logger.log(`[serverCompleteUpload] Batch enqueued — event=${payload.eventId} club=${payload.clubFolderName} tag=${tag} batch=${payload.batchFolderName}`);
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
  Logger.log(
    `[serverDeleteBatchFolder] entry — payload keys=[${
      payload && typeof payload === 'object'
        ? Object.keys(payload as Record<string, unknown>).join(',')
        : '(empty)'
    }]`
  );
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      Logger.log(`[serverDeleteBatchFolder] auth rejected — sessionToken present=${!!payload?.sessionToken}`);
      appendAuditFailure({
        actorEmail:   '',
        action:       AuditAction.ADMIN_AUTH_REJECTED,
        resourceType: 'folder',
        stage:        'auth',
        message:      authResult.message,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return { status: 'error', message: 'Authentication required' };
    }
    const user = authResult.data;
    Logger.log(`[serverDeleteBatchFolder] authenticated as ${user.email} (role=${user.role})`);

    const batchFolderId = String(payload.batchFolderId ?? '').trim();
    const clubName      = String(payload.clubName      ?? '').trim();
    const eventId       = String(payload.eventId       ?? '').trim();

    if (!batchFolderId || !clubName || !eventId) {
      Logger.log(
        `[serverDeleteBatchFolder] validation failed — actor=${user.email} ` +
        `batchFolderId="${batchFolderId}" clubName="${clubName}" eventId="${eventId}"`
      );
      appendAuditFailure({
        actorEmail:   user.email,
        action:       AuditAction.FOLDER_DELETE_FAILED,
        resourceType: 'folder',
        resourceId:   batchFolderId,
        stage:        'payload_validation',
        message:      'batchFolderId, clubName, and eventId are required',
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return { status: 'error', message: 'batchFolderId, clubName, and eventId are required' };
    }

    // Club admins are scoped to their own club only.
    if (user.role === UserRole.CLUB_ADMIN && user.clubId !== clubName) {
      Logger.log(
        `[serverDeleteBatchFolder] authorization rejected — actor=${user.email} ` +
        `actorClub=${user.clubId} requestedClub=${clubName}`
      );
      appendAuditFailure({
        actorEmail:   user.email,
        action:       AuditAction.FOLDER_DELETE_FAILED,
        resourceType: 'folder',
        resourceId:   batchFolderId,
        stage:        'authorization',
        message:      `Cross-club access denied (actorClub=${user.clubId}, requestedClub=${clubName})`,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return {
        status: 'error',
        message: `You administer "${user.clubId}" and cannot delete folders for "${clubName}".`,
      };
    }

    const result = trashBatchFolder(batchFolderId, clubName);
    if (result.status !== ResultStatus.SUCCESS || !result.data) {
      Logger.log(`[serverDeleteBatchFolder] service failed — actor=${user.email} batchFolderId=${batchFolderId} message="${result.message}"`);
      appendAuditFailure({
        actorEmail:   user.email,
        action:       AuditAction.FOLDER_DELETE_FAILED,
        resourceType: 'folder',
        resourceId:   batchFolderId,
        stage:        'service_layer',
        message:      result.message,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
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
      `[serverDeleteBatchFolder] success — "${result.data.folderName}" (${batchFolderId}) ` +
      `trashed by ${user.email} — event=${eventId} club=${clubName}`
    );

    return { status: 'success', message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`[serverDeleteBatchFolder] unhandled exception: ${String(err)}`);
    appendAuditFailure({
      actorEmail:   '',
      action:       AuditAction.FOLDER_DELETE_FAILED,
      resourceType: 'folder',
      stage:        'unhandled_exception',
      message:      String(err),
      attemptedPayload: payload as unknown as Record<string, unknown>,
    });
    return { status: 'error', message: `Internal error deleting batch folder: ${String(err)}` };
  }
}

/**
 * Moves a tag (Layer-2.5) or club (Layer-2) folder to Drive trash.
 *
 * Safety: the server rejects the call if any user-content subfolder still
 * exists inside the target folder — admins must delete inner folders first.
 * Club admins may only delete folders belonging to their own club.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverDeleteScopeFolder(payload: WithSession): ServerResponse {
  Logger.log(
    `[serverDeleteScopeFolder] entry — payload keys=[${
      payload && typeof payload === 'object'
        ? Object.keys(payload as Record<string, unknown>).join(',')
        : '(empty)'
    }]`
  );
  try {
    const authResult = authenticateRequest(payload?.sessionToken);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      appendAuditFailure({
        actorEmail:       '',
        action:           AuditAction.ADMIN_AUTH_REJECTED,
        resourceType:     'folder',
        stage:            'auth',
        message:          authResult.message,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return { status: 'error', message: 'Authentication required' };
    }
    const user = authResult.data;

    const folderId   = String((payload as Record<string, unknown>).folderId   ?? '').trim();
    const folderType = String((payload as Record<string, unknown>).folderType ?? '').trim() as 'tag' | 'club';
    const clubName   = String((payload as Record<string, unknown>).clubName   ?? '').trim();
    const eventId    = String((payload as Record<string, unknown>).eventId    ?? '').trim();

    if (!folderId || !folderType || !clubName || !eventId) {
      return { status: 'error', message: 'folderId, folderType, clubName, and eventId are required' };
    }
    if (folderType !== 'tag' && folderType !== 'club') {
      return { status: 'error', message: 'folderType must be "tag" or "club"' };
    }

    // Club admins may only act on their own club.
    if (user.role === UserRole.CLUB_ADMIN && user.clubId !== clubName) {
      appendAuditFailure({
        actorEmail:       user.email,
        action:           AuditAction.FOLDER_DELETE_FAILED,
        resourceType:     'folder',
        resourceId:       folderId,
        stage:            'authorization',
        message:          `Cross-club access denied (actorClub=${user.clubId}, requestedClub=${clubName})`,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return {
        status: 'error',
        message: `You administer "${user.clubId}" and cannot delete folders for "${clubName}".`,
      };
    }

    const result = trashScopeFolder(folderId, folderType, clubName);
    if (result.status !== ResultStatus.SUCCESS || !result.data) {
      appendAuditFailure({
        actorEmail:       user.email,
        action:           AuditAction.FOLDER_DELETE_FAILED,
        resourceType:     'folder',
        resourceId:       folderId,
        stage:            'service_layer',
        message:          result.message,
        attemptedPayload: payload as unknown as Record<string, unknown>,
      });
      return { status: 'error', message: result.message };
    }

    invalidateEventDriveTreeCache(eventId);

    appendAuditLog({
      actorEmail:   user.email,
      action:       AuditAction.FOLDER_DELETED,
      resourceType: 'folder',
      resourceId:   folderId,
      details:      { folderName: result.data.folderName, folderType, clubName, eventId },
    });

    Logger.log(
      `[serverDeleteScopeFolder] success — ${folderType}="${result.data.folderName}" ` +
      `(${folderId}) trashed by ${user.email} — event=${eventId} club=${clubName}`
    );

    return { status: 'success', message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`[serverDeleteScopeFolder] unhandled exception: ${String(err)}`);
    return { status: 'error', message: `Internal error deleting folder: ${String(err)}` };
  }
}
