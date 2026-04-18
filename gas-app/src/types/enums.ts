/**
 * User roles within the system.
 *
 * - ADMIN:      Full access — event management, user CRUD, reports.
 * - USER:       Can view events and upload photos for their club.
 * - API_CLIENT: Machine-to-machine access for partner orgs (Phase 5).
 */
export enum UserRole {
  ADMIN = 'admin',
  USER = 'user',
  API_CLIENT = 'api_client',
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
  API = 'api',
}

/**
 * MIME types accepted by the photo upload pipeline.
 * All other MIME types are silently skipped and counted in skipped_non_photo.
 */
export enum PhotoMimeType {
  JPEG = 'image/jpeg',
  PNG = 'image/png',
  HEIC = 'image/heic',
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

  // Phase 4 — Admin Summary & Reconciliation
  ADMIN_SUMMARY = 'admin_summary',
  ADMIN_AUDIT   = 'admin_audit',

  // Deployment healthcheck (no auth required)
  HEALTHCHECK = 'healthcheck',

  // Phase 5 — Cross-Org REST API
  // These are accessed by external GAS programs via HTTP, not the browser UI.
  API_CHECK_FOLDER = 'api_check_folder',   // GET: resolve event name → folder ID
  API_LIST_FILES   = 'api_list_files',     // GET: list files in a club folder
  API_UPLOAD_FILE  = 'api_upload_file',    // POST: upload a single photo
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

  // Reporting
  EXPORT_CSV           = 'EXPORT_CSV',
  EXCEPTION_EMAIL_SENT = 'EXCEPTION_EMAIL_SENT',
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
