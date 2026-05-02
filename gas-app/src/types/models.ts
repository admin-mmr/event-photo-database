import { UserRole, UserStatus, UploadSource, AuditAction, SyncQueueStatus } from './enums';

/**
 * A row in the "Users" sheet.
 * Column order mirrors SheetColumns.USERS in config.ts.
 * All fields are readonly — mutations go through UserService methods.
 *
 * Volunteers (uploaders) are NOT stored here. They access the system via a
 * per-(event, club) upload link and only need a Google account in the moment.
 */
export interface UserRecord {
  readonly email: string;         // Google account email (primary key)
  readonly firstName: string;     // Given name from Google profile (captured on first login)
  readonly lastName: string;      // Family name from Google profile (captured on first login)
  readonly role: UserRole;
  readonly status: UserStatus;
  /**
   * For CLUB_ADMIN: the normalizedName of the one club this person administers.
   * For SUPER_ADMIN: empty string — super admins are not scoped to a club.
   * A person cannot be club admin for more than one club; promote to super admin if needed.
   */
  readonly clubId: string;
  readonly addedDate: string;     // ISO 8601 date: "YYYY-MM-DD"
  readonly addedBy: string;       // Admin email who created the record
  readonly lastLoginAt: string;   // ISO 8601 timestamp of most recent login; empty until first login
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
  readonly uploadedBy: string;        // Uploader's Google email
  readonly batchFolderName: string;   // YYYYMMDD-HHMMSS_username
  readonly batchFolderId: string;     // Google Drive folder ID
  readonly fileCount: number;         // Photos successfully uploaded
  readonly totalSizeMb: number;       // Combined size of uploaded photos
  readonly skippedDuplicates: number; // Files skipped due to duplicate detection
  readonly skippedNonPhoto: number;   // Files skipped due to wrong MIME type
  readonly uploadTimestamp: string;   // ISO 8601 timestamp of session completion
  readonly source: UploadSource;
  readonly linkId: string;            // Upload link ID used for this session; empty for admin uploads
  readonly durationMs: number;        // Wall-clock upload duration in milliseconds; 0 if not measured (legacy rows)
}

/**
 * A row in the "Upload_Links" sheet.
 *
 * One record per (event, club, tag) triple. A link is permanent (no expiration)
 * but revocable. Rotating a link increments `version` and clears `revokedAt`; the
 * old token can no longer be used, but the (linkId, version) pair is preserved
 * in every audit row written while that token was active — so forensic history
 * survives rotation.
 *
 * `tag` is an optional photographer/location label (e.g. "finish_line", "mile_10").
 * Defaults to 'ALL' (DEFAULT_TAG) when not specified, ensuring a uniform Drive
 * hierarchy: Event / Club / Tag / batch_folders / files.
 * Legacy rows written before DEFAULT_TAG was introduced carry tag = '' and their
 * files remain directly under Club/ — the drive tree walker handles both.
 *
 * Bearer-token semantics: anyone who holds the URL can upload within the scope
 * encoded in the link, provided they also authenticate via Google OAuth.
 */
export interface UploadLinkRecord {
  readonly linkId:        string;  // UUID v4 — stable across rotations
  readonly eventId:       string;  // FK → EventRecord.eventId
  readonly clubName:      string;  // Normalized club name (Drive folder key)
  readonly token:         string;  // URL-safe random secret (changes on rotation)
  readonly version:       number;  // Incremented each time the link is rotated
  readonly generatedBy:   string;  // Admin email who created/last-rotated the link
  readonly generatedAt:   string;  // ISO 8601 timestamp of creation/last rotation
  readonly revokedAt:     string;  // ISO 8601 timestamp of revocation; empty if active
  readonly revokedBy:     string;  // Admin email who revoked; empty if not revoked
  readonly revokedReason: string;  // Free-text reason for revocation; empty if not revoked
  readonly tag:           string;  // Optional location/photographer label; empty = default (all)
}

/**
 * A row in the "Audit_Log" sheet.
 * Written once per successful state-changing operation.
 * Records are append-only — never updated or deleted.
 */
export interface AuditLogRecord {
  readonly auditId:      string;      // UUID v4
  readonly timestamp:    string;      // ISO 8601 timestamp
  readonly actorEmail:   string;      // User who performed the action (admin or volunteer email)
  readonly action:       AuditAction; // What was done
  readonly resourceType: string;      // 'user' | 'event' | 'club' | 'link' | 'file' | 'report'
  readonly resourceId:   string;      // Email / eventId / normalizedName / linkId / ''
  readonly details:      string;      // JSON string of relevant payload fields
  readonly linkId:       string;      // Upload link ID used (for uploads — preserves forensics after rotation); empty otherwise
  readonly ipAddress:    string;      // IP address of the actor; empty if unavailable
  readonly reason:       string;      // Optional free-text reason (especially for deletes/revocations)
}

/**
 * A row in the "Photo_Albums" sheet.
 * Stores the mapping between events/clubs and their Google Photos album IDs.
 *
 * albumType = 'event' → master album for the whole event (all photos across all clubs/tags).
 *                       clubName and tag are empty.
 * albumType = 'club'  → per (event, club, tag) album. clubName and tag are both
 *                       non-empty — every upload carries an explicit tag, so
 *                       there is no plain per-club album.
 *
 * The composite key for non-event albums is (eventId, clubName, tag).
 */
export interface PhotosAlbumRecord {
  readonly albumId:         string;            // Google Photos album ID
  readonly albumType:       'event' | 'club';  // Scope of the album
  readonly eventId:         string;            // FK → EventRecord.eventId
  readonly clubName:        string;            // Normalized club name; empty for event-type albums
  readonly tag:             string;            // Tag/photographer label; empty for event-type albums
  readonly albumTitle:      string;            // Human-readable title shown in Google Photos
  readonly albumUrl:        string;            // Direct product URL for viewing in Google Photos
  /**
   * Vestigial — kept in the schema for backward compat with rows written by
   * older code. Library-API sharing was deprecated in 2024, so we can no
   * longer set a distinct shareable URL programmatically: createGoogleAlbum()
   * now writes albumUrl into both fields. New consumers should read
   * `albumUrl` exclusively; this column will be dropped in a future migration.
   */
  readonly shareableUrl:    string;
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
 * A row in the "Photo_Files" sheet.
 * Records the mapping between a Google Drive file and the Google Photos media
 * item created when it was synced to an album.
 *
 * Composite key: (driveFileId, albumId) — the same Drive file is synced to
 * both an event album and a club album, producing two rows per photo.
 *
 * This table is the source of truth for:
 *   - Deduplication: before uploading, check whether (driveFileId, albumId)
 *     already exists; skip if so.
 *   - Reconciliation: compare Drive file counts against rows here per event
 *     to detect photos not yet synced to Google Photos.
 */
export interface PhotosFileRecord {
  readonly driveFileId: string;           // Google Drive file ID (key col A)
  readonly mediaItemId: string;           // Google Photos media item ID (col B)
  readonly albumId:     string;           // Photos album ID (key col C)
  readonly albumType:   'event' | 'club'; // Scope of the album (col D)
  readonly eventId:     string;           // FK → Events.eventId (col E)
  readonly clubName:    string;           // Normalized club name; empty for event albums (col F)
  readonly tag:         string;           // Tag/photographer label; empty for event albums (col G)
  readonly fileName:    string;           // Original filename, e.g. "IMG_0042.jpg" (col H)
  readonly syncedAt:    string;           // ISO 8601 timestamp of sync (col I)
}

/**
 * A row in the "Email_Preferences" sheet.
 *
 * One row per admin (keyed by email) storing a boolean opt-in flag per
 * EmailType. Values are stored as "TRUE" / "FALSE" strings in the sheet so
 * the cell remains human-editable; the mapper coerces to booleans.
 *
 * Default policy when a row is absent:
 *   - transactional notifications (USER_*, SECURITY_*) → opted IN
 *   - scheduled digests (DAILY_REPORT, WEEKLY_REPORT) → opted OUT
 *
 * These defaults are applied in emailPreferenceService.getPreferencesFor()
 * and match the rollout plan: admins get critical events automatically and
 * can silently opt OUT; they must explicitly opt IN to recurring digests.
 */
export interface EmailPreferenceRecord {
  readonly email: string;                    // Admin email (lowercase, primary key)
  readonly userCreated: boolean;             // CC on new-user notifications
  readonly userRoleChanged: boolean;         // CC on role-change notifications
  readonly userDeactivated: boolean;         // CC on deactivation notifications
  readonly securityEvent: boolean;           // Receive failed-login alerts
  readonly eventCreated: boolean;            // Receive new-event creation alerts
  readonly dailyReport: boolean;             // Receive the daily digest
  readonly weeklyReport: boolean;            // Receive the weekly digest
  readonly updatedAt: string;                // ISO 8601 timestamp of last change
}

/**
 * A row in the "Sync_Queue" sheet (Phase 4).
 *
 * Each row represents one Drive batch folder that must be synced to Google Photos.
 * The queue is written by serverCompleteUpload / serverCompleteVolunteerUpload and
 * drained by the drainSyncQueueTrigger() time-trigger function.
 *
 * Retry strategy:
 *   - A drain run marks the item in_progress, then calls syncBatchToAlbums().
 *   - On success → status = done, completedAt = now.
 *   - On failure → attempts++, status = pending (up to MAX_SYNC_ATTEMPTS),
 *                  then status = failed permanently so it doesn't loop.
 *   - If a GAS execution is killed mid-run (6-min wall-clock limit), the item
 *     stays in_progress. The next drain run treats items stuck in_progress for
 *     longer than SYNC_STUCK_THRESHOLD_MINUTES as pending again.
 */
export interface SyncQueueRecord {
  readonly queueId:        string;            // UUID v4 (primary key)
  readonly eventId:        string;            // FK → Events.eventId
  readonly clubName:       string;            // Normalized club name
  readonly tag:            string;            // Tag/photographer label captured from upload link
  readonly batchFolderId:  string;            // Google Drive folder ID for this batch
  readonly batchFolderName: string;           // Human-readable batch folder name
  readonly enqueuedAt:     string;            // ISO 8601 timestamp
  readonly status:         SyncQueueStatus;   // pending | in_progress | done | failed
  readonly attempts:       number;            // Number of drain attempts made
  readonly lastAttemptAt:  string;            // ISO 8601 timestamp; empty until first attempt
  readonly errorMsg:       string;            // Last error text; empty if no error yet
  readonly completedAt:    string;            // ISO 8601 timestamp; empty until done
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

/**
 * A row in the "Deleted_Files" sheet (Phase 7 — soft delete).
 *
 * Records are written by softDeleteFile() and updated in place by restoreFile()
 * and purgeDeletedFiles(). A row is never hard-deleted from the sheet — the
 * full lifecycle (deleted → restored or purged) is preserved for the audit trail.
 */
export interface DeletedFileRecord {
  readonly deleteId:        string;  // UUID v4 (primary key)
  readonly driveFileId:     string;  // Google Drive file ID
  readonly fileName:        string;  // Original filename (for UI display)
  readonly eventId:         string;  // FK → EventRecord.eventId
  readonly clubName:        string;  // Normalized club name
  readonly batchFolderName: string;  // Batch folder where the file lived
  readonly uploadedBy:      string;  // Original uploader's Google email
  readonly deletedAt:       string;  // ISO 8601 timestamp of soft-delete
  readonly deletedBy:       string;  // Admin email who triggered the delete
  readonly deletedReason:   string;  // Free-text reason (optional; empty if none)
  readonly restoredAt:      string;  // ISO 8601 timestamp of restore; empty if not restored
  readonly restoredBy:      string;  // Admin email who restored; empty if not restored
  readonly purgedAt:        string;  // ISO 8601 timestamp of hard-delete; empty if not purged
  readonly status:          import('./enums').DeletedFileStatus;
}
