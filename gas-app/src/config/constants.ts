import { PhotoMimeType, VideoMimeType } from '../types/enums';
import { AppConfig, SheetColumnMap } from '../types/config';

// ─── Event configuration ──────────────────────────────────────────────────────

/** Maximum characters for an event name before folder name generation */
export const MAX_EVENT_NAME_LENGTH = 100;

/** Characters allowed in event names (pre-underscore conversion) */
export const EVENT_NAME_PATTERN = /^[A-Za-z0-9\s]+$/;

/** Default page size for event listing */
export const DEFAULT_EVENT_PAGE_SIZE = 20;

/** Maximum page size to prevent abuse */
export const MAX_EVENT_PAGE_SIZE = 100;

// ─── Admin club ───────────────────────────────────────────────────────────────

/**
 * The "admin club" is a role container, not a content destination.
 * A user whose clubId matches this value is treated as a super admin.
 * Super admins must always upload to a real club — never to the admin club.
 */
export const ADMIN_CLUB_ID = '__admin__';

/**
 * Column indices (0-based) for every sheet.
 * These match the column order defined in the project plan.
 * Changing column order in a sheet requires updating only this constant.
 */
export const COLUMNS: SheetColumnMap = {
  USERS: {
    // Sheet columns (0-based):
    //   email(0) first_name(1) last_name(2) role(3) club_id(4)
    //   notify_new_events(5) notify_daily_digest(6) status(7)
    //   added_date(8) added_by(9) last_login_at(10)
    EMAIL:         0,
    FIRST_NAME:    1,
    LAST_NAME:     2,
    ROLE:          3,
    CLUB_ID:       4,
    STATUS:        7,
    ADDED_DATE:    8,
    ADDED_BY:      9,
    LAST_LOGIN_AT: 10,
  },
  EVENTS: {
    EVENT_ID: 0,
    EVENT_NAME: 1,
    EVENT_DATE: 2,
    FOLDER_NAME: 3,
    DRIVE_FOLDER_ID: 4,
    CREATED_BY: 5,
    CREATED_AT: 6,
  },
  UPLOAD_LOG: {
    LOG_ID: 0,
    EVENT_ID: 1,
    CLUB_NAME: 2,
    UPLOADED_BY: 3,
    BATCH_FOLDER_NAME: 4,
    BATCH_FOLDER_ID: 5,
    FILE_COUNT: 6,
    TOTAL_SIZE_MB: 7,
    SKIPPED_DUPLICATES: 8,
    SKIPPED_NON_PHOTO: 9,
    UPLOAD_TIMESTAMP: 10,
    SOURCE: 11,
    LINK_ID: 12,
    DURATION_MS: 13,
  },
  UPLOAD_LINKS: {
    LINK_ID:        0,
    EVENT_ID:       1,
    CLUB_NAME:      2,
    TOKEN:          3,
    VERSION:        4,
    GENERATED_BY:   5,
    GENERATED_AT:   6,
    REVOKED_AT:     7,
    REVOKED_BY:     8,
    REVOKED_REASON: 9,
  },
  RATE_LIMIT: {
    API_KEY: 0,
    WINDOW_START: 1,
    REQUEST_COUNT: 2,
  },
  CLUBS: {
    // Sheet columns (0-based):
    //   display_name(0) normalized_name(1) drive_folder_id(2)
    //   photos_album_prefix(3) status(4) added_date(5) added_by(6)
    DISPLAY_NAME:        0,
    NORMALIZED_NAME:     1,
    DRIVE_FOLDER_ID:     2,
    PHOTOS_ALBUM_PREFIX: 3,
    STATUS:              4,
    ADDED_DATE:          5,
    ADDED_BY:            6,
  },
  AUDIT_LOG: {
    AUDIT_ID:      0,
    TIMESTAMP:     1,
    ACTOR_EMAIL:   2,
    ACTION:        3,
    RESOURCE_TYPE: 4,
    RESOURCE_ID:   5,
    DETAILS:       6,
    LINK_ID:       7,
    IP_ADDRESS:    8,
    REASON:        9,
  },
  PHOTO_ALBUMS: {
    ALBUM_ID:          0,
    ALBUM_TYPE:        1,
    EVENT_ID:          2,
    CLUB_NAME:         3,
    ALBUM_TITLE:       4,
    ALBUM_URL:         5,
    SHAREABLE_URL:     6,
    CREATED_AT:        7,
    LAST_SYNC_AT:      8,
    SYNCED_FILE_COUNT: 9,
  },
  PHOTO_FILES: {
    DRIVE_FILE_ID: 0,
    MEDIA_ITEM_ID: 1,
    ALBUM_ID:      2,
    ALBUM_TYPE:    3,
    EVENT_ID:      4,
    CLUB_NAME:     5,
    FILE_NAME:     6,
    SYNCED_AT:     7,
  },
  EMAIL_PREFERENCES: {
    EMAIL:              0,
    USER_CREATED:       1,
    USER_ROLE_CHANGED:  2,
    USER_DEACTIVATED:   3,
    SECURITY_EVENT:     4,
    EVENT_CREATED:      5,
    DAILY_REPORT:       6,
    WEEKLY_REPORT:      7,
    UPDATED_AT:         8,
  },
  SYNC_QUEUE: {
    QUEUE_ID:          0,
    EVENT_ID:          1,
    CLUB_NAME:         2,
    BATCH_FOLDER_ID:   3,
    BATCH_FOLDER_NAME: 4,
    ENQUEUED_AT:       5,
    STATUS:            6,
    ATTEMPTS:          7,
    LAST_ATTEMPT_AT:   8,
    ERROR_MSG:         9,
    COMPLETED_AT:      10,
  },
  DELETED_FILES: {
    DELETE_ID:         0,
    DRIVE_FILE_ID:     1,
    FILE_NAME:         2,
    EVENT_ID:          3,
    CLUB_NAME:         4,
    BATCH_FOLDER_NAME: 5,
    UPLOADED_BY:       6,
    DELETED_AT:        7,
    DELETED_BY:        8,
    DELETED_REASON:    9,
    RESTORED_AT:       10,
    RESTORED_BY:       11,
    PURGED_AT:         12,
    STATUS:            13,
  },
};

/**
 * Expected header rows for each sheet.
 * Keep in column order — a mismatch triggers schema-drift detection.
 */
export const USERS_HEADERS: ReadonlyArray<string> = [
  'EMAIL',
  'FIRST_NAME',
  'LAST_NAME',
  'ROLE',
  'CLUB_ID',
  'NOTIFY_NEW_EVENTS',
  'NOTIFY_DAILY_DIGEST',
  'STATUS',
  'ADDED_DATE',
  'ADDED_BY',
  'LAST_LOGIN_AT',
];

export const UPLOAD_LINKS_HEADERS: ReadonlyArray<string> = [
  'LINK_ID',
  'EVENT_ID',
  'CLUB_NAME',
  'TOKEN',
  'VERSION',
  'GENERATED_BY',
  'GENERATED_AT',
  'REVOKED_AT',
  'REVOKED_BY',
  'REVOKED_REASON',
];

export const AUDIT_LOG_HEADERS: ReadonlyArray<string> = [
  'AUDIT_ID',
  'TIMESTAMP',
  'ACTOR_EMAIL',
  'ACTION',
  'RESOURCE_TYPE',
  'RESOURCE_ID',
  'DETAILS',
  'LINK_ID',
  'IP_ADDRESS',
  'REASON',
];

/**
 * Expected header row for the Email_Preferences sheet.
 * Used by emailPreferenceService.ensureSheetHeaders() via sheetService.ensureHeaders.
 * Keep in column order — a mismatch triggers schema-drift detection.
 */
export const EMAIL_PREFERENCES_HEADERS: ReadonlyArray<string> = [
  'EMAIL',
  'USER_CREATED',
  'USER_ROLE_CHANGED',
  'USER_DEACTIVATED',
  'SECURITY_EVENT',
  'EVENT_CREATED',
  'DAILY_REPORT',
  'WEEKLY_REPORT',
  'UPDATED_AT',
];

/**
 * Expected header row for the Sync_Queue sheet (Phase 4).
 */
export const SYNC_QUEUE_HEADERS: ReadonlyArray<string> = [
  'QUEUE_ID',
  'EVENT_ID',
  'CLUB_NAME',
  'BATCH_FOLDER_ID',
  'BATCH_FOLDER_NAME',
  'ENQUEUED_AT',
  'STATUS',
  'ATTEMPTS',
  'LAST_ATTEMPT_AT',
  'ERROR_MSG',
  'COMPLETED_AT',
];

/**
 * Expected header row for the Deleted_Files sheet (Phase 7 — soft delete).
 * Column order must match COLUMNS.DELETED_FILES exactly.
 */
export const DELETED_FILES_HEADERS: ReadonlyArray<string> = [
  'DELETE_ID',
  'DRIVE_FILE_ID',
  'FILE_NAME',
  'EVENT_ID',
  'CLUB_NAME',
  'BATCH_FOLDER_NAME',
  'UPLOADED_BY',
  'DELETED_AT',
  'DELETED_BY',
  'DELETED_REASON',
  'RESTORED_AT',
  'RESTORED_BY',
  'PURGED_AT',
  'STATUS',
];

/** How long a soft-deleted file sits in trash before it is permanently purged. */
export const SOFT_DELETE_RETENTION_DAYS = 30;

/**
 * Volunteer upload pipeline: accepted MIME types.
 * Includes all photo types (JPEG, PNG, HEIC, WEBP) and video (MP4, MOV).
 * Used by the volunteer upload handler to classify and skip unsupported files.
 */
export const MEDIA_MIME_TYPES: ReadonlyArray<PhotoMimeType | VideoMimeType> = [
  ...Object.values(PhotoMimeType) as PhotoMimeType[],
  ...Object.values(VideoMimeType) as VideoMimeType[],
];

/**
 * Phase 5 — API rate limiting.
 * Each API client key is allowed at most this many requests per rolling hour.
 * Exceeding the limit returns a 429 JSON response.
 */
export const MAX_API_REQUESTS_PER_HOUR = 60;
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour in milliseconds

// ─── Phase 4 — Sync Queue configuration ──────────────────────────────────────

/**
 * Maximum number of sync attempts before a queue item is permanently marked
 * 'failed'. After this threshold, the drain skips the item rather than
 * re-attempting it so a consistently broken batch does not block other items.
 */
export const MAX_SYNC_ATTEMPTS = 3;

/**
 * Minutes after which an 'in_progress' queue item is considered stuck and
 * eligible for retry. GAS executions are killed at 6 minutes, so any item
 * still in_progress after 10 minutes was almost certainly abandoned.
 */
export const SYNC_STUCK_THRESHOLD_MINUTES = 10;

/**
 * Maximum number of queue items to process in a single drain run.
 * Keeps each trigger execution well under the 6-minute GAS wall-clock limit.
 * Each batch sync can upload dozens of files to the Photos API, so a
 * conservative limit of 5 items per run (~1 min per item worst-case) is safe.
 */
export const SYNC_DRAIN_BATCH_SIZE = 5;

/**
 * Builds the runtime AppConfig by reading sensitive IDs from GAS Script Properties.
 *
 * HOW TO SET PROPERTIES:
 *   In the GAS editor: Extensions → Apps Script → Project Settings → Script Properties
 *   Add: ROOT_FOLDER_ID = <your Drive folder ID>
 *        SPREADSHEET_ID = <your Sheets ID>
 *
 * Call getConfig() at the start of any request handler — never at module load time,
 * since PropertiesService is unavailable during clasp type-checking.
 */
export function getConfig(): AppConfig {
  /* global PropertiesService */
  const props = PropertiesService.getScriptProperties();

  const rootFolderId = props.getProperty('ROOT_FOLDER_ID');
  const spreadsheetId = props.getProperty('SPREADSHEET_ID');

  if (!rootFolderId || !spreadsheetId) {
    throw new Error(
      'Missing Script Properties: ROOT_FOLDER_ID and SPREADSHEET_ID must be set. ' +
      'Go to Extensions → Apps Script → Project Settings → Script Properties.'
    );
  }

  return {
    ROOT_FOLDER_ID: rootFolderId,
    SPREADSHEET_ID: spreadsheetId,
    SHEET_NAMES: {
      USERS: 'Users',
      EVENTS: 'Events',
      UPLOAD_LOG: 'Upload_Log',
      UPLOAD_LINKS: 'Upload_Links',
      RATE_LIMIT: 'Rate_Limit',
      CLUBS: 'Clubs',
      AUDIT_LOG: 'Audit_Log',
      PHOTO_ALBUMS: 'Photo_Albums',
      PHOTO_FILES:  'Photo_Files',
      EMAIL_PREFERENCES: 'Email_Preferences',
      SYNC_QUEUE:        'Sync_Queue',
      DELETED_FILES:     'Deleted_Files',
    },
    PHOTO_MIME_TYPES: [PhotoMimeType.JPEG, PhotoMimeType.PNG, PhotoMimeType.HEIC],
    MAX_FILE_SIZE_MB: 50,   // GAS hard limit per UrlFetch payload
    MAX_BATCH_SIZE_MB: 200, // Soft limit per upload session to avoid timeouts
    MAX_API_REQUESTS_PER_HOUR,
  };
}
