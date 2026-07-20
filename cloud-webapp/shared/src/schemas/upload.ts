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

/** Hard cap on a single file (bytes). 10 GiB admits long event videos; the
 *  session route applies the tighter MAX_IMAGE_UPLOAD_FILE_BYTES to images
 *  once it has inferred the MIME type (the browser-reported one here can be
 *  empty on mobile, so the schema can only enforce the absolute ceiling). */
export const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024 * 1024;

/** Tighter per-image cap (bytes). 1 GiB is generous for photos; only videos
 *  legitimately need more. Enforced in the session route, not the schema. */
export const MAX_IMAGE_UPLOAD_FILE_BYTES = 1024 * 1024 * 1024;

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
  /**
   * Photographer's name for the on-file credit line (optional). Stamped onto
   * the staging object so the server-side Drive copy can rename the file to
   * `<Club>_<Photographer>_<original>` (see the gas-app credited-filename flow).
   * Blank → the prefix is just `<Club>_`. The volunteer types it once per
   * session and the client reuses it for every file.
   */
  photographerName: z.string().max(120).default(''),
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

/** Body of the internal worker endpoint (POST /api/internal/process-batch) that
 *  copies a staged batch to Drive. In step 3 this is the Cloud Tasks payload;
 *  for now it's the seam the worker shares with /complete. */
export const ProcessBatchRequestSchema = z.object({
  token: z.string().min(1),
  batchId: z.string().min(1),
  objectNames: z.array(z.string().min(1)).min(1),
});
export type ProcessBatchRequest = z.infer<typeof ProcessBatchRequestSchema>;

export const CompleteUploadResponseSchema = z.object({
  ok: z.literal(true),
  batchId: z.string(),
  /** How many staged objects were copied into Drive (new, non-duplicate). */
  accepted: z.number().int().nonnegative(),
  /** How many staged objects were skipped as duplicates of a file already in
   *  the event's Drive folder (matched on credited name + byte size). */
  skippedDuplicates: z.number().int().nonnegative().default(0),
  /** The credited filenames skipped as duplicates, so the UI can name them.
   *  Same length as `skippedDuplicates`. */
  skippedDuplicateNames: z.array(z.string()).default([]),
  /** Human-readable confirmation for the receipt screen. */
  message: z.string(),
});
export type CompleteUploadResponse = z.infer<typeof CompleteUploadResponseSchema>;

/** Lifecycle of a volunteer upload batch after the bytes are in cloud storage:
 *  saving (copying to Drive) → indexing (indexer triggered) → done/ready, or error. */
export const UploadBatchPhaseSchema = z.enum([
  'received',
  'saving',
  'indexing',
  'done',
  'ready',
  'error',
]);
export type UploadBatchPhase = z.infer<typeof UploadBatchPhaseSchema>;

/** GET /api/volunteer/upload/status/:batchId — observable batch status so the
 *  page can show "saving → indexing → in gallery" without blocking the upload. */
export const UploadBatchStatusResponseSchema = z.object({
  ok: z.literal(true),
  batchId: z.string(),
  eventId: z.string(),
  phase: UploadBatchPhaseSchema,
  total: z.number().int().nonnegative(),
  copied: z.number().int().nonnegative(),
  skippedDuplicates: z.number().int().nonnegative(),
  skippedDuplicateNames: z.array(z.string()),
  failed: z.number().int().nonnegative(),
  batchFolderName: z.string(),
  updatedAt: z.string(),
});
export type UploadBatchStatusResponse = z.infer<typeof UploadBatchStatusResponseSchema>;
