/**
 * adminFindme.ts — admin-only, audited Find Me reference inspection + repro.
 *
 *   GET  /api/admin/findme/uploads                      list selfies (cross-user)
 *   GET  /api/admin/findme/uploads/:uploadId/image      302 → signed selfie URL
 *   POST /api/admin/findme/uploads/:uploadId/reproduce  re-run the stored selfie
 *
 * This is the ONLY path that exposes another user's reference selfie. Every
 * route is gated by requireAuth + requireAdmin and writes an `admin_audit`
 * record (+ log line) BEFORE returning, so privileged access is never silent.
 *
 * Reproduce is purely diagnostic: it re-runs the stored bytes through the
 * matcher and returns the raw outcome (including the error a user hit, e.g.
 * `no_usable_face`). It deliberately writes NOTHING to consents / match_runs and
 * does not persist a new reference — it must not pollute the user's data or the
 * eval feedback loop.
 */

import { Router } from 'express';
import {
  AdminReproduceRequestSchema,
  type AdminReference,
  type AdminReferenceListResponse,
  type AdminReproduceResponse,
} from '@cloud-webapp/shared';

import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { attachRole, requireAnyAdmin } from '../middleware/rbac.js';
import { matcherSearch } from '../services/matcherClient.js';
import { signPhotoUrls, signReferenceUrl, readReference } from '../services/gcsService.js';
import { getReference, listAllReferences, type AdminReferenceFilter } from '../services/references.js';
import { recordAdminAudit } from '../services/adminAudit.js';

export const adminFindmeRouter = Router();

const LIST_DEFAULT = 100;
const LIST_MAX = 500;

/** List stored reference selfies across users, newest first, with optional
 *  filters (?uid, ?email, ?eventId, ?outcome, ?limit). Each item includes a
 *  short-lived signed URL to view the selfie. */
adminFindmeRouter.get('/admin/findme/uploads', requireAuth, attachRole, requireAnyAdmin, async (req, res, next) => {
  try {
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() ? v.trim() : undefined;
    const limitRaw = Number.parseInt(String(req.query.limit ?? LIST_DEFAULT), 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : LIST_DEFAULT, 1), LIST_MAX);
    const uid = str(req.query.uid);
    const email = str(req.query.email);
    const eventId = str(req.query.eventId);
    const outcome = str(req.query.outcome);
    const filter: AdminReferenceFilter = {
      limit,
      ...(uid ? { uid } : {}),
      ...(email ? { email } : {}),
      ...(eventId ? { eventId } : {}),
      ...(outcome ? { outcome } : {}),
    };

    const recs = await listAllReferences(filter);
    const references: AdminReference[] = await Promise.all(
      recs.map(async (r) => ({
        uploadId: r.uploadId,
        uid: r.uid,
        email: r.email ?? null,
        name: r.name ?? null,
        eventId: r.eventId,
        mode: r.mode ?? null,
        outcome: r.outcome ?? 'matched',
        subjectIsMinor: r.subjectIsMinor,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        imageUrl: await signReferenceUrl(r.gcsPath),
      })),
    );

    await recordAdminAudit({
      adminUid: req.user!.uid,
      adminEmail: req.user!.email ?? null,
      action: 'findme_list',
      details: { filter, count: references.length },
    });

    const body: AdminReferenceListResponse = { ok: true, total: references.length, references };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/** 302-redirect to a signed URL for the selfie bytes (view / download). The
 *  redirect itself is the audited event — the signed URL is short-lived. */
adminFindmeRouter.get(
  '/admin/findme/uploads/:uploadId/image',
  requireAuth,
  attachRole,
  requireAnyAdmin,
  async (req, res, next) => {
    try {
      const uploadId = String(req.params.uploadId);
      const rec = await getReference(uploadId);
      if (!rec) {
        res.status(404).json({ ok: false, error: 'not_found', message: 'Reference photo not found' });
        return;
      }
      const url = await signReferenceUrl(rec.gcsPath);
      await recordAdminAudit({
        adminUid: req.user!.uid,
        adminEmail: req.user!.email ?? null,
        action: 'findme_view_selfie',
        uploadId,
        targetUid: rec.uid,
        eventId: rec.eventId,
      });
      res.redirect(302, url);
    } catch (err) {
      next(err);
    }
  },
);

/** Re-run a stored selfie through the matcher and return the raw outcome.
 *  Diagnostic only — no consent / match_run / reference writes. */
adminFindmeRouter.post(
  '/admin/findme/uploads/:uploadId/reproduce',
  requireAuth,
  attachRole,
  requireAnyAdmin,
  async (req, res, next) => {
    try {
      const parsed = AdminReproduceRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: 'invalid_request',
          message: parsed.error.issues[0]?.message ?? 'Invalid request',
        });
        return;
      }

      const uploadId = String(req.params.uploadId);
      const rec = await getReference(uploadId);
      if (!rec) {
        res.status(404).json({ ok: false, error: 'not_found', message: 'Reference photo not found' });
        return;
      }

      let image: Buffer;
      try {
        image = await readReference(rec.gcsPath);
      } catch (err) {
        logger.warn({ err, uploadId }, 'admin repro: stored reference unreadable (expired?)');
        res.status(410).json({
          ok: false,
          error: 'reference_gone',
          message: 'The stored selfie is no longer available (expired or deleted).',
        });
        return;
      }

      const eventId = parsed.data.eventId ?? rec.eventId;
      const mode = parsed.data.mode ?? rec.mode ?? 'fused';
      const match = await matcherSearch({
        image,
        filename: `${uploadId}.jpg`,
        contentType: rec.contentType,
        eventId,
        topK: 50,
        mode,
      });

      const outcome = match.ok ? 'matched' : match.error;
      let results: AdminReproduceResponse['results'] = [];
      if (match.ok && match.results.length > 0) {
        const signed = await signPhotoUrls(eventId, match.results.map((r) => r.photoId));
        const urlsById = new Map(signed.map((s) => [s.photoId, s.thumbUrl]));
        results = match.results.map((r) => ({
          photoId: r.photoId,
          score: r.score,
          thumbUrl: urlsById.get(r.photoId) ?? '',
        }));
      }

      await recordAdminAudit({
        adminUid: req.user!.uid,
        adminEmail: req.user!.email ?? null,
        action: 'findme_reproduce',
        uploadId,
        targetUid: rec.uid,
        eventId,
        details: { mode, outcome, resultCount: results.length },
      });

      const body: AdminReproduceResponse = {
        ok: true,
        uploadId,
        eventId,
        outcome,
        status: match.ok ? 200 : match.status,
        ...(match.ok ? {} : { message: match.message }),
        mode: match.ok ? match.mode : null,
        modelVersion: match.ok ? match.modelVersion ?? null : null,
        resultCount: results.length,
        results,
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);
