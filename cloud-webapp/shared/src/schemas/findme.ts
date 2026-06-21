import { z } from 'zod';

/**
 * Find Me contracts (dev plan M2; PRD §5, §7). Demo fast-path scope
 * (2026-06-12): search + gallery only — feedback, enrollment, and the
 * minor/guardian consent flow land with M3/M4.
 */

// ── Gallery (GET /api/events/:id/photos) ─────────────────────────────────────

export const GalleryPhotoSchema = z.object({
  photoId: z.string(),
  name: z.string().default(''),
  /** Short-lived V4 signed URL for the thumbnail (always present). */
  thumbUrl: z.string(),
  /** Full-size `web` derivative URL. Optional: the gallery list omits it (it's
   *  signed lazily when a photo is opened in the lightbox). Find Me results
   *  still include it inline. */
  webUrl: z.string().optional(),
  /** Capture time (CAPTURE_TIME_SORT_DESIGN), ISO-8601 zone-less wall-clock,
   *  e.g. "2026-06-20T14:30:52". Null when no time tier resolved. */
  takenAt: z.string().nullable().default(null),
  /** Which tier produced takenAt: "exif" | "drive_exif" | "created" |
   *  "modified" | "none". Lets the UI flag best-guesses ("approx"). */
  takenAtSource: z.string().default(''),
  /** Upload/added time = the photo's Drive createdTime (ISO-8601). Powers the
   *  gallery's newest-first default sort. Null for photos indexed before the
   *  field existed (until a reindex backfills it). */
  addedAt: z.string().nullable().default(null),
});
export type GalleryPhoto = z.infer<typeof GalleryPhotoSchema>;

/** GET /api/events/:id/photos/:photoId/web — lazily signed full-size URL. */
export const PhotoWebUrlResponseSchema = z.object({
  ok: z.literal(true),
  photoId: z.string(),
  webUrl: z.string(),
});
export type PhotoWebUrlResponse = z.infer<typeof PhotoWebUrlResponseSchema>;

export const ListPhotosResponseSchema = z.object({
  ok: z.literal(true),
  eventId: z.string(),
  /** Human-readable event name (from Drive folder / master Sheet). Empty when
   *  the event has no name yet — the UI applies its own fallback (B5). */
  eventName: z.string().default(''),
  photos: z.array(GalleryPhotoSchema),
  /** Opaque cursor for the next page (the last photoId of this page), or null
   *  when this is the final page. Pass it back as `?cursor=` to fetch more. */
  nextCursor: z.string().nullable().default(null),
});
export type ListPhotosResponse = z.infer<typeof ListPhotosResponseSchema>;

// ── Batch download (POST /api/events/:id/download → application/zip) ──────────

/** Hard cap on photos per ZIP request — bounds server memory/time and the
 *  client-side blob. Realistic selections are dozens; large galleries should
 *  download in batches. Revisit with streaming-to-disk if this becomes a
 *  limit users hit (see B1 follow-up note). */
export const MAX_DOWNLOAD_PHOTOS = 200;

export const DownloadRequestSchema = z.object({
  photoIds: z.array(z.string().min(1)).min(1).max(MAX_DOWNLOAD_PHOTOS),
});
export type DownloadRequest = z.infer<typeof DownloadRequestSchema>;

/**
 * Response of POST /api/events/:id/download. The endpoint no longer streams a
 * server-assembled ZIP (which proxied every original byte through Cloud Run +
 * the Firebase Hosting `/api/**` rewrite, billing them as Hosting egress).
 * Instead it returns short-lived signed GCS URLs and the client assembles the
 * ZIP in the browser, so the heavy bytes flow GCS → browser directly. One call
 * signs the whole selection (keeps the dedicated bulk-download rate budget).
 */
export const SignedOriginalSchema = z.object({
  photoId: z.string(),
  url: z.string().url(),
  filename: z.string(),
});
export type SignedOriginal = z.infer<typeof SignedOriginalSchema>;

export const DownloadSignResponseSchema = z.object({
  ok: z.literal(true),
  files: z.array(SignedOriginalSchema),
});
export type DownloadSignResponse = z.infer<typeof DownloadSignResponseSchema>;

// ── Admin delete (POST /api/events/:id/photos/delete) ────────────────────────

/** Hard cap on photos per delete request — bounds the Drive/GCS/Firestore
 *  fan-out per call. Admins remove a handful of mistakes at a time. */
export const MAX_DELETE_PHOTOS = 200;

/** Body for the admin "remove these photos" action. */
export const DeletePhotosRequestSchema = z.object({
  photoIds: z.array(z.string().min(1)).min(1).max(MAX_DELETE_PHOTOS),
});
export type DeletePhotosRequest = z.infer<typeof DeletePhotosRequestSchema>;

export const DeletePhotosResponseSchema = z.object({
  ok: z.literal(true),
  eventId: z.string(),
  /** photoIds fully removed: Drive original trashed + index doc + derivatives. */
  deleted: z.array(z.string()),
  /** photoIds that could not be deleted, each with a short reason. */
  failed: z
    .array(z.object({ photoId: z.string(), reason: z.string() }))
    .default([]),
  /** Indexer execution name if a re-index was triggered to refresh Find Me,
   *  else null (nothing deleted, or the trigger failed — non-fatal). */
  reindex: z.string().nullable().default(null),
});
export type DeletePhotosResponse = z.infer<typeof DeletePhotosResponseSchema>;

// ── Searcher name (required at search time; FR — guest identification) ────────

/** Max length for the searcher/guest display name captured at search time. */
export const SEARCHER_NAME_MAX = 120;

/**
 * Searcher name validator: trimmed, non-empty, length-bounded. Find Me is open
 * to anonymous guests, who have no account email — so every search must carry a
 * name we can put in the admin alert. Required for members too (captured once in
 * the consent step), so the alert is always attributable.
 */
export const SearcherNameSchema = z
  .string()
  .trim()
  .min(1, 'Please enter your name')
  .max(SEARCHER_NAME_MAX, `Name must be ${SEARCHER_NAME_MAX} characters or fewer`);

// ── Search (POST /api/findme/search, multipart) ──────────────────────────────

export const MatchResultSchema = z.object({
  photoId: z.string(),
  /** Fused score (or single-signal score in face/person mode). */
  score: z.number(),
  faceScore: z.number().nullable(),
  personScore: z.number().nullable(),
  thumbUrl: z.string(),
  webUrl: z.string(),
});
export type MatchResult = z.infer<typeof MatchResultSchema>;

export const SearchResponseSchema = z.object({
  ok: z.literal(true),
  eventId: z.string(),
  mode: z.enum(['fused', 'face', 'person']),
  modelVersion: z.string().optional(),
  /** ID of the persisted match_runs doc (feeds the M4 feedback loop). */
  runId: z.string().optional(),
  results: z.array(MatchResultSchema),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/** 422 from the matcher when the reference photo has no usable face. */
export const NoUsableFaceResponseSchema = z.object({
  ok: z.literal(false),
  error: z.literal('no_usable_face'),
  message: z.string(),
});
export type NoUsableFaceResponse = z.infer<typeof NoUsableFaceResponseSchema>;

// ── Reference reuse (D7 / FR-10b) ────────────────────────────────────────────

/** A past reference selfie the signed-in user can reuse to search a new event. */
export const ReferenceUploadSchema = z.object({
  uploadId: z.string(),
  /** Signed, short-lived URL to display the selfie in the picker. */
  url: z.string(),
  mode: z.enum(['fused', 'person']),
  createdAt: z.string(),
  /** ISO timestamp after which the reference auto-expires (My Data / M3.4). */
  expiresAt: z.string(),
});
export type ReferenceUpload = z.infer<typeof ReferenceUploadSchema>;

/** Response for DELETE /api/findme/uploads/:uploadId (My Data delete, M3.4). */
export const DeleteReferenceResponseSchema = z.object({
  ok: z.literal(true),
  uploadId: z.string(),
});
export type DeleteReferenceResponse = z.infer<typeof DeleteReferenceResponseSchema>;

/** Response for DELETE /api/findme/me/data — full erase / consent revoke (M5.2). */
export const DeleteMyDataResponseSchema = z.object({
  ok: z.literal(true),
  deleted: z.object({
    references: z.number(),
    consents: z.number(),
    matchRuns: z.number(),
    feedback: z.number(),
  }),
});
export type DeleteMyDataResponse = z.infer<typeof DeleteMyDataResponseSchema>;

export const ListReferencesResponseSchema = z.object({
  ok: z.literal(true),
  uploads: z.array(ReferenceUploadSchema),
});
export type ListReferencesResponse = z.infer<typeof ListReferencesResponseSchema>;

/** Body for POST /api/findme/uploads/:uploadId/search — reuse a stored selfie
 *  against `eventId`. The minor/guardian + consent gating still applies per
 *  search (the gate runs again server-side). */
export const SearchByUploadRequestSchema = z.object({
  eventId: z.string().min(1),
  /** Required: who is running the search (feeds the admin alert). */
  name: SearcherNameSchema,
  mode: z.enum(['fused', 'person']).optional(),
  subjectIsMinor: z.boolean().optional(),
  guardianAttested: z.boolean().optional(),
});
export type SearchByUploadRequest = z.infer<typeof SearchByUploadRequestSchema>;

// ── Admin: Find Me reference inspection + repro (admin-only, audited) ─────────

/**
 * One stored reference selfie as seen by an admin (cross-user). Unlike the
 * member-facing `ReferenceUpload`, this exposes the owner (uid/email), the
 * searcher-provided name, and the recorded `outcome` so support can find the
 * exact selfie behind a reported issue — including failed searches we now keep
 * for reproduction.
 */
export const AdminReferenceSchema = z.object({
  uploadId: z.string(),
  uid: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  eventId: z.string(),
  /** Match mode that succeeded, or null for a failed/no-face search. */
  mode: z.enum(['fused', 'person']).nullable(),
  /** 'matched' or the matcher error code reproduced (e.g. 'no_usable_face'). */
  outcome: z.string(),
  subjectIsMinor: z.boolean(),
  createdAt: z.string(),
  expiresAt: z.string(),
  /** Short-lived signed URL to view/download the selfie (issuance is audited). */
  imageUrl: z.string(),
});
export type AdminReference = z.infer<typeof AdminReferenceSchema>;

export const AdminReferenceListResponseSchema = z.object({
  ok: z.literal(true),
  total: z.number(),
  references: z.array(AdminReferenceSchema),
});
export type AdminReferenceListResponse = z.infer<typeof AdminReferenceListResponseSchema>;

/** Body for POST /api/admin/findme/uploads/:uploadId/reproduce. */
export const AdminReproduceRequestSchema = z.object({
  /** Event to run against; defaults to the reference's original event. */
  eventId: z.string().min(1).optional(),
  mode: z.enum(['fused', 'face', 'person']).optional(),
});
export type AdminReproduceRequest = z.infer<typeof AdminReproduceRequestSchema>;

/**
 * Diagnostic result of an admin repro run. Mirrors the raw matcher outcome
 * (success OR the reproduced error code) and writes NOTHING to consents /
 * match_runs and does not persist a new reference — it only re-runs the stored
 * selfie so support can see what a user hit.
 */
export const AdminReproduceResponseSchema = z.object({
  ok: z.literal(true),
  uploadId: z.string(),
  eventId: z.string(),
  /** 'matched' or the matcher error code (e.g. 'no_usable_face'). */
  outcome: z.string(),
  /** Upstream HTTP status from the matcher (200 on match). */
  status: z.number(),
  message: z.string().optional(),
  mode: z.enum(['fused', 'face', 'person']).nullable(),
  modelVersion: z.string().nullable(),
  resultCount: z.number(),
  /** Top results (photoId + score + signed thumb) when matched. */
  results: z.array(
    z.object({
      photoId: z.string(),
      score: z.number(),
      thumbUrl: z.string(),
    }),
  ),
});
export type AdminReproduceResponse = z.infer<typeof AdminReproduceResponseSchema>;
