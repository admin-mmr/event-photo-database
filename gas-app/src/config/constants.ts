import { PhotoMimeType, VideoMimeType } from '../types/enums';
import { AppConfig, SheetColumnMap } from '../types/config';

// ─── Event configuration ──────────────────────────────────────────────────────

/** Maximum characters for an event name before folder name generation */
export const MAX_EVENT_NAME_LENGTH = 100;

/**
 * Characters allowed in event names (pre-underscore conversion).
 *
 * Allows Unicode letters (any script — English, Chinese, Japanese, etc.),
 * Unicode digits, and ASCII spaces. The `u` flag is required for \p{...}.
 *
 * Authoritative validation lives in utils/userNameValidator.validateEventName();
 * this constant is kept for reference / external consumers but is not used by
 * the validator itself.
 */
export const EVENT_NAME_PATTERN = /^[\p{L}\p{N} ]+$/u;

/** Default page size for event listing */
export const DEFAULT_EVENT_PAGE_SIZE = 20;

/** Maximum page size to prevent abuse */
export const MAX_EVENT_PAGE_SIZE = 100;

// ─── Upload link tag ──────────────────────────────────────────────────────────

/**
 * Default tag applied to upload links when none is specified.
 * Ensures a consistent Drive folder structure:
 *   Event / Club / Tag / batch_folders / files
 *
 * Legacy links written before this constant existed carry tag = '' in the
 * Upload_Links sheet and their files live directly under Club/ — the tree
 * walker still handles those rows correctly. Only new links use DEFAULT_TAG.
 */
export const DEFAULT_TAG = 'ALL';

// ─── Admin club ───────────────────────────────────────────────────────────────

/**
 * The "admin club" is a role container, not a content destination.
 * A user whose clubId matches this value is treated as a super admin.
 * Super admins must always upload to a real club — never to the admin club.
 */
export const ADMIN_CLUB_ID = '__admin__';

// ─── Operations contact ───────────────────────────────────────────────────────

/**
 * Single mailbox that owns Google Photos album administration for the club.
 *
 * Used by:
 *   • auditAlbumSharing — recipient of "please share this album" reminders.
 *   • runAlbumReconciliation — recipient of the orphan-albums report.
 *
 * Why a hard-coded constant instead of the super-admins list?
 *   The Library API can no longer toggle album sharing on our behalf, so the
 *   action ("open in Photos and flip the share toggle") has to be performed
 *   by the SAME Google account that created the album. Super-admin emails
 *   often belong to a different account; sending the reminder to one of them
 *   doesn't help. Routing every album-admin email to a single shared
 *   mailbox owned by whoever holds that Google identity ensures the
 *   responsible person actually sees the request.
 *
 * If this mailbox ever changes, override at deploy time by setting the
 * `ALBUM_ADMIN_EMAIL` Script Property; constants.getAlbumAdminEmail()
 * reads the property first and falls back to this default.
 */
export const ALBUM_ADMIN_EMAIL_DEFAULT = 'admin@mmrunners.org';

/**
 * Returns the configured album-admin recipient, preferring the Script
 * Property override when set. Empty/whitespace property values fall back
 * to the compiled-in default so a misconfigured deployment still notifies
 * someone rather than silently dropping the email.
 */
export function getAlbumAdminEmail(): string {
  /* global PropertiesService */
  const override = PropertiesService.getScriptProperties()
    .getProperty('ALBUM_ADMIN_EMAIL');
  if (override && override.trim()) return override.trim();
  return ALBUM_ADMIN_EMAIL_DEFAULT;
}

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
    TAG:           10,
  },
  RATE_LIMIT: {
    API_KEY: 0,
    WINDOW_START: 1,
    REQUEST_COUNT: 2,
  },
  CLUBS: {
    // Sheet columns (0-based):
    //   display_name(0) normalized_name(1) status(2) added_date(3) added_by(4)
    //
    // Note: clubs do NOT have a fixed Drive folder ID — the hierarchy is
    //   Event / Club /, so each club folder is created on-demand per-event
    //   by getOrCreateClubFolder(). Any per-club album prefix is likewise
    //   derived from displayName rather than stored here.
    DISPLAY_NAME:    0,
    NORMALIZED_NAME: 1,
    STATUS:          2,
    ADDED_DATE:      3,
    ADDED_BY:        4,
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
    TAG:               4,
    ALBUM_TITLE:       5,
    ALBUM_URL:         6,
    SHAREABLE_URL:     7,
    CREATED_AT:        8,
    LAST_SYNC_AT:      9,
    SYNCED_FILE_COUNT: 10,
  },
  PHOTO_FILES: {
    DRIVE_FILE_ID: 0,
    MEDIA_ITEM_ID: 1,
    ALBUM_ID:      2,
    ALBUM_TYPE:    3,
    EVENT_ID:      4,
    CLUB_NAME:     5,
    TAG:           6,
    FILE_NAME:     7,
    SYNCED_AT:     8,
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
    TAG:               3,
    BATCH_FOLDER_ID:   4,
    BATCH_FOLDER_NAME: 5,
    ENQUEUED_AT:       6,
    STATUS:            7,
    ATTEMPTS:          8,
    LAST_ATTEMPT_AT:   9,
    ERROR_MSG:         10,
    COMPLETED_AT:      11,
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
  SPECIAL_FOLDERS: {
    FOLDER_ID:         0,
    EVENT_ID:          1,
    SCOPE:             2,
    CLUB_NAME:         3,
    TAG:               4,
    FOLDER_NAME:       5,
    FOLDER_INDEX:      6,
    FOLDER_URL:        7,
    FILE_COUNT:        8,
    LAST_REFRESHED_AT: 9,
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
  'TAG',
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
  'TAG',
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

// ─── Special folders (consolidated photos + per-scope videos) ────────────────

/**
 * Folder name prefix for the consolidated photo shortcut folders that
 * specialFoldersService creates directly under each event folder.
 *
 *   <Event>/Photos_001/      ← shortcuts to up to MAX_SHORTCUTS_PER_PHOTOS_FOLDER photos
 *   <Event>/Photos_002/      ← overflow when the previous folder fills up
 *   ...
 *
 * Three-digit zero-padded ordinals support up to 999 folders × 800 files =
 * 799,200 photos per event before we'd need to widen the suffix — well past
 * any realistic event size.
 */
export const PHOTOS_FOLDER_PREFIX = 'Photos_';

/**
 * Regex matching the system-managed consolidated photo folders that
 * specialFoldersService creates as siblings of the club folders.
 *
 * Used by Layer 2 scanners to recognise these folders as system folders
 * (not user-created club folders) and exempt them from the club-name
 * validation rules — they intentionally don't start each underscore-
 * separated segment with a letter, and they are never present in the
 * approved Clubs list.
 *
 * Matches exactly: Photos_NNN where NNN is three decimal digits.
 *   "Photos_001" ✓   "Photos_999" ✓
 *   "Photos_1"   ✗   "Photos_01"  ✗   "Photos_abc" ✗
 */
export const PHOTOS_FOLDER_NAME_REGEX = /^Photos_\d{3}$/;

/**
 * Returns true when `name` is a system-managed special folder that lives at
 * Layer 2 (directly under an event folder) and should be excluded from the
 * club-name validation scanners. Today this covers the consolidated
 * Photos_NNN buckets created by specialFoldersService.
 */
export function isSpecialLayer2Folder(name: string): boolean {
  return PHOTOS_FOLDER_NAME_REGEX.test(name);
}

/**
 * Cap on the number of Drive shortcut files inside a single Photos_NNN folder.
 *
 * Drive itself doesn't enforce 800 — the cap is a UX choice: folders with
 * more than ~1,000 children become slow to browse in the Drive UI and slow
 * to enumerate via DriveApp.getFiles(). 800 leaves headroom for the
 * "shortcut to <name>" rendering Drive sometimes appends without spilling
 * over the soft scroll limit.
 */
export const MAX_SHORTCUTS_PER_PHOTOS_FOLDER = 800;

/**
 * Folder name for the per-(event, club, tag) Videos folder created by
 * specialFoldersService. Lives as a sibling of the batch folders inside the
 * tag folder (or directly under the club folder for legacy tag-less rows).
 *
 *   <Event>/<Club>/<Tag>/Videos/    ← shortcuts to every video under (event, club, tag)
 */
export const VIDEOS_FOLDER_NAME = 'Videos';

/**
 * Expected header row for the Special_Folders sheet.
 * Column order must match COLUMNS.SPECIAL_FOLDERS exactly.
 */
export const SPECIAL_FOLDERS_HEADERS: ReadonlyArray<string> = [
  'FOLDER_ID',
  'EVENT_ID',
  'SCOPE',
  'CLUB_NAME',
  'TAG',
  'FOLDER_NAME',
  'FOLDER_INDEX',
  'FOLDER_URL',
  'FILE_COUNT',
  'LAST_REFRESHED_AT',
];

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
 *   Optional: PUBLIC_ALBUM_INDEX_SHEET_ID = <Sheets file ID of the public,
 *     view-only album index>. When set, the app mirrors the album list to that
 *     spreadsheet on every album create / batch sync so anyone with the file's
 *     view link can browse the album hierarchy without signing in. See
 *     services/publicSpreadsheetService.ts for setup details. Leave unset to
 *     disable the public mirror.
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
      SPECIAL_FOLDERS:   'Special_Folders',
    },
    PHOTO_MIME_TYPES: [PhotoMimeType.JPEG, PhotoMimeType.PNG, PhotoMimeType.HEIC],
    MAX_FILE_SIZE_MB: 50,   // GAS hard limit per UrlFetch payload
    MAX_BATCH_SIZE_MB: 200, // Soft limit per upload session to avoid timeouts
    MAX_API_REQUESTS_PER_HOUR,
  };
}
