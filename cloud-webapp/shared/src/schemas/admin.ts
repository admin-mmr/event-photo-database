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

// ── Event creation (dev plan G3.1) ────────────────────────────────────────────

export const CreateEventRequestSchema = z.object({
  name: z.string().min(1),
  /** ISO date (YYYY-MM-DD). */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
});
export type CreateEventRequest = z.infer<typeof CreateEventRequestSchema>;

export const CreatedEventSchema = z.object({
  eventId: z.string(),
  name: z.string(),
  date: z.string(),
  folderName: z.string(),
  driveFolderId: z.string(),
});
export type CreatedEvent = z.infer<typeof CreatedEventSchema>;

export const CreateEventResponseSchema = z.object({ ok: z.literal(true), event: CreatedEventSchema });
export type CreateEventResponse = z.infer<typeof CreateEventResponseSchema>;

// ── Upload links (dev plan G3.2) ──────────────────────────────────────────────

export const LinkRecordSchema = z.object({
  linkId: z.string(),
  eventId: z.string(),
  clubName: z.string(),
  token: z.string(),
  version: z.number().int().positive(),
  generatedBy: z.string().default(''),
  generatedAt: z.string().default(''),
  revokedAt: z.string().default(''),
  revokedBy: z.string().default(''),
  revokedReason: z.string().default(''),
  tag: z.string().default(''),
  status: StatusSchema, // 'active' (not revoked) | 'inactive' (revoked)
});
export type LinkRecord = z.infer<typeof LinkRecordSchema>;

export const GenerateLinkRequestSchema = z.object({
  eventId: z.string().min(1),
  clubName: z.string().min(1),
  tag: z.string().optional(),
});
export type GenerateLinkRequest = z.infer<typeof GenerateLinkRequestSchema>;

export const RevokeLinkRequestSchema = z.object({ reason: z.string().optional() });
export type RevokeLinkRequest = z.infer<typeof RevokeLinkRequestSchema>;

export const ListLinksResponseSchema = z.object({ ok: z.literal(true), links: z.array(LinkRecordSchema) });
export type ListLinksResponse = z.infer<typeof ListLinksResponseSchema>;

export const LinkResponseSchema = z.object({ ok: z.literal(true), link: LinkRecordSchema });
export type LinkResponse = z.infer<typeof LinkResponseSchema>;

// ── Audit log (dev plan G4.2) ─────────────────────────────────────────────────

export const AuditResourceTypeSchema = z.enum(['user', 'club', 'event', 'link', 'report', 'other']);
export type AuditResourceType = z.infer<typeof AuditResourceTypeSchema>;

export const AuditRecordSchema = z.object({
  auditId: z.string(),
  timestamp: z.string(),
  actorEmail: z.string().default(''),
  action: z.string().default(''),
  resourceType: z.string().default(''),
  resourceId: z.string().default(''),
  details: z.string().default(''),
  linkId: z.string().default(''),
  ip: z.string().default(''),
  reason: z.string().default(''),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

export const ListAuditResponseSchema = z.object({
  ok: z.literal(true),
  records: z.array(AuditRecordSchema),
  total: z.number().int().nonnegative(),
});
export type ListAuditResponse = z.infer<typeof ListAuditResponseSchema>;

// ── Email preferences (dev plan G4.1) ─────────────────────────────────────────

/** Per-admin opt-in flags, mirroring gas-app Email_Preferences columns. */
export const EmailPrefsSchema = z.object({
  email: z.string(),
  userCreated: z.boolean(),
  userRoleChanged: z.boolean(),
  userDeactivated: z.boolean(),
  securityEvent: z.boolean(),
  eventCreated: z.boolean(),
  dailyReport: z.boolean(),
  weeklyReport: z.boolean(),
  updatedAt: z.string().default(''),
});
export type EmailPrefs = z.infer<typeof EmailPrefsSchema>;

/** PATCH body: any subset of the boolean flags. */
export const UpdateEmailPrefsRequestSchema = z
  .object({
    userCreated: z.boolean().optional(),
    userRoleChanged: z.boolean().optional(),
    userDeactivated: z.boolean().optional(),
    securityEvent: z.boolean().optional(),
    eventCreated: z.boolean().optional(),
    dailyReport: z.boolean().optional(),
    weeklyReport: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' });
export type UpdateEmailPrefsRequest = z.infer<typeof UpdateEmailPrefsRequestSchema>;

export const EmailPrefsResponseSchema = z.object({ ok: z.literal(true), prefs: EmailPrefsSchema });
export type EmailPrefsResponse = z.infer<typeof EmailPrefsResponseSchema>;
