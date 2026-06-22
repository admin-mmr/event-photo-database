import { z } from 'zod';

/**
 * Control-plane admin contracts (dev plan G2): users + clubs management and
 * super-admin masquerade. The Google Sheet is SSOT (D2); these are the API
 * surface only. Role/status string values MUST match api/src/lib/roles.ts and
 * what gas-app writes into the Users/Clubs tabs.
 */

export const RoleSchema = z.enum(['super_admin', 'club_admin', 'api_client']);
export type Role = z.infer<typeof RoleSchema>;

export const StatusSchema = z.enum(['active', 'inactive']);
export type Status = z.infer<typeof StatusSchema>;

// ── Users ────────────────────────────────────────────────────────────────────

export const UserRecordSchema = z.object({
  email: z.string(),
  firstName: z.string().default(''),
  lastName: z.string().default(''),
  role: RoleSchema,
  clubId: z.string().default(''),
  status: StatusSchema,
  addedAt: z.string().default(''),
  addedBy: z.string().default(''),
  lastLoginAt: z.string().default(''),
});
export type UserRecord = z.infer<typeof UserRecordSchema>;

export const CreateUserRequestSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: RoleSchema,
  clubId: z.string().optional(),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

export const UpdateUserRequestSchema = z
  .object({
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    role: RoleSchema.optional(),
    clubId: z.string().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' });
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

export const ListUsersResponseSchema = z.object({ ok: z.literal(true), users: z.array(UserRecordSchema) });
export type ListUsersResponse = z.infer<typeof ListUsersResponseSchema>;

export const UserResponseSchema = z.object({ ok: z.literal(true), user: UserRecordSchema });
export type UserResponse = z.infer<typeof UserResponseSchema>;

// ── Clubs ────────────────────────────────────────────────────────────────────

export const ClubRecordSchema = z.object({
  displayName: z.string(),
  normalizedName: z.string(),
  status: StatusSchema,
  addedAt: z.string().default(''),
  addedBy: z.string().default(''),
});
export type ClubRecord = z.infer<typeof ClubRecordSchema>;

export const CreateClubRequestSchema = z.object({
  displayName: z.string().min(1),
  normalizedName: z.string().min(1),
});
export type CreateClubRequest = z.infer<typeof CreateClubRequestSchema>;

export const UpdateClubRequestSchema = z.object({ displayName: z.string().min(1) });
export type UpdateClubRequest = z.infer<typeof UpdateClubRequestSchema>;

export const ListClubsResponseSchema = z.object({ ok: z.literal(true), clubs: z.array(ClubRecordSchema) });
export type ListClubsResponse = z.infer<typeof ListClubsResponseSchema>;

export const ClubResponseSchema = z.object({ ok: z.literal(true), club: ClubRecordSchema });
export type ClubResponse = z.infer<typeof ClubResponseSchema>;

// ── Masquerade (super-admin acting as a club_admin for support) ───────────────

export const MasqueradeStartRequestSchema = z.object({ clubId: z.string().min(1) });
export type MasqueradeStartRequest = z.infer<typeof MasqueradeStartRequestSchema>;

export const MasqueradeResponseSchema = z.object({
  ok: z.literal(true),
  /** The club the super-admin is now acting as, or null after ending. */
  actingAsClub: z.string().nullable(),
});
export type MasqueradeResponse = z.infer<typeof MasqueradeResponseSchema>;
