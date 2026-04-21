import { UserRole, UserStatus, UploadSource, AuditAction } from '../types/enums';
import { UserRecord, EventRecord, UploadLogRecord, ClubRecord, AuditLogRecord, PhotosAlbumRecord, PhotosFileRecord } from '../types/models';
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

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Normalises a Sheets cell that may be a Date object or a plain string.
 *
 * Google Sheets stores DATE-typed cells internally as Date objects in GAS.
 * Calling String() on a Date gives the full locale timestamp like
 * "Thu Apr 09 2026 00:00:00 GMT-0400 (Eastern Daylight Time)".
 * This helper converts those to the compact "YYYY-MM-DD" format instead.
 */
function formatSheetDate(value: unknown): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value ?? '').trim();
}

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
    addedDate: formatSheetDate(row[COL.ADDED_DATE]),
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
    eventDate: formatSheetDate(row[COL.EVENT_DATE]),
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

// ─── Clubs ────────────────────────────────────────────────────────────────────

/**
 * Converts a raw Sheets row to a ClubRecord.
 * Returns null if required fields are missing or status is invalid.
 */
export function toClubRecord(row: unknown[]): ClubRecord | null {
  const COL = COLUMNS.CLUBS;
  if (row.length <= COL.ADDED_BY) return null;

  const displayName = String(row[COL.DISPLAY_NAME] ?? '').trim();
  const normalizedName = String(row[COL.NORMALIZED_NAME] ?? '').trim();
  const status = String(row[COL.STATUS] ?? '').trim();

  if (!displayName || !normalizedName) return null;
  if (status !== 'active' && status !== 'inactive') return null;

  return {
    displayName,
    normalizedName,
    status: status as 'active' | 'inactive',
    addedDate: formatSheetDate(row[COL.ADDED_DATE]),
    addedBy: String(row[COL.ADDED_BY] ?? '').trim().toLowerCase(),
  };
}

/**
 * Converts a ClubRecord back to a Sheets row array.
 * Column order must match COLUMNS.CLUBS exactly.
 */
export function fromClubRecord(record: ClubRecord): unknown[] {
  return [
    record.displayName,
    record.normalizedName,
    record.status,
    record.addedDate,
    record.addedBy,
  ];
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

/**
 * Converts a raw Sheets row to an AuditLogRecord.
 * Returns null if required fields are missing or action is unrecognized.
 */
export function toAuditLogRecord(row: unknown[]): AuditLogRecord | null {
  const COL = COLUMNS.AUDIT_LOG;
  if (row.length <= COL.DETAILS) return null;

  const auditId    = String(row[COL.AUDIT_ID]    ?? '').trim();
  const actorEmail = String(row[COL.ACTOR_EMAIL]  ?? '').trim();
  const action     = String(row[COL.ACTION]       ?? '').trim();

  if (!auditId || !actorEmail) return null;
  if (!Object.values(AuditAction).includes(action as AuditAction)) return null;

  return {
    auditId,
    timestamp:    String(row[COL.TIMESTAMP]     ?? '').trim(),
    actorEmail:   actorEmail.toLowerCase(),
    action:       action as AuditAction,
    resourceType: String(row[COL.RESOURCE_TYPE] ?? '').trim(),
    resourceId:   String(row[COL.RESOURCE_ID]   ?? '').trim(),
    details:      String(row[COL.DETAILS]        ?? '').trim(),
  };
}

/**
 * Converts an AuditLogRecord back to a Sheets row array.
 * Column order must match COLUMNS.AUDIT_LOG exactly.
 */
export function fromAuditLogRecord(record: AuditLogRecord): unknown[] {
  return [
    record.auditId,
    record.timestamp,
    record.actorEmail,
    record.action,
    record.resourceType,
    record.resourceId,
    record.details,
  ];
}

// ─── Photos Albums ─────────────────────────────────────────────────────────────

/**
 * Converts a raw Sheets row to a PhotosAlbumRecord.
 * Returns null if required fields are missing or albumType is unrecognized.
 */
export function toPhotosAlbumRecord(row: unknown[]): PhotosAlbumRecord | null {
  const COL = COLUMNS.PHOTO_ALBUMS;
  if (row.length <= COL.SYNCED_FILE_COUNT) return null;

  const albumId   = String(row[COL.ALBUM_ID]   ?? '').trim();
  const albumType = String(row[COL.ALBUM_TYPE]  ?? '').trim();

  if (!albumId) return null;
  if (albumType !== 'event' && albumType !== 'club') return null;

  const syncedFileCount = Number(row[COL.SYNCED_FILE_COUNT]);

  return {
    albumId,
    albumType: albumType as 'event' | 'club',
    eventId:         String(row[COL.EVENT_ID]         ?? '').trim(),
    clubName:        String(row[COL.CLUB_NAME]         ?? '').trim(),
    albumTitle:      String(row[COL.ALBUM_TITLE]       ?? '').trim(),
    albumUrl:        String(row[COL.ALBUM_URL]         ?? '').trim(),
    shareableUrl:    String(row[COL.SHAREABLE_URL]     ?? '').trim(),
    createdAt:       String(row[COL.CREATED_AT]        ?? '').trim(),
    lastSyncAt:      String(row[COL.LAST_SYNC_AT]      ?? '').trim(),
    syncedFileCount: isFinite(syncedFileCount) ? syncedFileCount : 0,
  };
}

/**
 * Converts a PhotosAlbumRecord back to a Sheets row array.
 * Column order must match COLUMNS.PHOTO_ALBUMS exactly.
 */
export function fromPhotosAlbumRecord(record: PhotosAlbumRecord): unknown[] {
  return [
    record.albumId,
    record.albumType,
    record.eventId,
    record.clubName,
    record.albumTitle,
    record.albumUrl,
    record.shareableUrl,
    record.createdAt,
    record.lastSyncAt,
    record.syncedFileCount,
  ];
}

// ─── Photos Files ──────────────────────────────────────────────────────────────

/**
 * Converts a raw Sheets row to a PhotosFileRecord.
 *
 * Returns null if required key fields (driveFileId, albumId) are missing or
 * if albumType is not "event" or "club".
 *
 * Column order: driveFileId(A), mediaItemId(B), albumId(C), albumType(D),
 *               eventId(E), clubName(F), fileName(G), syncedAt(H)
 */
export function toPhotosFileRecord(row: unknown[]): PhotosFileRecord | null {
  const COL = COLUMNS.PHOTO_FILES;
  if (row.length <= COL.SYNCED_AT) return null;

  const driveFileId = String(row[COL.DRIVE_FILE_ID] ?? '').trim();
  const albumId     = String(row[COL.ALBUM_ID]      ?? '').trim();
  const albumType   = String(row[COL.ALBUM_TYPE]    ?? '').trim();

  if (!driveFileId || !albumId) return null;
  if (albumType !== 'event' && albumType !== 'club') return null;

  return {
    driveFileId,
    mediaItemId: String(row[COL.MEDIA_ITEM_ID] ?? '').trim(),
    albumId,
    albumType:   albumType as 'event' | 'club',
    eventId:     String(row[COL.EVENT_ID]   ?? '').trim(),
    clubName:    String(row[COL.CLUB_NAME]  ?? '').trim(),
    fileName:    String(row[COL.FILE_NAME]  ?? '').trim(),
    syncedAt:    String(row[COL.SYNCED_AT]  ?? '').trim(),
  };
}

/**
 * Converts a PhotosFileRecord back to a Sheets row array.
 * Column order must match COLUMNS.PHOTO_FILES exactly.
 */
export function fromPhotosFileRecord(record: PhotosFileRecord): unknown[] {
  return [
    record.driveFileId,
    record.mediaItemId,
    record.albumId,
    record.albumType,
    record.eventId,
    record.clubName,
    record.fileName,
    record.syncedAt,
  ];
}
