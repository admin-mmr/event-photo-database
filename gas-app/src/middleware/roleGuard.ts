import { UserRole, ResultStatus } from '../types/enums';
import { ServiceResult } from '../types/responses';

/**
 * RoleGuard — enforces role-based access control on route handlers.
 *
 * Two admin tiers:
 *   SUPER_ADMIN — full permissions across all clubs and events.
 *   CLUB_ADMIN  — full permissions within their one assigned club's subtree.
 *
 * Volunteers (uploaders) are not stored as users and do not have a UserRole;
 * they are authenticated via upload link tokens, not through this guard.
 *
 * Usage in a route handler:
 *   const guard = requireRole(user.role, UserRole.SUPER_ADMIN);
 *   if (guard.status !== ResultStatus.SUCCESS) return accessDeniedPage(guard.message);
 */

/**
 * Role hierarchy for permission checking.
 * Higher number = more permissive.
 *
 * Returned by a function (not a top-level const) to avoid GAS file load-order
 * issues: clasp pushes files alphabetically, so `types/enums` (t) is evaluated
 * after `middleware/roleGuard` (m). A top-level const referencing UserRole would
 * read `undefined` at init time; a function call defers evaluation until runtime.
 */
function getRoleLevels(): Record<UserRole, number> {
  return {
    [UserRole.CLUB_ADMIN]:  1,
    [UserRole.SUPER_ADMIN]: 2,
  };
}

/**
 * Returns SUCCESS if the user's role meets or exceeds the required role.
 * Returns ERROR with a descriptive message if access is denied.
 *
 * @param userRole      The authenticated user's current role
 * @param requiredRole  Minimum role required to proceed
 */
export function requireRole(
  userRole: UserRole,
  requiredRole: UserRole
): ServiceResult<void> {
  const ROLE_LEVEL = getRoleLevels();
  if (ROLE_LEVEL[userRole] >= ROLE_LEVEL[requiredRole]) {
    return { status: ResultStatus.SUCCESS, message: 'Access granted' };
  }
  return {
    status: ResultStatus.ERROR,
    message: `This action requires ${requiredRole} role. Your current role is ${userRole}.`,
  };
}

/**
 * Returns true if the user is a super admin.
 * Super admins have unrestricted access across all clubs and events.
 */
export function isSuperAdmin(role: UserRole): boolean {
  return role === UserRole.SUPER_ADMIN;
}

/**
 * Returns true if the user is a club admin.
 * Club admins have full access within their assigned club's subtree only.
 */
export function isClubAdmin(role: UserRole): boolean {
  return role === UserRole.CLUB_ADMIN;
}

/**
 * Returns true if the user is any kind of admin (super or club).
 * Convenience wrapper for template rendering logic (hide/show UI elements).
 */
export function isAdmin(role: UserRole): boolean {
  return role === UserRole.SUPER_ADMIN || role === UserRole.CLUB_ADMIN;
}

/**
 * Validates that a role string from an HTTP request is a recognized UserRole.
 * Returns the typed enum value, or null if the string is invalid.
 * Used by input validation to safely cast untrusted role strings.
 */
export function parseUserRole(raw: string): UserRole | null {
  const trimmed = raw.trim().toLowerCase();
  if (Object.values(UserRole).includes(trimmed as UserRole)) {
    return trimmed as UserRole;
  }
  return null;
}
