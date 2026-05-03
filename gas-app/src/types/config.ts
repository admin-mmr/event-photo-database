import { PhotoMimeType } from './enums';

/**
 * Full application configuration shape.
 * Retrieved at runtime from GAS Script Properties + compile-time constants.
 * Use getConfig() from src/config/constants.ts — do not instantiate directly.
 */
export interface AppConfig {
  readonly ROOT_FOLDER_ID: string;       // Google Drive root folder ID
  readonly SPREADSHEET_ID: string;       // Google Sheets database ID
  readonly SHEET_NAMES: SheetNames;
  readonly PHOTO_MIME_TYPES: ReadonlyArray<PhotoMimeType>;
  readonly MAX_FILE_SIZE_MB: number;     // Max size per individual file
  readonly MAX_BATCH_SIZE_MB: number;    // Max total size per upload session
  readonly MAX_API_REQUESTS_PER_HOUR: number; // Retained for future use / rate limiting
}

export interface SheetNames {
  readonly USERS: string;
  readonly EVENTS: string;
  readonly UPLOAD_LOG: string;
  readonly UPLOAD_LINKS: string;
  readonly RATE_LIMIT: string;
  readonly CLUBS: string;
  readonly AUDIT_LOG: string;
  readonly PHOTO_ALBUMS: string;
  readonly PHOTO_FILES: string;
  readonly EMAIL_PREFERENCES: string;
  readonly SYNC_QUEUE: string;
  readonly DELETED_FILES: string;
  /**
   * Special_Folders sheet — tracks the per-event "Photos_NNN" consolidated
   * shortcut folders and the per-(event, club, tag) "Videos" folders the
   * specialFoldersService creates inside the Drive hierarchy. Row-level
   * source of truth for the public Folders index tab.
   */
  readonly SPECIAL_FOLDERS: string;
}

/**
 * Column indices (0-based) for each sheet.
 * Using a typed constant instead of magic numbers throughout the codebase
 * means a column order change only requires one edit here.
 */
export interface SheetColumnMap {
  readonly USERS: UserSheetColumns;
  readonly EVENTS: EventSheetColumns;
  readonly UPLOAD_LOG: UploadLogSheetColumns;
  readonly UPLOAD_LINKS: UploadLinksSheetColumns;
  readonly RATE_LIMIT: RateLimitSheetColumns;
  readonly CLUBS: ClubSheetColumns;
  readonly AUDIT_LOG: AuditLogSheetColumns;
  readonly PHOTO_ALBUMS: PhotosAlbumsSheetColumns;
  readonly PHOTO_FILES: PhotosFilesSheetColumns;
  readonly EMAIL_PREFERENCES: EmailPreferencesSheetColumns;
  readonly SYNC_QUEUE: SyncQueueSheetColumns;
  readonly DELETED_FILES: DeletedFilesSheetColumns;
  readonly SPECIAL_FOLDERS: SpecialFoldersSheetColumns;
}

export interface EmailPreferencesSheetColumns {
  readonly EMAIL:              0;  // Admin email (primary key, lowercase)
  readonly USER_CREATED:       1;  // TRUE / FALSE
  readonly USER_ROLE_CHANGED:  2;
  readonly USER_DEACTIVATED:   3;
  readonly SECURITY_EVENT:     4;
  readonly EVENT_CREATED:      5;  // New event creation alert
  readonly DAILY_REPORT:       6;
  readonly WEEKLY_REPORT:      7;
  readonly UPDATED_AT:         8;  // ISO 8601 timestamp
}

/**
 * Audit_Log sheet columns — extended with linkId, ipAddress, reason for the
 * link-based upload model. Legacy rows will have empty strings for the new fields.
 */
export interface AuditLogSheetColumns {
  readonly AUDIT_ID:      0;
  readonly TIMESTAMP:     1;
  readonly ACTOR_EMAIL:   2;
  readonly ACTION:        3;
  readonly RESOURCE_TYPE: 4;
  readonly RESOURCE_ID:   5;
  readonly DETAILS:       6;
  readonly LINK_ID:       7;  // Upload link ID used (for uploads; empty otherwise)
  readonly IP_ADDRESS:    8;  // IP address of the actor; empty if unavailable
  readonly REASON:        9;  // Free-text reason (for deletes/revocations); empty otherwise
}

export interface RateLimitSheetColumns {
  readonly API_KEY: 0;         // Retained for potential future rate-limiting use
  readonly WINDOW_START: 1;    // ISO 8601 timestamp: start of the current 1-hour window
  readonly REQUEST_COUNT: 2;   // Number of requests made in the current window
}

/**
 * Users sheet columns — redesigned for link-based access model.
 * Only admins (super_admin / club_admin) are stored here.
 * Volunteers are not pre-registered; they authenticate on demand via upload links.
 */
export interface UserSheetColumns {
  // Sheet: email(0) first_name(1) last_name(2) role(3) club_id(4)
  //        notify_new_events(5) notify_daily_digest(6) status(7)
  //        added_date(8) added_by(9) last_login_at(10)
  readonly EMAIL:          0;  // Google account email (primary key, lowercase)
  readonly FIRST_NAME:     1;  // Given name from Google profile
  readonly LAST_NAME:      2;  // Family name from Google profile
  readonly ROLE:           3;  // 'super_admin' | 'club_admin'
  readonly CLUB_ID:        4;  // normalizedName of the club (club_admin only; empty for super_admin)
  readonly STATUS:         7;  // 'active' | 'inactive'
  readonly ADDED_DATE:     8;  // ISO 8601 date: "YYYY-MM-DD"
  readonly ADDED_BY:       9;  // Admin email who created the record
  readonly LAST_LOGIN_AT: 10;  // ISO 8601 timestamp of most recent login; empty until first login
}

export interface EventSheetColumns {
  readonly EVENT_ID: 0;
  readonly EVENT_NAME: 1;
  readonly EVENT_DATE: 2;
  readonly FOLDER_NAME: 3;
  readonly DRIVE_FOLDER_ID: 4;
  readonly CREATED_BY: 5;
  readonly CREATED_AT: 6;
}

export interface UploadLogSheetColumns {
  readonly LOG_ID: 0;
  readonly EVENT_ID: 1;
  readonly CLUB_NAME: 2;
  readonly UPLOADED_BY: 3;
  readonly BATCH_FOLDER_NAME: 4;
  readonly BATCH_FOLDER_ID: 5;
  readonly FILE_COUNT: 6;
  readonly TOTAL_SIZE_MB: 7;
  readonly SKIPPED_DUPLICATES: 8;
  readonly SKIPPED_NON_PHOTO: 9;
  readonly UPLOAD_TIMESTAMP: 10;
  readonly SOURCE: 11;
  readonly LINK_ID: 12;  // Upload link ID used for this session (for forensic audit after rotation)
  readonly DURATION_MS: 13;  // Wall-clock upload duration in ms; 0 on legacy rows
}

/**
 * Upload_Links sheet columns.
 * One row per (event, club, tag) triple. The token changes on rotation but the
 * linkId remains stable, preserving audit history.
 * tag is an optional photographer/location label (e.g. "finish_line"); empty = default/all.
 */
export interface UploadLinksSheetColumns {
  readonly LINK_ID:        0;  // UUID v4 — stable identifier across rotations
  readonly EVENT_ID:       1;  // FK → Events.eventId
  readonly CLUB_NAME:      2;  // Normalized club name (Drive folder key)
  readonly TOKEN:          3;  // URL-safe random secret (changes on rotation)
  readonly VERSION:        4;  // Integer, incremented on each rotation
  readonly GENERATED_BY:   5;  // Admin email who created/last-rotated the link
  readonly GENERATED_AT:   6;  // ISO 8601 timestamp of creation/last rotation
  readonly REVOKED_AT:     7;  // ISO 8601 timestamp of revocation; empty if active
  readonly REVOKED_BY:     8;  // Admin email who revoked; empty if not revoked
  readonly REVOKED_REASON: 9;  // Free-text reason; empty if not revoked
  readonly TAG:           10;  // Optional photographer/location label; empty = default (all)
}

export interface ClubSheetColumns {
  readonly DISPLAY_NAME:    0;  // Human-readable display name (may include Chinese characters)
  readonly NORMALIZED_NAME: 1;  // Drive-safe identifier (ASCII, underscores only) — primary key
  readonly STATUS:          2;  // "active" | "inactive"
  readonly ADDED_DATE:      3;  // ISO 8601 date "YYYY-MM-DD"
  readonly ADDED_BY:        4;  // Admin email
}

export interface PhotosAlbumsSheetColumns {
  readonly ALBUM_ID:          0;   // Google Photos album ID
  readonly ALBUM_TYPE:        1;   // "event" | "club"
  readonly EVENT_ID:          2;   // FK → Events.eventId
  readonly CLUB_NAME:         3;   // Normalized club name; empty for event-type albums
  readonly TAG:               4;   // Tag/photographer label; empty for event-type albums, non-empty for club albums
  readonly ALBUM_TITLE:       5;   // Human-readable album title
  readonly ALBUM_URL:         6;   // Google Photos product URL
  readonly SHAREABLE_URL:     7;   // Public shareable link
  readonly CREATED_AT:        8;   // ISO 8601 timestamp
  readonly LAST_SYNC_AT:      9;   // ISO 8601 timestamp of most recent sync
  readonly SYNCED_FILE_COUNT: 10;  // Cumulative number of photos pushed to album
}

export interface PhotosFilesSheetColumns {
  readonly DRIVE_FILE_ID: 0;  // Google Drive file ID (composite key part 1)
  readonly MEDIA_ITEM_ID: 1;  // Google Photos media item ID
  readonly ALBUM_ID:      2;  // Google Photos album ID (composite key part 2)
  readonly ALBUM_TYPE:    3;  // "event" | "club"
  readonly EVENT_ID:      4;  // FK → Events.eventId
  readonly CLUB_NAME:     5;  // Normalized club name; empty for event-type albums
  readonly TAG:           6;  // Tag/photographer label; empty for event-type albums, non-empty for club albums
  readonly FILE_NAME:     7;  // Original filename, e.g. "IMG_0042.jpg"
  readonly SYNCED_AT:     8;  // ISO 8601 timestamp of when the sync occurred
}

/**
 * Sync_Queue sheet columns (Phase 4).
 * Each row is one Drive batch folder waiting to be synced to Google Photos.
 */
export interface SyncQueueSheetColumns {
  readonly QUEUE_ID:          0;  // UUID v4 (primary key)
  readonly EVENT_ID:          1;  // FK → Events.eventId
  readonly CLUB_NAME:         2;  // Normalized club name
  readonly TAG:               3;  // Tag/photographer label captured from the upload link
  readonly BATCH_FOLDER_ID:   4;  // Google Drive batch folder ID
  readonly BATCH_FOLDER_NAME: 5;  // Human-readable batch folder name
  readonly ENQUEUED_AT:       6;  // ISO 8601 timestamp when row was written
  readonly STATUS:            7;  // 'pending' | 'in_progress' | 'done' | 'failed'
  readonly ATTEMPTS:          8;  // Number of drain attempts made so far
  readonly LAST_ATTEMPT_AT:   9;  // ISO 8601 timestamp of most recent attempt; empty initially
  readonly ERROR_MSG:         10; // Last error message; empty if no error
  readonly COMPLETED_AT:      11; // ISO 8601 timestamp when status became 'done'; empty otherwise
}

/**
 * Special_Folders sheet columns.
 *
 * One row per special folder created by specialFoldersService:
 *   - scope = 'photos': consolidated per-event Photos_NNN folders that hold
 *     up to MAX_SHORTCUTS_PER_PHOTOS_FOLDER Drive shortcuts to every photo
 *     under the event. clubName / tag are empty for these rows; folderIndex
 *     is the 1-based ordinal of the folder in the indexed series.
 *   - scope = 'videos': per-(event, club, tag) Videos folder containing
 *     Drive shortcuts to every video under that scope. clubName + tag are
 *     populated; folderIndex is always 1 (one folder per scope).
 *
 * folderId is the Drive folder ID and serves as the primary key. Rows are
 * append-only on first creation and updated in place by subsequent rebuilds.
 */
export interface SpecialFoldersSheetColumns {
  readonly FOLDER_ID:        0;  // Drive folder ID (primary key)
  readonly EVENT_ID:         1;  // FK → Events.eventId
  readonly SCOPE:            2;  // 'photos' | 'videos'
  readonly CLUB_NAME:        3;  // Normalized club name; empty for scope='photos'
  readonly TAG:              4;  // Tag/photographer label; empty for scope='photos'
  readonly FOLDER_NAME:      5;  // e.g. "Photos_001", "Videos"
  readonly FOLDER_INDEX:     6;  // 1-based ordinal (1 for videos; 1..N for photos)
  readonly FOLDER_URL:       7;  // Drive folder web URL
  readonly FILE_COUNT:       8;  // Number of shortcuts inside the folder at last rebuild
  readonly LAST_REFRESHED_AT: 9; // ISO 8601 timestamp of the last rebuild that touched the folder
}

/**
 * Deleted_Files sheet columns (Phase 7 — soft delete).
 * One row per soft-deleted file. Status moves: deleted → restored | purged.
 */
export interface DeletedFilesSheetColumns {
  readonly DELETE_ID:         0;  // UUID v4 (primary key)
  readonly DRIVE_FILE_ID:     1;  // Google Drive file ID
  readonly FILE_NAME:         2;  // Original filename
  readonly EVENT_ID:          3;  // FK → Events.eventId
  readonly CLUB_NAME:         4;  // Normalized club name
  readonly BATCH_FOLDER_NAME: 5;  // Drive batch folder name
  readonly UPLOADED_BY:       6;  // Original uploader's Google email
  readonly DELETED_AT:        7;  // ISO 8601 timestamp of soft-delete
  readonly DELETED_BY:        8;  // Admin email who deleted
  readonly DELETED_REASON:    9;  // Free-text reason; empty if none
  readonly RESTORED_AT:       10; // ISO 8601 timestamp of restore; empty if not restored
  readonly RESTORED_BY:       11; // Admin email who restored; empty if not restored
  readonly PURGED_AT:         12; // ISO 8601 timestamp of hard-delete; empty if not purged
  readonly STATUS:            13; // 'deleted' | 'restored' | 'purged'
}
