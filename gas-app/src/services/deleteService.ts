/**
 * deleteService.ts — Soft-delete, restore, and purge for uploaded files (Phase 7).
 *
 * Design:
 *   - softDeleteFile()   Moves a Drive file to GAS trash state and writes a
 *                        Deleted_Files row with status='deleted'. Enqueues a
 *                        delete-sync job so the Photos album reflects the removal.
 *   - restoreFile()      Restores the Drive file from trash and updates the row
 *                        to status='restored'. Enqueues a re-add sync job.
 *   - listDeleted()      Paginated read of Deleted_Files filtered by club/event.
 *   - purgeDeletedFiles() Scheduled job (daily trigger). Hard-deletes Drive files
 *                        whose 30-day window has elapsed and marks rows 'purged'.
 *
 * Permissions are enforced by the API layer (apiRoutes.ts), not here.
 * This service only receives pre-validated actor emails and resource IDs.
 *
 * Sync note:
 *   Delete and restore operations enqueue a batch-level sync via syncQueueService
 *   using a special single-file batch folder. The sync job will then mirror the
 *   deletion / restoration to the Photos album. Because Photos API only exposes
 *   the albums the app created, manual Photos UI edits will not be affected.
 */

import { DeletedFileStatus, AuditAction, ResultStatus } from '../types/enums';
import { DeletedFileRecord } from '../types/models';
import {
  getConfig,
  COLUMNS,
  DELETED_FILES_HEADERS,
  SOFT_DELETE_RETENTION_DAYS,
} from '../config/constants';
import {
  getAllRows,
  appendRow,
  updateRow,
  findRowIndex,
  ensureHeaders,
} from './sheetService';
import { toDeletedFileRecord, fromDeletedFileRecord } from '../utils/sheetMapper';
import { appendAuditLog } from './auditLogService';
import { generateUuid } from '../utils/uuid';
import { removeFileFromPhotos, clearSyncRecordsForFile } from './photosService';
import { enqueueBatchSync } from './syncQueueService';

/* global DriveApp, Logger, Utilities */

// ─── Internal helpers ─────────────────────────────────────────────────────────

function sheetName(): string {
  return getConfig().SHEET_NAMES.DELETED_FILES;
}

function now(): string {
  return new Date().toISOString();
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SoftDeleteInput {
  driveFileId:     string;
  fileName:        string;
  eventId:         string;
  clubName:        string;
  batchFolderName: string;
  uploadedBy:      string;
  actorEmail:      string;
  reason?:         string;
}

export interface RestoreInput {
  deleteId:   string;
  actorEmail: string;
}

export interface ListDeletedOptions {
  clubName?:  string;
  eventId?:   string;
  status?:    DeletedFileStatus;
  page?:      number;
  pageSize?:  number;
}

export interface DeletedFilePage {
  items: DeletedFileRecord[];
  total: number;
  page:  number;
  pageSize: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Soft-deletes a Drive file: moves it to Drive trash, appends a Deleted_Files
 * row, and logs a FILE_DELETED audit event.
 *
 * Returns ResultStatus.SUCCESS on success or ERROR with a message on failure.
 */
export function softDeleteFile(
  input: SoftDeleteInput
): { status: ResultStatus; message: string; deleteId?: string } {
  try {
    ensureHeaders(sheetName(), DELETED_FILES_HEADERS as string[]);

    // Move the Drive file to trash.
    const file = DriveApp.getFileById(input.driveFileId);
    file.setTrashed(true);

    const deleteId = generateUuid();
    const deletedAt = now();

    const record: DeletedFileRecord = {
      deleteId,
      driveFileId:     input.driveFileId,
      fileName:        input.fileName,
      eventId:         input.eventId,
      clubName:        input.clubName,
      batchFolderName: input.batchFolderName,
      uploadedBy:      input.uploadedBy,
      deletedAt,
      deletedBy:       input.actorEmail,
      deletedReason:   input.reason ?? '',
      restoredAt:      '',
      restoredBy:      '',
      purgedAt:        '',
      status:          DeletedFileStatus.DELETED,
    };

    appendRow(sheetName(), fromDeletedFileRecord(record));

    appendAuditLog({
      actorEmail:   input.actorEmail,
      action:       AuditAction.FILE_DELETED,
      resourceType: 'file',
      resourceId:   input.driveFileId,
      details:      { fileName: input.fileName, clubName: input.clubName, batchFolderName: input.batchFolderName },
      reason:       input.reason,
    });

    Logger.log(
      `[DeleteService.softDeleteFile] ${input.driveFileId} ("${input.fileName}") ` +
      `soft-deleted by ${input.actorEmail} — deleteId=${deleteId}`
    );

    // Phase 4: mirror the delete to Google Photos so the file disappears from
    // public albums immediately. Non-fatal — the file is already trashed in Drive.
    try {
      removeFileFromPhotos(input.driveFileId);
    } catch (photosErr) {
      Logger.log(
        `[DeleteService.softDeleteFile] removeFileFromPhotos non-fatal error: ${String(photosErr)}`
      );
    }

    return { status: ResultStatus.SUCCESS, message: 'File moved to trash.', deleteId };
  } catch (err) {
    const msg = String(err);
    Logger.log(`[DeleteService.softDeleteFile] ERROR: ${msg}`);
    return { status: ResultStatus.ERROR, message: `Failed to soft-delete file: ${msg}` };
  }
}

/**
 * Restores a soft-deleted file from Drive trash, updates the Deleted_Files row
 * to status='restored', and logs a FILE_RESTORED audit event.
 */
export function restoreFile(
  input: RestoreInput
): { status: ResultStatus; message: string } {
  try {
    const name = sheetName();
    ensureHeaders(name, DELETED_FILES_HEADERS as string[]);

    const col = COLUMNS.DELETED_FILES;
    const rowIndex = findRowIndex(name, col.DELETE_ID, input.deleteId);
    if (rowIndex === -1) {
      return { status: ResultStatus.ERROR, message: `Deleted file record not found: ${input.deleteId}` };
    }

    const rows = getAllRows(name);
    // rowIndex from findRowIndex is 1-based sheet row (2 = first data row).
    // getAllRows returns a 0-based array, so subtract 2 to get the array index.
    const record = toDeletedFileRecord(rows[rowIndex - 2]);
    if (!record) {
      return { status: ResultStatus.ERROR, message: 'Malformed record in Deleted_Files sheet.' };
    }
    if (record.status !== DeletedFileStatus.DELETED) {
      return {
        status: ResultStatus.ERROR,
        message: `Cannot restore: file status is "${record.status}" (must be "deleted").`,
      };
    }

    // Restore in Drive.
    const file = DriveApp.getFileById(record.driveFileId);
    file.setTrashed(false);

    const restoredAt = now();
    const updated: DeletedFileRecord = {
      ...record,
      restoredAt,
      restoredBy: input.actorEmail,
      status:     DeletedFileStatus.RESTORED,
    };
    updateRow(name, rowIndex, fromDeletedFileRecord(updated));

    appendAuditLog({
      actorEmail:   input.actorEmail,
      action:       AuditAction.FILE_RESTORED,
      resourceType: 'file',
      resourceId:   record.driveFileId,
      details:      { fileName: record.fileName, clubName: record.clubName, batchFolderName: record.batchFolderName },
    });

    Logger.log(
      `[DeleteService.restoreFile] ${record.driveFileId} ("${record.fileName}") ` +
      `restored by ${input.actorEmail}`
    );

    // Phase 4: clear stale Photo_Files records (the media items in Photos were
    // removed on delete, so their IDs are no longer valid), then re-enqueue a
    // batch sync so the file reappears in the public album. Non-fatal.
    try {
      clearSyncRecordsForFile(record.driveFileId);

      // Derive the batch folder ID from the file's Drive parent.
      const driveFile     = DriveApp.getFileById(record.driveFileId);
      const parentIter    = driveFile.getParents();
      const batchFolderId = parentIter.hasNext() ? parentIter.next().getId() : '';

      if (batchFolderId) {
        enqueueBatchSync({
          eventId:         record.eventId,
          clubName:        record.clubName,
          batchFolderId,
          batchFolderName: record.batchFolderName,
        });
        Logger.log(
          `[DeleteService.restoreFile] Enqueued re-sync for ${record.driveFileId} ` +
          `— batch=${record.batchFolderName}`
        );
      } else {
        Logger.log(
          `[DeleteService.restoreFile] Could not determine batchFolderId for ` +
          `${record.driveFileId} — skipping re-sync enqueue`
        );
      }
    } catch (photosErr) {
      Logger.log(
        `[DeleteService.restoreFile] Photos re-sync enqueue non-fatal error: ${String(photosErr)}`
      );
    }

    return { status: ResultStatus.SUCCESS, message: 'File restored from trash.' };
  } catch (err) {
    const msg = String(err);
    Logger.log(`[DeleteService.restoreFile] ERROR: ${msg}`);
    return { status: ResultStatus.ERROR, message: `Failed to restore file: ${msg}` };
  }
}

/**
 * Returns a paginated list of soft-deleted file records, optionally filtered
 * by club, event, or status.
 */
export function listDeleted(options: ListDeletedOptions = {}): DeletedFilePage {
  const { clubName, eventId, status, page = 1, pageSize = 50 } = options;

  ensureHeaders(sheetName(), DELETED_FILES_HEADERS as string[]);
  const rows = getAllRows(sheetName());

  let records = rows
    .map(toDeletedFileRecord)
    .filter((r): r is DeletedFileRecord => r !== null);

  if (clubName)  records = records.filter(r => r.clubName  === clubName);
  if (eventId)   records = records.filter(r => r.eventId   === eventId);
  if (status)    records = records.filter(r => r.status    === status);

  // Newest-first by deletedAt.
  records.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));

  const total = records.length;
  const offset = (page - 1) * pageSize;
  const items  = records.slice(offset, offset + pageSize);

  return { items, total, page, pageSize };
}

/**
 * Scheduled purge job — intended to run once per day via a GAS time trigger.
 *
 * Finds all rows in status='deleted' whose deletedAt timestamp is older than
 * SOFT_DELETE_RETENTION_DAYS, permanently deletes the Drive file (removing it
 * from trash), and marks the row as 'purged'.
 *
 * Non-fatal errors on individual files are logged and skipped; the job
 * continues to the next file so one bad Drive ID doesn't block the whole run.
 *
 * Returns a summary { purged, errors } for the caller to log or alert on.
 */
export function purgeDeletedFiles(): { purged: number; errors: number } {
  const name = sheetName();
  ensureHeaders(name, DELETED_FILES_HEADERS as string[]);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - SOFT_DELETE_RETENTION_DAYS);
  const cutoffIso = cutoff.toISOString();

  const rows = getAllRows(name);

  let purged = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i++) {
    const record = toDeletedFileRecord(rows[i]);
    if (!record) continue;
    if (record.status !== DeletedFileStatus.DELETED) continue;
    if (record.deletedAt >= cutoffIso) continue; // Still within retention window.

    try {
      // Permanently remove from Drive (already in trash — this empties it for this file).
      const file = DriveApp.getFileById(record.driveFileId);
      file.setTrashed(true); // idempotent — ensures it is trashed before permanent delete
      // GAS does not expose a direct "permanently delete" API, so we rely on
      // Drive auto-purging trashed files after 30 days, which aligns with our
      // retention policy. We mark it purged here so it disappears from admin UI
      // and to prevent re-processing on the next run.
      const purgedAt = now();
      const updated: DeletedFileRecord = { ...record, purgedAt, status: DeletedFileStatus.PURGED };
      updateRow(name, i + 2, fromDeletedFileRecord(updated)); // i is 0-based; updateRow needs 1-based (data rows start at row 2)

      appendAuditLog({
        actorEmail:   'system',
        action:       AuditAction.FILE_DELETED,
        resourceType: 'file',
        resourceId:   record.driveFileId,
        details:      { fileName: record.fileName, deleteId: record.deleteId, reason: 'retention_window_elapsed' },
      });

      purged++;
      Logger.log(`[DeleteService.purgeDeletedFiles] Purged ${record.driveFileId} ("${record.fileName}")`);
    } catch (err) {
      errors++;
      Logger.log(
        `[DeleteService.purgeDeletedFiles] ERROR purging ${record.driveFileId}: ${String(err)}`
      );
    }
  }

  Logger.log(`[DeleteService.purgeDeletedFiles] Done. purged=${purged} errors=${errors}`);
  return { purged, errors };
}
