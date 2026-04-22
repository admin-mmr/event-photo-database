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
  readonly MAX_API_REQUESTS_PER_HOUR: number; // Rate limit for API clients
}

export interface SheetNames {
  readonly USERS: string;
  readonly EVENTS: string;
  readonly UPLOAD_LOG: string;
  readonly RATE_LIMIT: string;
  readonly CLUBS: string;
  readonly AUDIT_LOG: string;
  readonly PHOTO_ALBUMS: string;
  readonly PHOTO_FILES: string;
  readonly EMAIL_PREFERENCES: string;
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
  readonly RATE_LIMIT: RateLimitSheetColumns;
  readonly CLUBS: ClubSheetColumns;
  readonly AUDIT_LOG: AuditLogSheetColumns;
  readonly PHOTO_ALBUMS: PhotosAlbumsSheetColumns;
  readonly PHOTO_FILES: PhotosFilesSheetColumns;
  readonly EMAIL_PREFERENCES: EmailPreferencesSheetColumns;
}

export interface EmailPreferencesSheetColumns {
  readonly EMAIL:              0;  // Admin email (primary key, lowercase)
  readonly USER_CREATED:       1;  // TRUE / FALSE
  readonly USER_ROLE_CHANGED:  2;
  readonly USER_DEACTIVATED:   3;
  readonly SECURITY_EVENT:     4;
  readonly DAILY_REPORT:       5;
  readonly WEEKLY_REPORT:      6;
  readonly UPDATED_AT:         7;  // ISO 8601 timestamp
}

export interface AuditLogSheetColumns {
  readonly AUDIT_ID:      0;
  readonly TIMESTAMP:     1;
  readonly ACTOR_EMAIL:   2;
  readonly ACTION:        3;
  readonly RESOURCE_TYPE: 4;
  readonly RESOURCE_ID:   5;
  readonly DETAILS:       6;
}

export interface RateLimitSheetColumns {
  readonly API_KEY: 0;         // The api_key string (= registered email for api_clients)
  readonly WINDOW_START: 1;    // ISO 8601 timestamp: start of the current 1-hour window
  readonly REQUEST_COUNT: 2;   // Number of requests made in the current window
}

export interface UserSheetColumns {
  readonly EMAIL: 0;
  readonly RUNNING_CLUB: 1;
  readonly ROLE: 2;
  readonly STATUS: 3;
  readonly ADDED_DATE: 4;
  readonly ADDED_BY: 5;
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
}

export interface ClubSheetColumns {
  readonly DISPLAY_NAME: 0;     // Human-readable display name (may include Chinese characters)
  readonly NORMALIZED_NAME: 1;  // Drive-safe identifier (ASCII, underscores only)
  readonly STATUS: 2;           // "active" | "inactive"
  readonly ADDED_DATE: 3;       // ISO 8601 date "YYYY-MM-DD"
  readonly ADDED_BY: 4;         // Admin email
}

export interface PhotosAlbumsSheetColumns {
  readonly ALBUM_ID:          0;  // Google Photos album ID
  readonly ALBUM_TYPE:        1;  // "event" | "club"
  readonly EVENT_ID:          2;  // FK → Events.eventId
  readonly CLUB_NAME:         3;  // Normalized club name; empty for event-type albums
  readonly ALBUM_TITLE:       4;  // Human-readable album title
  readonly ALBUM_URL:         5;  // Google Photos product URL
  readonly SHAREABLE_URL:     6;  // Public shareable link
  readonly CREATED_AT:        7;  // ISO 8601 timestamp
  readonly LAST_SYNC_AT:      8;  // ISO 8601 timestamp of most recent sync
  readonly SYNCED_FILE_COUNT: 9;  // Cumulative number of photos pushed to album
}

export interface PhotosFilesSheetColumns {
  readonly DRIVE_FILE_ID: 0;  // Google Drive file ID (composite key part 1)
  readonly MEDIA_ITEM_ID: 1;  // Google Photos media item ID
  readonly ALBUM_ID:      2;  // Google Photos album ID (composite key part 2)
  readonly ALBUM_TYPE:    3;  // "event" | "club"
  readonly EVENT_ID:      4;  // FK → Events.eventId
  readonly CLUB_NAME:     5;  // Normalized club name; empty for event-type albums
  readonly FILE_NAME:     6;  // Original filename, e.g. "IMG_0042.jpg"
  readonly SYNCED_AT:     7;  // ISO 8601 timestamp of when the sync occurred
}
