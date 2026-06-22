/**
 * roles.ts — control-plane role + status vocabulary, mirroring the gas-app
 * source of truth (gas-app/src/types/enums.ts). The Google Sheet stays SSOT
 * (dev plan D2), so these string values MUST match what gas-app writes into the
 * Users / Clubs tabs verbatim — they are compared against raw cell text.
 */

export const UserRole = {
  SUPER_ADMIN: 'super_admin',
  CLUB_ADMIN: 'club_admin',
  /** Programmatic upload partner (REST API only; no admin UI). Lands in G5. */
  API_CLIENT: 'api_client',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const UserStatus = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export function isUserRole(v: string): v is UserRole {
  return v === UserRole.SUPER_ADMIN || v === UserRole.CLUB_ADMIN || v === UserRole.API_CLIENT;
}
