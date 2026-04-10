import { UserRole, UserStatus, UploadSource } from '../types/enums';
import { UserRecord, EventRecord, UploadLogRecord } from '../types/models';
import { COLUMNS } from '../config/constants';

/**
 * SheetMapper — typed boundary between raw Sheets data and application models.
 *
 * Google Sheets returns rows as `unknown[][]` from getValues().
 * Every cell read from Sheets must pass through these mappers before being
 * used in business logic. This prevents untyped data from leaking into services.
 *
 * Mapping strategy:
 *   - Always use String() coercion for text fields (Sheets may return numbers or Date objects)
 *   - Return null for rows that fail validation — callers filter these out
 *   - fromRecord() produces a row array in the same column order as COLUMNS
 */

// ─── Users ────────────────────────────────────────────────────────────────────

/**
 * Converts a raw Sheets row to a UserRecord.
 * Returns null if the row is structurally invalid or has an unrecognized role.
 */
export function toUserRecord(row: unknown[]): UserRecord | null {
  const COL = COLUMNS.USERS;
  if (row.length <= COL.ADDED_BY) return null;

  const email = String(row[COL.EMAIL] ?? '').trim().toLowerCase();
  const role = String(row[COL.ROLE] ?? '').trim();
  const status = String(row[COL.STATUS] ?? '').trim();

  if (!email) return null;
  if (!Object.values(UserRole).includes(role as UserRole)) return null;
  if (!Object.values(UserStatus).includes(status as UserStatus)) return null;

  return {
    email,
    runningClub: String(row[COL.RUNNING_CLUB] ?? '').trim(),
    role: role as UserRole,
    status: status as UserStatus,
    addedDate: String(row[COL.ADDED_DATE] ?? '').trim(),
    addedBy: String(row[COL.ADDED_BY] ?? '').trim().toLowerCase(),
  };
}

/**
 * Converts a UserRecord back to a Sheets row array.
 * Column order must match COLUMNS.USERS exactly.
 */
export function fromUserRecord(record: UserRecord): unknown[] {
  return [
    record.email,
    record.runningClub,
    record.role,
    record.status,
    record.addedDate,
    record.addedBy,
  ];
}

// ─── Events ───────────────────────────────────────────────────────────────────

/**
 * Converts a raw Sheets row to an EventRecord.
 * Returns null if required fields are missing.
 */
export function toEventRecord(row: unknown[]): EventRecord | null {
  const COL = COLUMNS.EVENTS;
  if (row.length <= COL.CREATED_AT) return null;

  const eventId = String(row[COL.EVENT_ID] ?? '').trim();
  const eventName = String(row[COL.EVENT_NAME] ?? '').trim();
  const driveFolderId = String(row[COL.DRIVE_FOLDER_ID] ?? '').trim();

  if (!eventId || !eventName || !driveFolderId) return null;

  return {
    eventId,
    eventName,
    eventDate: String(row[COL.EVENT_DATE] ?? '').trim(),
    folderName: String(row[COL.FOLDER_NAME] ?? '').trim(),
    driveFolderId,
    createdBy: String(row[COL.CREATED_BY] ?? '').trim().toLowerCase(),
    createdAt: String(row[COL.CREATED_AT] ?? '').trim(),
  };
}

/**
 * Converts an EventRecord back to a Sheets row array.
 */
export function fromEventRecord(record: EventRecord): unknown[] {
  return [
    record.eventId,
    record.eventName,
    record.eventDate,
    record.folderName,
    record.driveFolderId,
    record.createdBy,
    record.createdAt,
  ];
}

// ─── Upload Log ───────────────────────────────────────────────────────────────

/**
 * Converts a raw Sheets row to an UploadLogRecord.
 * Returns null if required fields are missing or numbers are invalid.
 */
export function toUploadLogRecord(row: unknown[]): UploadLogRecord | null {
  const COL = COLUMNS.UPLOAD_LOG;
  if (row.length <= COL.SOURCE) return null;

  const logId = String(row[COL.LOG_ID] ?? '').trim();
  const eventId = String(row[COL.EVENT_ID] ?? '').trim();
  const source = String(row[COL.SOURCE] ?? '').trim();

  if (!logId || !eventId) return null;
  if (!Object.values(UploadSource).includes(source as UploadSource)) return null;

  const fileCount = Number(row[COL.FILE_COUNT]);
  const totalSizeMb = Number(row[COL.TOTAL_SIZE_MB]);
  const skippedDuplicates = Number(row[COL.SKIPPED_DUPLICATES]);
  const skippedNonPhoto = Number(row[COL.SKIPPED_NON_PHOTO]);

  if (
    !isFinite(fileCount) ||
    !isFinite(totalSizeMb) ||
    !isFinite(skippedDuplicates) ||
    !isFinite(skippedNonPhoto)
  ) {
    return null;
  }

  return {
    logId,
    eventId,
    clubName: String(row[COL.CLUB_NAME] ?? '').trim(),
    uploadedBy: String(row[COL.UPLOADED_BY] ?? '').trim().toLowerCase(),
    batchFolderName: String(row[COL.BATCH_FOLDER_NAME] ?? '').trim(),
    batchFolderId: String(row[COL.BATCH_FOLDER_ID] ?? '').trim(),
    fileCount,
    totalSizeMb,
    skippedDuplicates,
    skippedNonPhoto,
    uploadTimestamp: String(row[COL.UPLOAD_TIMESTAMP] ?? '').trim(),
    source: source as UploadSource,
  };
}

/**
 * Converts an UploadLogRecord back to a Sheets row array.
 */
export function fromUploadLogRecord(record: UploadLogRecord): unknown[] {
  return [
    record.logId,
    record.eventId,
    record.clubName,
    record.uploadedBy,
    record.batchFolderName,
    record.batchFolderId,
    record.fileCount,
    record.totalSizeMb,
    record.skippedDuplicates,
    record.skippedNonPhoto,
    record.uploadTimestamp,
    record.source,
  ];
}
