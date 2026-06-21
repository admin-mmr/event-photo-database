/**
 * volunteerUpload.ts — public, link-token-gated resumable upload endpoints.
 *
 *   POST /api/volunteer/upload/session   initiate a GCS resumable session
 *   POST /api/volunteer/upload/complete  finalize a batch (→ Drive copy + index)
 *
 * No Firebase auth: volunteers reach this via a shared `/upload/:token` link,
 * exactly like the gas-app flow. The token is validated against the master
 * Sheet's Upload_Links tab on every call (see volunteerUploadService).
 *
 * Abuse protection on /session (UPLOAD_RESUMABLE_NOTES): a per-link-token rate
 * limit (volunteerUploadRateLimit) + reCAPTCHA Enterprise (the same gate findme
 * uses) so a leaked link can't be used to fill the staging bucket. Both no-op
 * when unconfigured (reCAPTCHA) or in tests / when the limit is 0, so dev and
 * the demo keep working without keys.
 */

import { Router } from 'express';
import {
  CreateUploadSessionRequestSchema,
  CompleteUploadRequestSchema,
  ACCEPTED_UPLOAD_MIME,
  type CreateUploadSessionResponse,
  type CompleteUploadResponse,
} from '@cloud-webapp/shared';

import { logger } from '../lib/logger.js';
import { volunteerUploadRateLimit } from '../middleware/rateLimit.js';
import { requireRecaptcha } from '../middleware/recaptcha.js';
import {
  validateUploadLink,
  createResumableSession,
  enqueueStagedBatch,
  UploadLinkError,
} from '../services/volunteerUploadService.js';

export const volunteerUploadRouter = Router();

const ACCEPTED = new Set<string>(ACCEPTED_UPLOAD_MIME);

/** Map an UploadLinkError code to an HTTP status (existence not leaked). */
function linkErrorStatus(code: UploadLinkError['code']): number {
  switch (code) {
    case 'not_configured':
      return 503;
    case 'revoked':
      return 410;
    default:
      return 404; // invalid_token — 404 so a guessed token isn't confirmed
  }
}

/**
 * POST /api/volunteer/upload/session
 * Body: { token, fileName, mimeType, size, batchId? }
 * Returns a GCS resumable session URI the browser PUTs chunks to.
 *
 * `batchId` is optional: the client mints one per upload session and reuses it
 * for every file so they group into one receipt. We accept it from the body
 * (falling back to a fresh one) rather than minting per file.
 */
volunteerUploadRouter.post(
  '/volunteer/upload/session',
  volunteerUploadRateLimit(),
  requireRecaptcha('volunteer_upload'),
  async (req, res, next) => {
  try {
    const parsed = CreateUploadSessionRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'bad_request', message: parsed.error.message });
      return;
    }
    const { token, fileName, mimeType, size, photographerName } = parsed.data;
    const batchId = String((req.body as { batchId?: unknown })?.batchId ?? '').trim();
    if (!batchId) {
      res.status(400).json({ ok: false, error: 'missing_batch_id', message: 'batchId is required' });
      return;
    }

    // Re-infer the type from the extension when the browser sent none (common
    // on mobile for .jpeg/.heic), then enforce the accepted-media allowlist.
    const effectiveMime = mimeType || mimeFromExtension(fileName) || '';
    if (effectiveMime && !ACCEPTED.has(effectiveMime)) {
      res.status(415).json({
        ok: false,
        error: 'unsupported_type',
        message: `Unsupported file type: ${effectiveMime}`,
      });
      return;
    }

    const link = await validateUploadLink(token);
    const session = await createResumableSession(link, batchId, fileName, effectiveMime, photographerName);

    logger.info(
      { eventId: link.eventId, batchId, uploadId: session.uploadId, size },
      'volunteer resumable session created',
    );

    const body: CreateUploadSessionResponse = {
      ok: true,
      uploadId: session.uploadId,
      sessionUri: session.sessionUri,
      objectName: session.objectName,
      batchId,
    };
    res.json(body);
  } catch (err) {
    if (err instanceof UploadLinkError) {
      res.status(linkErrorStatus(err.code)).json({ ok: false, error: err.code, message: err.message });
      return;
    }
    next(err);
  }
  },
);

/**
 * POST /api/volunteer/upload/complete
 * Body: { token, batchId, items: [{ uploadId, objectName, fileName, bytes }] }
 * Records the batch and hands it to the Drive-copy + index step.
 */
volunteerUploadRouter.post('/volunteer/upload/complete', async (req, res, next) => {
  try {
    const parsed = CompleteUploadRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'bad_request', message: parsed.error.message });
      return;
    }
    const { token, batchId, items } = parsed.data;

    const link = await validateUploadLink(token);
    const { copied, skippedDuplicates, skippedDuplicateNames } = await enqueueStagedBatch(
      link,
      batchId,
      items.map((i) => i.objectName),
    );

    const where = link.eventName || link.eventId;
    const dupNote =
      skippedDuplicates > 0
        ? ` (${skippedDuplicates} duplicate${skippedDuplicates === 1 ? '' : 's'} skipped)`
        : '';
    const body: CompleteUploadResponse = {
      ok: true,
      batchId,
      accepted: copied,
      skippedDuplicates,
      skippedDuplicateNames,
      message: `Received ${copied} file${copied === 1 ? '' : 's'} for "${where}"${dupNote}.`,
    };
    res.json(body);
  } catch (err) {
    if (err instanceof UploadLinkError) {
      res.status(linkErrorStatus(err.code)).json({ ok: false, error: err.code, message: err.message });
      return;
    }
    next(err);
  }
});

/** Infer MIME from extension when the browser supplies none. Mirrors the
 *  gas-app helper so both upload paths agree. */
function mimeFromExtension(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    heic: 'image/heic',
    heif: 'image/heif',
    webp: 'image/webp',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
  };
  return map[ext] ?? null;
}
