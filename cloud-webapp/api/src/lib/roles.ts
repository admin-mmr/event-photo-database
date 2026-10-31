/**
 * roles.ts — control-plane role + status vocabulary, mirroring the gas-app
 * source of truth (gas-app/src/types/enums.ts). The Google Sheet stays SSOT
 * (dev plan D2), so these string values MUST match what gas-app writes into the
 * Users / Clubs tabs verbatim — they are compared against raw cell text.
 *
 * Classes, most to least privileged:
 *   owner       — everything a super_admin can do, plus delete events. Granted
 *                 ONLY by the OWNER_EMAILS env allowlist (admin@mmrunners.org),
 *                 never by a Users row — see OWNER below.
 *   super_admin — every club and every link; manages users, clubs, masquerade.
 *   club_admin  — pinned to their own club.
 *   api_client  — partner REST API only; no admin UI.
 */

export const UserRole = {
  /**
   * The org owner. NOT a Sheet role: the Users tab is world-viewable and
   * super_admins edit it, so a cell saying `owner` must grant nothing — that
   * would let any super_admin promote themselves to deleting events.
   * `isUserRole` deliberately rejects it; attachRole grants it from env only.
   */
  OWNER: 'owner',
  SUPER_ADMIN: 'super_admin',
  CLUB_ADMIN: 'club_admin',
  /** Programmatic upload partner (REST API only; no admin UI). Lands in G5. */
  API_CLIENT: 'api_client',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];
/** A role a Users row can hold — every class except owner. */
export type StoredRole = Exclude<UserRole, typeof UserRole.OWNER>;

export const UserStatus = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

/** A role that may be stored in (and read from) the Users sheet. Excludes owner. */
export function isUserRole(v: string): v is StoredRole {
  return v === UserRole.SUPER_ADMIN || v === UserRole.CLUB_ADMIN || v === UserRole.API_CLIENT;
}

/** owner or super_admin: sees every club (unless masquerading). */
export function isGlobalAdmin(role: string | undefined): boolean {
  return role === UserRole.OWNER || role === UserRole.SUPER_ADMIN;
}
