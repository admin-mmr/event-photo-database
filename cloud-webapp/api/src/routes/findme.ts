/**
 * findme.ts — POST /api/findme/search (M2.5, demo fast-path scope).
 *
 * Multipart form: file (reference selfie), eventId, consent ("true").
 *
 * Demo-scope simplifications vs the full plan (tracked in the dev plan):
 *  - Consent is a per-search checkbox; a consent record is persisted to the
 *    `consents` collection with the policy version, but the minor/guardian
 *    path, revocation, and the consentGate middleware land with M3/M5.
 *  - The reference upload is NOT yet mirrored to Drive (D6) — it lives only
 *    in memory for the request. Drive write lands with full M2 completion.
 *  - No rate limit / reCAPTCHA yet (M5.3).
 *
 * A minimal `match_runs` doc is persisted per search so the M4 feedback
 * loop (EVAL_FEEDBACK_LOOP.md) has run IDs to attach feedback to.
 */

import { Router } from 'express';
import multer from 'multer';
import type { SearchResponse, MatchResult } from '@cloud-webapp/shared';

import { env } from '../lib/config.js';
import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { matcherSearch } from '../services/matcherClient.js';
import { signPhotoUrls } from '../services/gcsService.js';

export const findmeRouter = Router();

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

findmeRouter.post('/findme/search', requireAuth, upload.single('file'), async (req, res, next) => {
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

    const eventDoc = await firestore().collection('events').doc(eventId).get();
    if (!eventDoc.exists) {
      res.status(404).json({ ok: false, error: 'not_found', message: `Unknown event '${eventId}'` });
      return;
    }

    // Record consent before any biometric processing (PRD §8.1).
    const user = req.user!;
    const now = new Date().toISOString();
    await firestore().collection('consents').add({
      uid: user.uid,
      email: user.email ?? null,
      eventId,
      policyVersion: env.CONSENT_POLICY_VERSION,
      action: 'findme_search',
      createdAt: now,
    });

    const match = await matcherSearch({
      image: req.file.buffer,
      filename: req.file.originalname || 'reference.jpg',
      contentType: req.file.mimetype,
      eventId,
      topK: 50,
    });

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
        res.status(409).json({
          ok: false,
          error: 'event_not_indexed',
          message: 'This event has not been indexed yet — ask an admin to run indexing',
        });
        return;
      }
      logger.error({ eventId, error: match.error, status: match.status }, 'matcher search failed');
      res.status(502).json({ ok: false, error: match.error, message: match.message });
      return;
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
        createdAt: now,
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
  } catch (err) {
    next(err);
  }
});
