/**
 * findme.ts — Find Me search + reference reuse.
 *
 *  POST /api/findme/search                    multipart: fresh selfie upload
 *  GET  /api/findme/uploads                   the user's past reference selfies
 *  POST /api/findme/uploads/:uploadId/search  reuse a stored selfie (D7/FR-10b)
 *
 * Fresh uploads are persisted to the uploads bucket + a `find_me_uploads`
 * record (with a 90/30-day expiry per PRD §8.4) so a signed-in member can reuse
 * a past photo against a new event without re-uploading. Listing is scoped to
 * the owner (self-service only, PRD §8.1).
 *
 * Each search records a `consents` doc (policy version + minor/guardian flags)
 * before any biometric processing, and a minimal `match_runs` doc afterwards so
 * the M4 feedback loop has run IDs to attach feedback to.
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import type { Response } from 'express';
import {
  SearchByUploadRequestSchema,
  type SearchResponse,
  type MatchResult,
  type ListReferencesResponse,
  type ReferenceUpload,
} from '@cloud-webapp/shared';

import { env } from '../lib/config.js';
import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import type { AuthedUser } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { findmeSearchRateLimit } from '../middleware/rateLimit.js';
import { requireRecaptcha } from '../middleware/recaptcha.js';
import { matcherSearch } from '../services/matcherClient.js';
import {
  signPhotoUrls,
  uploadReference,
  readReference,
  signReferenceUrl,
} from '../services/gcsService.js';
import {
  createReference,
  getReference,
  listReferencesForUser,
} from '../services/references.js';

export const findmeRouter = Router();

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

interface RunSearchOpts {
  user: AuthedUser;
  eventId: string;
  image: Buffer;
  contentType: string;
  filename: string;
  mode: 'fused' | 'person';
  subjectIsMinor: boolean;
  guardianAttested: boolean;
  /** Store the reference for future reuse (fresh uploads only). */
  persistReference: boolean;
}

/**
 * Shared search core for both the fresh-upload and reuse routes. Enforces the
 * minor/guardian gate, records consent, calls the matcher, (optionally) persists
 * the reference for reuse, writes a run record, and responds with signed URLs.
 * Writes the HTTP response directly; throws only on unexpected errors (the
 * caller's try/catch forwards those to the error handler).
 */
async function runSearch(res: Response, opts: RunSearchOpts): Promise<void> {
  const { user, eventId, image, contentType, filename, mode, subjectIsMinor, guardianAttested } = opts;

  // Minor-subject gate (PRD §8.3 / D8): a search for a minor must be performed
  // by a guardian who attests authority to consent. (Final consent wording is
  // pending legal review — M5.6 — but the mechanism is enforced here.)
  if (subjectIsMinor && !guardianAttested) {
    res.status(403).json({
      ok: false,
      error: 'guardian_required',
      message:
        'Searching for a child requires a parent or guardian to confirm they consent on the child’s behalf.',
    });
    return;
  }

  const eventDoc = await firestore().collection('events').doc(eventId).get();
  if (!eventDoc.exists) {
    res.status(404).json({ ok: false, error: 'not_found', message: `Unknown event '${eventId}'` });
    return;
  }

  // Record consent before any biometric processing (PRD §8.1).
  const now = new Date();
  const nowIso = now.toISOString();
  await firestore().collection('consents').add({
    uid: user.uid,
    email: user.email ?? null,
    eventId,
    policyVersion: env.CONSENT_POLICY_VERSION,
    action: 'findme_search',
    subjectIsMinor,
    guardianAttested,
    createdAt: nowIso,
  });

  const match = await matcherSearch({ image, filename, contentType, eventId, topK: 50, mode });

  if (!match.ok) {
    if (match.error === 'no_usable_face') {
      res.status(422).json({
        ok: false,
        error: 'no_usable_face',
        message: 'No clear face found in the photo — try a sharper, front-facing picture',
      });
      return;
    }
    if (match.error === 'event_not_indexed') {
      const indexState = eventDoc.data()?.indexState as { status?: string } | undefined;
      const inProgress = indexState?.status === 'queued' || indexState?.status === 'running';
      res.status(409).json({
        ok: false,
        error: 'event_not_indexed',
        status: indexState?.status ?? 'pending',
        retryable: true,
        message: inProgress
          ? "We're still gathering this event's photos — check back in a few minutes and your matches will appear automatically."
          : "This event's photos are being prepared for search. New photos are added automatically as they're uploaded — please check back shortly.",
      });
      return;
    }
    logger.error({ eventId, error: match.error, status: match.status }, 'matcher search failed');
    res.status(502).json({ ok: false, error: match.error, message: match.message });
    return;
  }

  const storedMode: 'fused' | 'person' = match.mode === 'person' ? 'person' : 'fused';

  // Persist the reference for reuse (best-effort, non-fatal — PRD D7/§6.1).
  if (opts.persistReference) {
    try {
      const uploadId = randomUUID();
      const gcsPath = await uploadReference(user.uid, uploadId, image, contentType);
      const days = subjectIsMinor
        ? env.REFERENCE_RETENTION_DAYS_MINOR
        : env.REFERENCE_RETENTION_DAYS_ADULT;
      const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
      await createReference({
        uploadId,
        uid: user.uid,
        eventId,
        gcsPath,
        contentType,
        mode: storedMode,
        subjectIsMinor,
        createdAt: nowIso,
        expiresAt,
      });
    } catch (err) {
      logger.warn({ err, uid: user.uid }, 'reference persist failed (non-fatal)');
    }
  }

  // Persist a minimal run record for the feedback loop (M4 / eval doc).
  let runId: string | undefined;
  try {
    const ref = await firestore().collection('match_runs').add({
      uid: user.uid,
      eventId,
      mode: match.mode,
      modelVersion: match.modelVersion ?? null,
      resultPhotoIds: match.results.map((r) => r.photoId),
      scores: Object.fromEntries(match.results.map((r) => [r.photoId, r.score])),
      createdAt: nowIso,
    });
    runId = ref.id;
  } catch (err) {
    logger.warn({ err, eventId }, 'match_runs write failed (non-fatal)');
  }

  const signed = await signPhotoUrls(eventId, match.results.map((r) => r.photoId));
  const urlsById = new Map(signed.map((s) => [s.photoId, s]));
  const results: MatchResult[] = match.results.map((r) => ({
    photoId: r.photoId,
    score: r.score,
    faceScore: r.faceScore,
    personScore: r.personScore,
    thumbUrl: urlsById.get(r.photoId)?.thumbUrl ?? '',
    webUrl: urlsById.get(r.photoId)?.webUrl ?? '',
  }));

  const body: SearchResponse = {
    ok: true,
    eventId,
    mode: match.mode,
    ...(match.modelVersion !== undefined ? { modelVersion: match.modelVersion } : {}),
    ...(runId !== undefined ? { runId } : {}),
    results,
  };
  res.json(body);
}

// ── Fresh upload search ──────────────────────────────────────────────────────

findmeRouter.post(
  '/findme/search',
  requireAuth,
  findmeSearchRateLimit(),
  requireRecaptcha('findme_search'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      const eventId = String(req.body?.eventId ?? '').trim();
      if (!eventId) {
        res.status(400).json({ ok: false, error: 'missing_event_id', message: 'eventId is required' });
        return;
      }
      if (!req.file) {
        res.status(400).json({ ok: false, error: 'missing_file', message: "multipart field 'file' required" });
        return;
      }
      if (!ALLOWED_MIMES.has(req.file.mimetype)) {
        res.status(415).json({
          ok: false,
          error: 'unsupported_format',
          message: `Unsupported image type '${req.file.mimetype}'`,
        });
        return;
      }
      if (req.body?.consent !== 'true') {
        res.status(403).json({
          ok: false,
          error: 'consent_required',
          message: 'Biometric search requires explicit consent',
        });
        return;
      }

      // Outfit-only fallback (FR-7): the client retries with mode=person when no
      // face was found. Only 'fused' (default) and 'person' are accepted.
      const mode = req.body?.mode === 'person' ? 'person' : 'fused';

      await runSearch(res, {
        user: req.user!,
        eventId,
        image: req.file.buffer,
        contentType: req.file.mimetype,
        filename: req.file.originalname || 'reference.jpg',
        mode,
        subjectIsMinor: req.body?.subjectIsMinor === 'true',
        guardianAttested: req.body?.guardianAttested === 'true',
        persistReference: true,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── Reference reuse (D7 / FR-10b) ─────────────────────────────────────────────

/** List the signed-in user's reusable past reference selfies. */
findmeRouter.get('/findme/uploads', requireAuth, async (req, res, next) => {
  try {
    const recs = await listReferencesForUser(req.user!.uid);
    const uploads: ReferenceUpload[] = await Promise.all(
      recs.map(async (r) => ({
        uploadId: r.uploadId,
        url: await signReferenceUrl(r.gcsPath),
        mode: r.mode,
        createdAt: r.createdAt,
      })),
    );
    const body: ListReferencesResponse = { ok: true, uploads };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/** Reuse a stored reference selfie to search a (possibly different) event. */
findmeRouter.post(
  '/findme/uploads/:uploadId/search',
  requireAuth,
  findmeSearchRateLimit(),
  async (req, res, next) => {
    try {
      const parsed = SearchByUploadRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: 'invalid_request',
          message: parsed.error.issues[0]?.message ?? 'eventId is required',
        });
        return;
      }
      const { eventId, mode, subjectIsMinor, guardianAttested } = parsed.data;

      const rec = await getReference(String(req.params.uploadId));
      // 404 (not 403) when it isn't the caller's, so we don't confirm existence
      // of another user's upload.
      if (!rec || rec.uid !== req.user!.uid) {
        res.status(404).json({ ok: false, error: 'not_found', message: 'Reference photo not found' });
        return;
      }

      let image: Buffer;
      try {
        image = await readReference(rec.gcsPath);
      } catch (err) {
        logger.warn({ err, uploadId: rec.uploadId }, 'stored reference unreadable (expired?)');
        res.status(410).json({
          ok: false,
          error: 'reference_gone',
          message: 'This saved photo is no longer available — please upload a new one.',
        });
        return;
      }

      await runSearch(res, {
        user: req.user!,
        eventId,
        image,
        contentType: rec.contentType,
        filename: `${rec.uploadId}.jpg`,
        mode: mode ?? 'fused',
        subjectIsMinor: subjectIsMinor ?? rec.subjectIsMinor,
        guardianAttested: guardianAttested ?? false,
        persistReference: false,
      });
    } catch (err) {
      next(err);
    }
  },
);
