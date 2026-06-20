import { z } from 'zod';

/**
 * Volunteer resumable-upload contracts.
 *
 * Flow (GCS-first, then server-side copy to Drive — see UPLOAD_RESUMABLE_NOTES):
 *   1. POST /api/volunteer/upload/session   → server validates the public
 *      upload-link token, resolves the event, and *initiates a GCS resumable
 *      upload session* in the staging bucket. The browser gets back only an
 *      opaque, single-object `sessionUri` (no broad credential).
 *   2. The browser PUTs the bytes to `sessionUri` in chunks. A dropped
 *      connection or a closed/reopened tab resumes from the last committed
 *      byte (the session URI + offset are persisted in IndexedDB) instead of
 *      restarting the whole batch.
 *   3. POST /api/volunteer/upload/complete  → server records a receipt and
 *      enqueues the staging→Drive copy + index step.
 *
 * This package has zero runtime deps beyond Zod; keep it framework-free.
 */

/** Media types a volunteer is allowed to upload. Mirrors the gas-app
 *  ACCEPTED_TYPES list so both front doors agree on what counts as a photo. */
export const ACCEPTED_UPLOAD_MIME = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
] as const;

/** Hard cap on a single file (bytes). Bounds a runaway phone video; tune via
 *  the route if a legitimate use needs more. 1 GiB is generous for photos. */
export const MAX_UPLOAD_FILE_BYTES = 1024 * 1024 * 1024;

// ── 1. Initiate a resumable session ──────────────────────────────────────────

export const CreateUploadSessionRequestSchema = z.object({
  /** Public upload-link token from the volunteer's URL (`/upload/:token`). */
  token: z.string().min(1),
  /** Original filename as picked on the device (used for the credited name). */
  fileName: z.string().min(1).max(255),
  /** Browser-reported MIME, possibly empty on mobile — server re-infers. */
  mimeType: z.string().default(''),
  /** File size in bytes; lets the server reject oversize files up front. */
  size: z.number().int().nonnegative().max(MAX_UPLOAD_FILE_BYTES),
});
export type CreateUploadSessionRequest = z.infer<typeof CreateUploadSessionRequestSchema>;

export const CreateUploadSessionResponseSchema = z.object({
  ok: z.literal(true),
  /** Stable id for this file within the batch (also the staging object stem). */
  uploadId: z.string(),
  /** GCS resumable session URI. Opaque; the browser PUTs chunks here. */
  sessionUri: z.string().url(),
  /** Staging object name the bytes land at (`<prefix>/<uploadId>.<ext>`). */
  objectName: z.string(),
  /** Echoed batch id so the client groups a session's files in one receipt. */
  batchId: z.string(),
});
export type CreateUploadSessionResponse = z.infer<typeof CreateUploadSessionResponseSchema>;

// ── 2. Finalize the batch ────────────────────────────────────────────────────

export const CompleteUploadItemSchema = z.object({
  uploadId: z.string().min(1),
  objectName: z.string().min(1),
  fileName: z.string().min(1),
  /** Bytes the client actually committed (for the receipt + audit). */
  bytes: z.number().int().nonnegative(),
});
export type CompleteUploadItem = z.infer<typeof CompleteUploadItemSchema>;

export const CompleteUploadRequestSchema = z.object({
  token: z.string().min(1),
  batchId: z.string().min(1),
  items: z.array(CompleteUploadItemSchema).min(1),
});
export type CompleteUploadRequest = z.infer<typeof CompleteUploadRequestSchema>;

export const CompleteUploadResponseSchema = z.object({
  ok: z.literal(true),
  batchId: z.string(),
  /** How many staged objects were accepted for the Drive copy + index step. */
  accepted: z.number().int().nonnegative(),
  /** Human-readable confirmation for the receipt screen. */
  message: z.string(),
});
export type CompleteUploadResponse = z.infer<typeof CompleteUploadResponseSchema>;
