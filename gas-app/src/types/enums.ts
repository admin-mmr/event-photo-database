/**
 * User roles within the system.
 *
 * - SUPER_ADMIN: Full access across all clubs and events. Can create/delete clubs,
 *               manage all club admins, delete any content, and masquerade as a
 *               club admin for support. Member of the special "admin club" entity.
 * - CLUB_ADMIN:  Full access within their one assigned club's subtree. Can create
 *               events, manage upload links, view audit trail for their club, and
 *               view (read-only) other clubs' content.
 *
 * Volunteers (uploaders) are NOT stored as users. They access the system via a
 * per-(event, club) upload link and authenticate with any Google account on demand.
 */
export enum UserRole {
  SUPER_ADMIN = 'super_admin',
  CLUB_ADMIN = 'club_admin',
}

/**
 * Account lifecycle status.
 * Inactive users are blocked from login and all operations.
 */
export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

/**
 * Tracks how an upload was initiated for audit purposes.
 */
export enum UploadSource {
  WEB_APP = 'web_app',
  LINK = 'link',    // Volunteer upload via per-(event, club) link
}

/**
 * MIME types accepted by the photo upload pipeline.
 * All other MIME types are silently skipped and counted in skipped_non_photo.
 */
export enum PhotoMimeType {
  JPEG = 'image/jpeg',
  PNG  = 'image/png',
  HEIC = 'image/heic',
  WEBP = 'image/webp',
}

/**
 * Video MIME types accepted by the volunteer upload pipeline.
 * Videos are not accepted for admin uploads; volunteer links allow photo + video.
 */
export enum VideoMimeType {
  MP4 = 'video/mp4',
  MOV = 'video/quicktime',
}

/**
 * Route actions recognized by doGet (page routes) and doPost (API actions).
 * The `action` parameter in the HTTP request must match one of these values.
 */
export enum RouteAction {
  // Page routes (doGet)
  DASHBOARD = 'dashboard',
  LOGIN = 'login',
  ADMIN_USERS = 'admin_users',
  ADMIN_EVENTS = 'admin_events',
  ADMIN_CLUBS = 'admin_clubs',
  UPLOAD = 'upload',

  // Volunteer upload flow (public, no prior admin auth)
  // Step 1: ?action=upload_link&token=XYZ — pre-login confirmation page
  UPLOAD_LINK     = 'upload_link',
  // Step 2: ?action=volunteer_upload&vsession=SESSION — post-OAuth upload interface
  VOLUNTEER_UPLOAD = 'volunteer_upload',

  // API actions (doPost)
  CREATE_USER = 'create_user',
  UPDATE_USER = 'update_user',
  DEACTIVATE_USER = 'deactivate_user',
  VALIDATE_FOLDER_NAME = 'validate_folder_name',

  // Phase 2 — Event Management
  CREATE_EVENT = 'create_event',
  UPDATE_EVENT = 'update_event',
  LIST_EVENTS = 'list_events',

  // Club Management
  CREATE_CLUB = 'create_club',
  UPDATE_CLUB = 'update_club',
  DEACTIVATE_CLUB = 'deactivate_club',
  LIST_CLUBS = 'list_clubs',

  // Upload Link Management (Phase 2)
  ADMIN_LINKS   = 'admin_links',    // Admin page: list + manage links for a club
  GENERATE_LINK = 'generate_link',  // API: create a new (event, club) link
  REVOKE_LINK   = 'revoke_link',    // API: revoke/rotate an existing link
  LIST_LINKS    = 'list_links',     // API: list links (filtered by event/club)

  // Phase 4 — Admin Summary & Reconciliation
  ADMIN_SUMMARY = 'admin_summary',
  ADMIN_AUDIT   = 'admin_audit',

  // Deployment healthcheck (no auth required)
  HEALTHCHECK = 'healthcheck',

  // Phase 6 — Google Photos Albums
  SYNC_ALBUM       = 'sync_album',        // Admin: sync all Drive photos for one event → albums
  BACKFILL_ALBUMS  = 'backfill_albums',   // Admin: create + sync albums for all events
  GET_EVENT_ALBUMS = 'get_event_albums',  // Any user: get album links for an event
  ADMIN_PHOTOS     = 'admin_photos',      // Admin: photo upload overview + album management
  ADMIN_ALBUMS     = 'admin_albums',      // Admin: flat list of every Photos album with stats

  // Drive file system tree (all authenticated users)
  DRIVE_TREE = 'drive_tree',            // Visual hierarchy browser: Event → Club → Batch

  // Public album index (Phase 5 — design §6)
  // Gated by Google login (any Google account), NOT by admin registration.
  // Lists all events with synced Google Photos albums for public viewing.
  ALBUM_INDEX = 'album_index',

  // Phase 7 — Email communication preferences (admin only)
  ADMIN_EMAIL_PREFS = 'admin_email_prefs',

  // Phase 7 — Soft delete / restore
  DELETE_FILE  = 'delete_file',   // API: soft-delete a Drive file
  RESTORE_FILE = 'restore_file',  // API: restore a soft-deleted file from trash
  LIST_DELETED = 'list_deleted',  // API: list soft-deleted files

  // Upload link rotation (doPost API path — supplements serverRotateLink google.script.run)
  ROTATE_LINK = 'rotate_link',    // API: rotate (revoke + reissue) an upload link

  // Session management
  LOGOUT = 'logout',                    // Invalidate the current session token
}

/**
 * Actions recorded in the Audit_Log sheet.
 * One value per state-changing admin operation.
 */
export enum AuditAction {
  // User management
  USER_CREATED     = 'USER_CREATED',
  USER_UPDATED     = 'USER_UPDATED',
  USER_DEACTIVATED = 'USER_DEACTIVATED',
  USER_REACTIVATED = 'USER_REACTIVATED',

  // Event management
  EVENT_CREATED = 'EVENT_CREATED',
  EVENT_UPDATED = 'EVENT_UPDATED',

  // Club management
  CLUB_CREATED     = 'CLUB_CREATED',
  CLUB_UPDATED     = 'CLUB_UPDATED',
  CLUB_DEACTIVATED = 'CLUB_DEACTIVATED',
  CLUB_REACTIVATED = 'CLUB_REACTIVATED',

  // Upload link management (Phase 2)
  LINK_GENERATED = 'LINK_GENERATED',  // A new (event, club) upload link was created
  LINK_REVOKED   = 'LINK_REVOKED',    // An upload link was revoked/rotated

  // File management (Phase 7 — soft delete / restore)
  FILE_DELETED   = 'FILE_DELETED',    // File moved to trash (soft delete)
  FILE_RESTORED  = 'FILE_RESTORED',   // File recovered from trash
  FOLDER_DELETED = 'FOLDER_DELETED',  // Batch folder moved to Drive trash

  // Upload lifecycle
  UPLOAD_COMPLETED     = 'UPLOAD_COMPLETED',      // A volunteer finished uploading a batch
  UPLOAD_CLIENT_ERROR  = 'UPLOAD_CLIENT_ERROR',   // Browser-side Drive upload failure reported by client

  // Super admin masquerade
  MASQUERADE_START = 'MASQUERADE_START',  // Super admin began acting as a club admin
  MASQUERADE_END   = 'MASQUERADE_END',    // Super admin ended masquerade session

  // Reporting
  EXPORT_CSV           = 'EXPORT_CSV',
  EXCEPTION_EMAIL_SENT = 'EXCEPTION_EMAIL_SENT',

  // Phase 6 — Google Photos Albums
  ALBUM_CREATED    = 'ALBUM_CREATED',    // A new Google Photos album was created
  ALBUM_SYNCED     = 'ALBUM_SYNCED',     // Photos synced to album for one event
  ALBUM_BACKFILLED = 'ALBUM_BACKFILLED', // Full backfill of all event albums completed
  ALBUM_ERROR      = 'ALBUM_ERROR',      // A Google Photos album operation failed

  // Phase 7 — Email communication
  EMAIL_SENT              = 'EMAIL_SENT',               // A notification email was dispatched
  EMAIL_FAILED            = 'EMAIL_FAILED',             // MailApp send failed for one recipient
  EMAIL_PREFS_UPDATED     = 'EMAIL_PREFS_UPDATED',      // An admin changed their opt-in settings
  SECURITY_EVENT_DETECTED = 'SECURITY_EVENT_DETECTED',  // Failed login / unknown account probe

  // Phase 7 — Data migration
  DATA_MIGRATED = 'DATA_MIGRATED',  // One-time legacy data migration completed
}

/**
 * Email notification categories. Each value is both an opt-in flag on
 * Email_Preferences and a label for the MailApp subject prefix.
 *
 * USER_ events fire on user-management mutations (create / role-change /
 * deactivate). DAILY / WEEKLY fire on scheduled time triggers.
 * SECURITY fires on auth failures from a seemingly valid Google account.
 */
export enum EmailType {
  WELCOME_USER      = 'welcome_user',        // Sent TO a newly-created user
  USER_CREATED      = 'user_created',        // Sent TO admins when a user is added
  USER_ROLE_CHANGED = 'user_role_changed',   // Sent TO admins when a role changes
  USER_DEACTIVATED  = 'user_deactivated',    // Sent TO admins when a user is deactivated
  SECURITY_EVENT    = 'security_event',      // Sent TO admins on auth anomalies
  EVENT_CREATED     = 'event_created',       // Sent TO all admins when a new event is created
  DAILY_REPORT      = 'daily_report',        // Scheduled digest, once per day
  WEEKLY_REPORT     = 'weekly_report',       // Scheduled digest, once per week
  UPLOAD_ERROR      = 'upload_error',        // Sent TO admins when client-side Drive upload fails
}

/**
 * Standardized result status for all service operations.
 * Every ServiceResult carries one of these values so callers
 * can handle outcomes without try/catch.
 */
export enum ResultStatus {
  SUCCESS = 'success',
  ERROR = 'error',
  WARNING = 'warning',
}

/**
 * Folder layer within the Drive hierarchy.
 * Used by the folder name validator to apply the correct regex rule.
 *
 * Layer 1: YYYY-MM-DD_EventName  (master event folder)
 * Layer 2: ClubName              (per-club subfolder)
 * Layer 3: YYYYMMDD-HHMMSS_user  (per-upload batch folder, auto-generated)
 */
export type FolderLayer = 1 | 2 | 3;

/**
 * Status values for rows in the Sync_Queue sheet (Phase 4).
 *
 * pending     — Newly enqueued; not yet attempted.
 * in_progress — A drain run has picked this item up and is processing it.
 *               If the GAS execution is killed mid-run, the item stays in
 *               in_progress; the drain reschedules it as pending after a
 *               configurable staleness threshold.
 * done        — Sync succeeded; Photos API confirmed the upload.
 * failed      — Max retries reached; item is left in the sheet for inspection.
 */
export enum SyncQueueStatus {
  PENDING     = 'pending',
  IN_PROGRESS = 'in_progress',
  DONE        = 'done',
  FAILED      = 'failed',
}

/**
 * Lifecycle states for a soft-deleted file row in the Deleted_Files sheet.
 *
 * deleted   — File is in trash; Drive file is still intact; 30-day clock running.
 * restored  — Admin restored the file before the 30-day window expired.
 * purged    — 30-day window elapsed; Drive file has been permanently deleted and
 *             the Photos album entry has been queued for removal via sync.
 */
export enum DeletedFileStatus {
  DELETED  = 'deleted',
  RESTORED = 'restored',
  PURGED   = 'purged',
}
