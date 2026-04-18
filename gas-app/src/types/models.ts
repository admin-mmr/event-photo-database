import { UserRole, UserStatus, UploadSource, AuditAction } from './enums';

/**
 * A row in the "Users" sheet.
 * Column order mirrors SheetColumns.USERS in config.ts.
 * All fields are readonly — mutations go through UserService methods.
 */
export interface UserRecord {
  readonly email: string;         // Google account email (primary key)
  readonly runningClub: string;   // Must match an approved club normalizedName
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly addedDate: string;     // ISO 8601 date: "YYYY-MM-DD"
  readonly addedBy: string;       // Admin email who created the record
}

/**
 * A row in the "Events" sheet.
 */
export interface EventRecord {
  readonly eventId: string;         // UUID v4
  readonly eventName: string;       // Human-readable, e.g. "NYC Marathon"
  readonly eventDate: string;       // ISO 8601 date: "YYYY-MM-DD"
  readonly folderName: string;      // YYYY-MM-DD_EventName (Layer 1 pattern)
  readonly driveFolderId: string;   // Google Drive folder ID for master folder
  readonly createdBy: string;       // Admin email
  readonly createdAt: string;       // ISO 8601 timestamp
}

/**
 * A row in the "Upload_Log" sheet.
 */
export interface UploadLogRecord {
  readonly logId: string;             // UUID v4
  readonly eventId: string;           // FK → EventRecord.eventId
  readonly clubName: string;          // Normalized club name
  readonly uploadedBy: string;        // User email
  readonly batchFolderName: string;   // YYYYMMDD-HHMMSS_username
  readonly batchFolderId: string;     // Google Drive folder ID
  readonly fileCount: number;         // Photos successfully uploaded
  readonly totalSizeMb: number;       // Combined size of uploaded photos
  readonly skippedDuplicates: number; // Files skipped due to duplicate detection
  readonly skippedNonPhoto: number;   // Files skipped due to wrong MIME type
  readonly uploadTimestamp: string;   // ISO 8601 timestamp
  readonly source: UploadSource;
}

/**
 * A row in the "Audit_Log" sheet.
 * Written once per successful state-changing admin operation.
 * Records are append-only — never updated or deleted.
 */
export interface AuditLogRecord {
  readonly auditId:      string;      // UUID v4
  readonly timestamp:    string;      // ISO 8601 timestamp
  readonly actorEmail:   string;      // Admin who performed the action
  readonly action:       AuditAction; // What was done
  readonly resourceType: string;      // 'user' | 'event' | 'club' | 'report'
  readonly resourceId:   string;      // Email / eventId / normalizedName / ''
  readonly details:      string;      // JSON string of relevant payload fields
}

/**
 * A row in the "Photos_Albums" sheet.
 * Stores the mapping between events/clubs and their Google Photos album IDs.
 *
 * albumType = 'event' → master album for the whole event (all clubs)
 * albumType = 'club'  → per-club album for a specific event+club combination
 */
export interface PhotosAlbumRecord {
  readonly albumId:         string;            // Google Photos album ID
  readonly albumType:       'event' | 'club';  // Scope of the album
  readonly eventId:         string;            // FK → EventRecord.eventId
  readonly clubName:        string;            // Normalized club name; empty for event-type albums
  readonly albumTitle:      string;            // Human-readable title shown in Google Photos
  readonly albumUrl:        string;            // Direct product URL for viewing in Google Photos
  readonly shareableUrl:    string;            // Public shareable link (post-share call)
  readonly createdAt:       string;            // ISO 8601 timestamp
  readonly lastSyncAt:      string;            // ISO 8601 timestamp; empty until first sync
  readonly syncedFileCount: number;            // Cumulative photos pushed to this album
}

/**
 * An entry in the approved clubs list.
 * `normalizedName` is used for Drive folder naming (underscores, no spaces).
 * `displayName` is shown in the UI.
 */
export interface ClubEntry {
  readonly displayName: string;      // "New Bee"
  readonly normalizedName: string;   // "New_Bee" — used as Drive folder name
}

/**
 * A row in the "Clubs" sheet.
 * Clubs managed here replace the static APPROVED_CLUBS constant.
 * Admins can add/deactivate clubs via the admin UI without a code deploy.
 */
export interface ClubRecord {
  readonly displayName: string;      // Chinese/display name shown in UI, e.g. "驰跑团"
  readonly normalizedName: string;   // Folder-safe identifier, e.g. "CHI" or "New_Bee"
  readonly status: 'active' | 'inactive';
  readonly addedDate: string;        // ISO 8601 date: "YYYY-MM-DD"
  readonly addedBy: string;          // Admin email who created the record
}
