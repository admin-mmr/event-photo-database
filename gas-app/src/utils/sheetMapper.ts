import { UserRole, UserStatus, UploadSource, AuditAction, SyncQueueStatus, DeletedFileStatus } from '../types/enums';
import { UserRecord, EventRecord, UploadLogRecord, UploadLinkRecord, ClubRecord, AuditLogRecord, PhotosAlbumRecord, PhotosFileRecord, EmailPreferenceRecord, SyncQueueRecord, DeletedFileRecord } from '../types/models';
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
 *
 * Column order: EMAIL(0) FIRST_NAME(1) LAST_NAME(2) ROLE(3) CLUB_ID(4)
 *               NOTIFY_NEW_EVENTS(5) NOTIFY_DAILY_DIGEST(6) STATUS(7)
 *               ADDED_DATE(8) ADDED_BY(9) LAST_LOGIN_AT(10)
 */
export function toUserRecord(row: unknown[]): UserRecord | null {
  const COL = COLUMNS.USERS;
  // Minimum required: columns 0-10 (LAST_LOGIN_AT col 11 is optional — may be absent on older rows)
  if (row.length <= COL.ADDED_BY) return null;

  const email = String(row[COL.EMAIL] ?? '').trim().toLowerCase();
  const role = String(row[COL.ROLE] ?? '').trim();
  const status = String(row[COL.STATUS] ?? '').trim();

  if (!email) return null;
  if (!Object.values(UserRole).includes(role as UserRole)) return null;
  if (!Object.values(UserStatus).includes(status as UserStatus)) return null;

  return {
    email,
    firstName: String(row[COL.FIRST_NAME] ?? '').trim(),
    lastName:  String(row[COL.LAST_NAME]  ?? '').trim(),
    role:      role as UserRole,
    status:    status as UserStatus,
    clubId:    String(row[COL.CLUB_ID]    ?? '').trim(),
    addedDate: formatSheetDate(row[COL.ADDED_DATE]),
    addedBy:   String(row[COL.ADDED_BY]  ?? '').trim().toLowerCase(),
    lastLoginAt: String(row[COL.LAST_LOGIN_AT] ?? '').trim(),
  };
}

/**
 * Converts a UserRecord back to a Sheets row array.
 * Column order must match COLUMNS.USERS exactly:
 *   email(0) first_name(1) last_name(2) role(3) club_id(4)
 *   notify_new_events(5) notify_daily_digest(6) status(7)
 *   added_date(8) added_by(9) last_login_at(10)
 *
 * notify_* columns are not part of UserRecord — pass empty string so
 * new rows leave them blank. For updates, the caller is responsible
 * for preserving existing notify values if needed.
 */
export function fromUserRecord(record: UserRecord, notifyNewEvents = '', notifyDailyDigest = ''): unknown[] {
  return [
    record.email,
    record.firstName,
    record.lastName,
    record.role,
    record.clubId,
    notifyNewEvents,
    notifyDailyDigest,
    record.status,
    record.addedDate,
    record.addedBy,
    record.lastLoginAt,
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

  // durationMs is absent on rows written before upload-duration tracking
  // shipped; treat those as unknown (0). Negative values are also clamped
  // to 0 to keep downstream aggregation safe.
  const rawDuration = Number(row[COL.DURATION_MS]);
  const durationMs =
    isFinite(rawDuration) && rawDuration > 0 ? Math.round(rawDuration) : 0;

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
    // linkId may be absent on older rows (before Phase 2)
    linkId: String(row[COL.LINK_ID] ?? '').trim(),
    durationMs,
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
    record.linkId,
    record.durationMs,
  ];
}

// ─── Clubs ────────────────────────────────────────────────────────────────────

/**
 * Converts a raw Sheets row to a ClubRecord.
 * Returns null if required fields are missing or status is invalid.
 *
 * Column order: DISPLAY_NAME(0) NORMALIZED_NAME(1) STATUS(2)
 *   ADDED_DATE(3) ADDED_BY(4)
 *
 * normalizedName is the de-facto primary key — it's unique, immutable,
 * and used as the Drive folder name under each event folder.
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
 *
 * Legacy rows (pre-Phase-2) only have 7 columns; the three new fields
 * (LINK_ID, IP_ADDRESS, REASON) default to empty strings for those rows.
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
    // Extended fields — may be absent on legacy rows
    linkId:    String(row[COL.LINK_ID]    ?? '').trim(),
    ipAddress: String(row[COL.IP_ADDRESS] ?? '').trim(),
    reason:    String(row[COL.REASON]     ?? '').trim(),
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
    record.linkId,
    record.ipAddress,
    record.reason,
  ];
}

// ─── Upload Links ─────────────────────────────────────────────────────────────

/**
 * Converts a raw Sheets row to an UploadLinkRecord.
 * Returns null if required key fields (linkId, eventId, token) are missing.
 */
export function toUploadLinkRecord(row: unknown[]): UploadLinkRecord | null {
  const COL = COLUMNS.UPLOAD_LINKS;
  if (row.length <= COL.REVOKED_REASON) return null;

  const linkId  = String(row[COL.LINK_ID]  ?? '').trim();
  const eventId = String(row[COL.EVENT_ID] ?? '').trim();
  const token   = String(row[COL.TOKEN]    ?? '').trim();

  if (!linkId || !eventId || !token) return null;

  const version = Number(row[COL.VERSION]);

  return {
    linkId,
    eventId,
    clubName:      String(row[COL.CLUB_NAME]      ?? '').trim(),
    token,
    version:       isFinite(version) ? version : 1,
    generatedBy:   String(row[COL.GENERATED_BY]   ?? '').trim().toLowerCase(),
    generatedAt:   String(row[COL.GENERATED_AT]   ?? '').trim(),
    revokedAt:     String(row[COL.REVOKED_AT]     ?? '').trim(),
    revokedBy:     String(row[COL.REVOKED_BY]     ?? '').trim().toLowerCase(),
    revokedReason: String(row[COL.REVOKED_REASON] ?? '').trim(),
  };
}

/**
 * Converts an UploadLinkRecord back to a Sheets row array.
 * Column order must match COLUMNS.UPLOAD_LINKS exactly.
 */
export function fromUploadLinkRecord(record: UploadLinkRecord): unknown[] {
  return [
    record.linkId,
    record.eventId,
    record.clubName,
    record.token,
    record.version,
    record.generatedBy,
    record.generatedAt,
    record.revokedAt,
    record.revokedBy,
    record.revokedReason,
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

// ─── Sync Queue ───────────────────────────────────────────────────────────────

/**
 * Converts a raw Sheets row to a SyncQueueRecord.
 * Returns null if required fields (queueId, eventId, batchFolderId) are missing
 * or if the status value is not a recognised SyncQueueStatus.
 */
export function toSyncQueueRecord(row: unknown[]): SyncQueueRecord | null {
  const COL = COLUMNS.SYNC_QUEUE;
  if (row.length <= COL.COMPLETED_AT) return null;

  const queueId       = String(row[COL.QUEUE_ID]       ?? '').trim();
  const eventId       = String(row[COL.EVENT_ID]       ?? '').trim();
  const batchFolderId = String(row[COL.BATCH_FOLDER_ID] ?? '').trim();
  const status        = String(row[COL.STATUS]          ?? '').trim();

  if (!queueId || !eventId || !batchFolderId) return null;
  if (!Object.values(SyncQueueStatus).includes(status as SyncQueueStatus)) return null;

  const attempts = Number(row[COL.ATTEMPTS]);

  return {
    queueId,
    eventId,
    clubName:        String(row[COL.CLUB_NAME]         ?? '').trim(),
    batchFolderId,
    batchFolderName: String(row[COL.BATCH_FOLDER_NAME] ?? '').trim(),
    enqueuedAt:      String(row[COL.ENQUEUED_AT]       ?? '').trim(),
    status:          status as SyncQueueStatus,
    attempts:        isFinite(attempts) ? attempts : 0,
    lastAttemptAt:   String(row[COL.LAST_ATTEMPT_AT]   ?? '').trim(),
    errorMsg:        String(row[COL.ERROR_MSG]          ?? '').trim(),
    completedAt:     String(row[COL.COMPLETED_AT]       ?? '').trim(),
  };
}

/**
 * Converts a SyncQueueRecord back to a Sheets row array.
 * Column order must match COLUMNS.SYNC_QUEUE exactly.
 */
export function fromSyncQueueRecord(record: SyncQueueRecord): unknown[] {
  return [
    record.queueId,
    record.eventId,
    record.clubName,
    record.batchFolderId,
    record.batchFolderName,
    record.enqueuedAt,
    record.status,
    record.attempts,
    record.lastAttemptAt,
    record.errorMsg,
    record.completedAt,
  ];
}

// ─── Email Preferences ────────────────────────────────────────────────────────

/**
 * Coerces a Sheets cell to a boolean opt-in flag.
 *
 * Sheets may return booleans natively when users click the checkbox UI, or
 * strings like "TRUE" / "FALSE" / "yes" / "no" / "1" / "0" when a human types
 * into the cell. Normalise all of these; default empty/unknown values to false
 * so that absent rows are treated as not-opted-in.
 */
function toOptInBoolean(value: unknown): boolean {
  if (value === true) return true;
  if (value === false) return false;
  const s = String(value ?? '').trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1';
}

/**
 * Converts a raw Sheets row to an EmailPreferenceRecord.
 * Returns null if the row is missing its email key.
 */
export function toEmailPreferenceRecord(row: unknown[]): EmailPreferenceRecord | null {
  const COL = COLUMNS.EMAIL_PREFERENCES;
  // Rows written before EVENT_CREATED was added only have 8 columns (UPDATED_AT at index 7).
  // Accept rows with at least 5 columns (EMAIL through SECURITY_EVENT) so old data still loads.
  if (row.length < 5) return null;

  const email = String(row[COL.EMAIL] ?? '').trim().toLowerCase();
  if (!email) return null;

  return {
    email,
    userCreated:     toOptInBoolean(row[COL.USER_CREATED]),
    userRoleChanged: toOptInBoolean(row[COL.USER_ROLE_CHANGED]),
    userDeactivated: toOptInBoolean(row[COL.USER_DEACTIVATED]),
    securityEvent:   toOptInBoolean(row[COL.SECURITY_EVENT]),
    // EVENT_CREATED column (index 5) may be absent in rows written before the schema update;
    // default to true (opted in) to match the default policy for new transactional alerts.
    eventCreated:    row.length > COL.EVENT_CREATED ? toOptInBoolean(row[COL.EVENT_CREATED]) : true,
    dailyReport:     row.length > COL.DAILY_REPORT   ? toOptInBoolean(row[COL.DAILY_REPORT])   : false,
    weeklyReport:    row.length > COL.WEEKLY_REPORT  ? toOptInBoolean(row[COL.WEEKLY_REPORT])  : false,
    updatedAt:       row.length > COL.UPDATED_AT     ? String(row[COL.UPDATED_AT] ?? '').trim() : '',
  };
}

/**
 * Converts an EmailPreferenceRecord back to a Sheets row array.
 * Booleans are written as native booleans — Sheets renders them as checkboxes
 * if the column is formatted as such, and stores them as TRUE/FALSE otherwise.
 */
export function fromEmailPreferenceRecord(record: EmailPreferenceRecord): unknown[] {
  return [
    record.email,
    record.userCreated,
    record.userRoleChanged,
    record.userDeactivated,
    record.securityEvent,
    record.eventCreated,
    record.dailyReport,
    record.weeklyReport,
    record.updatedAt,
  ];
}

// ─── Deleted Files ────────────────────────────────────────────────────────────

/**
 * Coerces a Sheets row into a DeletedFileRecord.
 * Returns null if any required identity field is missing or status is invalid.
 */
export function toDeletedFileRecord(row: unknown[]): DeletedFileRecord | null {
  const COL = COLUMNS.DELETED_FILES;
  if (row.length <= COL.STATUS) return null;

  const deleteId    = String(row[COL.DELETE_ID]    ?? '').trim();
  const driveFileId = String(row[COL.DRIVE_FILE_ID] ?? '').trim();
  const status      = String(row[COL.STATUS]        ?? '').trim();

  if (!deleteId || !driveFileId) return null;
  if (!Object.values(DeletedFileStatus).includes(status as DeletedFileStatus)) return null;

  return {
    deleteId,
    driveFileId,
    fileName:        String(row[COL.FILE_NAME]        ?? '').trim(),
    eventId:         String(row[COL.EVENT_ID]         ?? '').trim(),
    clubName:        String(row[COL.CLUB_NAME]        ?? '').trim(),
    batchFolderName: String(row[COL.BATCH_FOLDER_NAME] ?? '').trim(),
    uploadedBy:      String(row[COL.UPLOADED_BY]      ?? '').trim(),
    deletedAt:       String(row[COL.DELETED_AT]       ?? '').trim(),
    deletedBy:       String(row[COL.DELETED_BY]       ?? '').trim(),
    deletedReason:   String(row[COL.DELETED_REASON]   ?? '').trim(),
    restoredAt:      String(row[COL.RESTORED_AT]      ?? '').trim(),
    restoredBy:      String(row[COL.RESTORED_BY]      ?? '').trim(),
    purgedAt:        String(row[COL.PURGED_AT]        ?? '').trim(),
    status:          status as DeletedFileStatus,
  };
}

/**
 * Converts a DeletedFileRecord to a Sheets row array.
 * Column order must match COLUMNS.DELETED_FILES exactly.
 */
export function fromDeletedFileRecord(record: DeletedFileRecord): unknown[] {
  return [
    record.deleteId,
    record.driveFileId,
    record.fileName,
    record.eventId,
    record.clubName,
    record.batchFolderName,
    record.uploadedBy,
    record.deletedAt,
    record.deletedBy,
    record.deletedReason,
    record.restoredAt,
    record.restoredBy,
    record.purgedAt,
    record.status,
  ];
}
