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

// ── Current session ("who am I") ──────────────────────────────────────────────

/**
 * GET /api/me — the signed-in caller's control-plane identity, so the web app
 * can render role-aware navigation. `role` is null for a signed-in member or
 * an anonymous guest with no Users row (and no bootstrap-admin allowlist hit).
 * Authorization is still enforced per-route on the server; this is UI-only.
 */
export const MeResponseSchema = z.object({
  ok: z.literal(true),
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  role: RoleSchema.nullable(),
  /** Club normalizedName for a club_admin; '' otherwise. */
  clubId: z.string().default(''),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

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

// ── Deleted-files lifecycle (dev plan G5.1) ───────────────────────────────────

export const DeletedFileSchema = z.object({
  deleteId: z.string(),
  driveFileId: z.string(),
  fileName: z.string().default(''),
  eventId: z.string().default(''),
  clubName: z.string().default(''),
  batchFolderName: z.string().default(''),
  uploadedBy: z.string().default(''),
  deletedAt: z.string().default(''),
  deletedBy: z.string().default(''),
  deletedReason: z.string().default(''),
  restoredAt: z.string().default(''),
  restoredBy: z.string().default(''),
  purgedAt: z.string().default(''),
  status: z.enum(['deleted', 'restored', 'purged']),
});
export type DeletedFile = z.infer<typeof DeletedFileSchema>;

export const SoftDeleteRequestSchema = z.object({
  driveFileId: z.string().min(1),
  clubName: z.string().min(1),
  fileName: z.string().optional(),
  eventId: z.string().optional(),
  batchFolderName: z.string().optional(),
  uploadedBy: z.string().optional(),
  reason: z.string().optional(),
});
export type SoftDeleteRequest = z.infer<typeof SoftDeleteRequestSchema>;

export const ListDeletedFilesResponseSchema = z.object({ ok: z.literal(true), files: z.array(DeletedFileSchema) });
export type ListDeletedFilesResponse = z.infer<typeof ListDeletedFilesResponseSchema>;

export const DeletedFileResponseSchema = z.object({ ok: z.literal(true), file: DeletedFileSchema });
export type DeletedFileResponse = z.infer<typeof DeletedFileResponseSchema>;

export const PurgeResponseSchema = z.object({
  ok: z.literal(true),
  purged: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type PurgeResponse = z.infer<typeof PurgeResponseSchema>;

// ── Reporting (dev plan G5.2) ─────────────────────────────────────────────────

export const ClubSummarySchema = z.object({
  clubName: z.string(),
  sessions: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  sizeMb: z.number().nonnegative(),
});
export type ClubSummary = z.infer<typeof ClubSummarySchema>;

export const SummaryResponseSchema = z.object({
  ok: z.literal(true),
  since: z.string(),
  until: z.string(),
  totals: z.object({
    sessions: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    sizeMb: z.number().nonnegative(),
  }),
  byClub: z.array(ClubSummarySchema),
});
export type SummaryResponse = z.infer<typeof SummaryResponseSchema>;

// ── Partner REST API (dev plan G5.3) ──────────────────────────────────────────

export const PartnerEventSchema = z.object({
  eventId: z.string(),
  name: z.string().default(''),
  date: z.string().default(''),
});
export type PartnerEvent = z.infer<typeof PartnerEventSchema>;

export const PartnerEventsResponseSchema = z.object({ ok: z.literal(true), events: z.array(PartnerEventSchema) });
export type PartnerEventsResponse = z.infer<typeof PartnerEventsResponseSchema>;

export const PartnerLinkRequestSchema = z.object({ eventId: z.string().min(1), tag: z.string().optional() });
export type PartnerLinkRequest = z.infer<typeof PartnerLinkRequestSchema>;

export const PartnerLinkResponseSchema = z.object({
  ok: z.literal(true),
  uploadUrl: z.string(),
  token: z.string(),
  eventId: z.string(),
  clubName: z.string(),
  tag: z.string(),
});
export type PartnerLinkResponse = z.infer<typeof PartnerLinkResponseSchema>;
