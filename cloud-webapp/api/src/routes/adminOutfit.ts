/**
 * adminOutfit.ts — the "find this outfit" tool, backed by the outfit-tagger.
 *
 *   GET  /api/admin/outfit/:eventId/status  — is the event prepared, and with what?
 *   POST /api/admin/outfit/:eventId/detect  — samples and/or a description → ranked photos
 *
 * This is a THIN PROXY over the private outfit-tagger service, plus signed
 * thumbnail URLs so the caller can actually look at the hits. It adds no
 * matching logic of its own, and it touches nothing Find-Me depends on: the
 * outfit-tagger is a separate Cloud Run deployment reading its own vector store
 * under `<eventId>/outfit/`. With `OUTFIT_URL` unset both routes 503 with a clear
 * message, which is the state of the world until the service is deployed.
 *
 * Auth: `requireSuperAdmin`, not `requireAnyAdmin`. An event holds every club's
 * photos, so an event-wide query is cross-club by nature — the same reasoning
 * that makes event deletion super-admin-only. Confining a club_admin would mean
 * resolving each hit's club before returning it; until that exists, the narrow
 * gate is the honest one rather than a scope check that half works.
 *
 * Scores are z-scores against the event cohort, not cosines, and no threshold is
 * applied by default (see outfit-tagger/scoring.py). This shortlists photos for a
 * human to review; it must not be treated as an identity match.
 */

import { Router } from 'express';
import multer from 'multer';

import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { attachRole, requireSuperAdmin } from '../middleware/rbac.js';
import { recordAudit } from '../services/auditStore.js';
import { signThumbUrls } from '../services/gcsService.js';
import { outfitDetect, outfitStatus, type OutfitSampleImage } from '../services/outfitClient.js';
import { actor, handleStoreError, masterSheetId } from './adminShared.js';

export const adminOutfitRouter = Router();

/** Max sample images per query. A few-shot prototype stops improving well before
 *  this, and each sample is a full encoder pass on the service. */
const MAX_SAMPLES = 8;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: MAX_SAMPLES },
});

const DEFAULT_TOP_K = 100;
const MAX_TOP_K = 500;

/** Parse a comma/whitespace separated id list, trimmed and de-duplicated. */
function idList(raw: unknown, cap: number): string[] {
  if (typeof raw !== 'string') return [];
  return [...new Set(raw.split(/[,\s]+/).filter(Boolean))].slice(0, cap);
}

function num(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The matched `:eventId`. Express always supplies it for these routes, but the
 *  param map is typed as possibly-undefined, so normalize once here rather than
 *  asserting at each use. */
function eventIdOf(req: { params: Record<string, string | undefined> }): string {
  return (req.params.eventId ?? '').trim();
}

/** GET /api/admin/outfit/:eventId/status — preparation state for an event. */
adminOutfitRouter.get(
  '/admin/outfit/:eventId/status',
  requireAuth,
  attachRole,
  requireSuperAdmin,
  async (req, res, next) => {
    try {
      const result = await outfitStatus(eventIdOf(req));
      if (!result.ok) {
        res.status(result.status).json({ error: result.error, message: result.message });
        return;
      }
      res.json(result);
    } catch (err) {
      if (handleStoreError(err, res)) return;
      next(err);
    }
  },
);

/**
 * POST /api/admin/outfit/:eventId/detect — rank the event's crops.
 *
 * multipart/form-data: `file` (0..8 sample images), plus fields `text`,
 * `textWeight`, `samplePhotoIds`, `region` (person|head|auto), `topK`,
 * `minScore`, `includeSmall`.
 *
 * Read-only, but audited: it is a bulk query across every club's photos in the
 * event, so who ran what is worth recording — the same rationale as the other
 * privileged cross-club tools.
 */
adminOutfitRouter.post(
  '/admin/outfit/:eventId/detect',
  requireAuth,
  attachRole,
  requireSuperAdmin,
  upload.array('file', MAX_SAMPLES),
  async (req, res, next) => {
    try {
      const eventId = eventIdOf(req);
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const samples: OutfitSampleImage[] = files.map((f) => ({
        image: f.buffer,
        filename: f.originalname || 'sample.jpg',
        contentType: f.mimetype || 'application/octet-stream',
      }));

      const region = String(req.body?.region ?? 'auto');
      if (!['auto', 'person', 'head'].includes(region)) {
        res.status(400).json({ error: 'bad_region', message: 'region must be auto|person|head' });
        return;
      }
      const topKRaw = num(req.body?.topK) ?? DEFAULT_TOP_K;
      const topK = Math.min(Math.max(Math.trunc(topKRaw), 1), MAX_TOP_K);
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

      const result = await outfitDetect({
        eventId,
        samples,
        samplePhotoIds: idList(req.body?.samplePhotoIds, MAX_SAMPLES),
        ...(text ? { text } : {}),
        ...(num(req.body?.textWeight) !== undefined ? { textWeight: num(req.body?.textWeight)! } : {}),
        region: region as 'auto' | 'person' | 'head',
        topK,
        ...(num(req.body?.minScore) !== undefined ? { minScore: num(req.body?.minScore)! } : {}),
        includeSmall: String(req.body?.includeSmall ?? '') === 'true',
      });

      if (!result.ok) {
        res.status(result.status).json({ error: result.error, message: result.message });
        return;
      }

      // Thumbnails only: this is a review grid, and signing the `web` copy too
      // would double the V4 signing round-trips for a URL most hits never need
      // (same reasoning as the gallery's signThumbUrls).
      const thumbs = await signThumbUrls(
        eventId,
        result.results.map((r) => r.photoId),
      );
      const thumbById = new Map(thumbs.map((t) => [t.photoId, t.thumbUrl]));

      const sheetId = masterSheetId(res);
      if (sheetId) {
        await recordAudit(sheetId, {
          actorEmail: actor(req),
          action: 'outfit_detect',
          resourceType: 'event',
          resourceId: eventId,
          details: {
            region,
            topK,
            sampleCount: result.sampleCount,
            samplePhotoIds: result.samplePhotoIds,
            textLength: text.length,
            hits: result.results.length,
          },
          ip: req.ip ?? '',
        });
      }

      logger.info(
        {
          eventId,
          actor: actor(req),
          region,
          samples: result.sampleCount,
          hasText: Boolean(text),
          hits: result.results.length,
          cohortSize: result.cohortSize,
        },
        'outfit detect',
      );

      res.json({
        ...result,
        results: result.results.map((r) => ({ ...r, thumbUrl: thumbById.get(r.photoId) ?? null })),
      });
    } catch (err) {
      if (handleStoreError(err, res)) return;
      next(err);
    }
  },
);
