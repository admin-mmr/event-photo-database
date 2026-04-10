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
 */
export interface CreateUserInput {
  readonly email: string;
  readonly runningClub: string;
  readonly role: UserRole;
}

/**
 * Input DTO for updating an existing user.
 * Only the fields provided will be changed; others are preserved.
 */
export interface UpdateUserInput {
  readonly email: string;           // Lookup key — cannot be changed
  readonly runningClub?: string;
  readonly role?: UserRole;
  readonly status?: UserStatus;
}

/**
 * Input DTO for the folder name validator utility.
 */
export interface ValidateFolderNameInput {
  readonly folderName: string;
  readonly layer: FolderLayer;
}

/**
 * Input DTO for creating a new event (admin-only, Phase 2).
 * Defined here so the type system is complete in Phase 1.
 */
export interface CreateEventInput {
  readonly eventName: string;
  readonly eventDate: string; // "YYYY-MM-DD"
}

/**
 * Input DTO for updating an existing event (admin-only, Phase 2).
 * Only eventName and eventDate can be modified — the folder name
 * and Drive folder are immutable once created.
 */
export interface UpdateEventInput {
  readonly eventId: string;        // Lookup key — UUID from Events sheet
  readonly eventName?: string;     // New display name (does NOT rename Drive folder)
  readonly eventDate?: string;     // New date string "YYYY-MM-DD"
}

/**
 * Input DTO for creating a new club (admin-only).
 */
export interface CreateClubInput {
  readonly displayName: string;      // UI label, e.g. "驰跑团"
  readonly normalizedName: string;   // Drive folder key, e.g. "CHI" or "New_Bee"
}

/**
 * Input DTO for updating an existing club (admin-only).
 * Only the displayName can be changed; normalizedName is immutable (Drive folders depend on it).
 */
export interface UpdateClubInput {
  readonly normalizedName: string;   // Lookup key — cannot be changed
  readonly displayName?: string;     // New UI label
}
