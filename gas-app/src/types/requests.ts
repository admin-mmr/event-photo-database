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
