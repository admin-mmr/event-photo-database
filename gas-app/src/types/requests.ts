import { UserRole, UserStatus, FolderLayer, RouteAction } from './enums';

/**
 * Normalized application request object built by the router after
 * authentication and role resolution. Passed to every route handler.
 */
export interface AppRequest {
  readonly action: RouteAction;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly userEmail: string;
  readonly userRole: UserRole;
  readonly timestamp: string; // ISO 8601
}

/**
 * Input DTO for creating a new user (admin-only action).
 *
 * Only admins are created through this path. Volunteers are not pre-registered;
 * they authenticate on demand via upload links.
 */
export interface CreateUserInput {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly role: UserRole;
  /**
   * Required when role === CLUB_ADMIN: the normalizedName of the club this person administers.
   * Must be empty (or omitted) when role === SUPER_ADMIN.
   * A person cannot be club admin for more than one club.
   */
  readonly clubId?: string;
}

/**
 * Input DTO for updating an existing user.
 * Only the fields provided will be changed; others are preserved.
 */
export interface UpdateUserInput {
  readonly email: string;           // Lookup key — cannot be changed
  readonly firstName?: string;
  readonly lastName?: string;
  readonly role?: UserRole;
  readonly status?: UserStatus;
  /**
   * May only be set when role === CLUB_ADMIN. Pass empty string to clear.
   * Multiple club_admins for the same club are allowed; cross-club access is
   * enforced at the route-handler layer based on the caller's own clubId.
   */
  readonly clubId?: string;
}

/**
 * Input DTO for the folder name validator utility.
 */
export interface ValidateFolderNameInput {
  readonly folderName: string;
  readonly layer: FolderLayer;
}

/**
 * Input DTO for creating a new event (admin-only).
 */
export interface CreateEventInput {
  readonly eventName: string;
  readonly eventDate: string; // "YYYY-MM-DD"
}

/**
 * Input DTO for updating an existing event (admin-only).
 * Only eventName and eventDate can be modified — the folder name
 * and Drive folder are immutable once created.
 */
export interface UpdateEventInput {
  readonly eventId: string;        // Lookup key — UUID from Events sheet
  readonly eventName?: string;     // New display name (does NOT rename Drive folder)
  readonly eventDate?: string;     // New date string "YYYY-MM-DD"
}

/**
 * Input DTO for creating a new club (super admin only).
 */
export interface CreateClubInput {
  readonly displayName: string;      // UI label, e.g. "驰跑团"
  readonly normalizedName: string;   // Drive folder key, e.g. "CHI" or "New_Bee"
}

/**
 * Input DTO for updating an existing club (super admin only).
 * Only the displayName can be changed; normalizedName is immutable (Drive folders depend on it).
 */
export interface UpdateClubInput {
  readonly normalizedName: string;   // Lookup key — cannot be changed
  readonly displayName?: string;     // New UI label
}

// ─── Upload Link Management ───────────────────────────────────────────────────

/**
 * Input DTO for generating a new (event, club) upload link.
 *
 * Only one active link per (eventId, clubName, tag) triple is allowed. Calling
 * generateLink when an active link already exists for the same triple returns
 * the existing link rather than creating a duplicate.
 *
 * If a previously revoked link exists for the same triple, a fresh link is created.
 *
 * `tag` is optional. When provided, uploads via this link will be stored in a
 * tag-named subfolder inside the club folder (e.g. "finish_line"). When omitted
 * or empty, uploads go directly into the club folder (the default / "all" behaviour).
 */
export interface GenerateLinkInput {
  readonly eventId: string;    // FK → EventRecord.eventId
  readonly clubName: string;   // Normalized club name
  readonly tag?: string;       // Optional photographer/location label (e.g. "finish_line")
}

/**
 * Input DTO for revoking an upload link.
 *
 * Club admins can revoke links for their own club.
 * Super admins can revoke any link.
 * After revocation, holders of the old URL receive a "link revoked" message.
 *
 * Rotation is revoke + generate: call revokeLink then generateLink to issue
 * a fresh token for the same (event, club) pair.
 */
export interface RevokeLinkInput {
  readonly linkId: string;
  readonly reason?: string;   // Optional free-text reason logged to audit
}

/**
 * Input DTO for looking up an upload link by its token.
 * Used on the link landing page to show confirmation before Google login.
 */
export interface ValidateLinkInput {
  readonly token: string;
}
