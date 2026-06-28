/**
 * feedback.ts — POST /api/feedback (dev plan §5A B7 / FR-15).
 *
 * A signed-in user marks a Find Me result as "not_me" (wrong match) or
 * "confirmed" (that's me). We persist one immutable `match_feedback` doc per
 * vote, keyed to the search run, so the eval feedback loop
 * (EVAL_FEEDBACK_LOOP.md) can compute judged precision per model version.
 *
 * The UI removes "not me" results optimistically; this endpoint only records —
 * it never deletes photos or vectors.
 */

import { Router } from 'express';
import {
  FeedbackRequestSchema,
  FeedbackVerdictSchema,
  type FeedbackResponse,
  type FeedbackItem,
  type FeedbackVerdict,
  type AdminFeedbackResponse,
} from '@cloud-webapp/shared';
import type { Query, DocumentData } from '@google-cloud/firestore';

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { attachRole, requireAnyAdmin } from '../middleware/rbac.js';

export const feedbackRouter = Router();

const ADMIN_FEEDBACK_MAX = 500;
const ADMIN_FEEDBACK_DEFAULT = 100;

feedbackRouter.post('/feedback', requireAuth, async (req, res, next) => {
  try {
    const parsed = FeedbackRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'eventId, photoId and verdict are required',
      });
      return;
    }
    const { eventId, photoId, verdict, runId } = parsed.data;
    const user = req.user!;

    const ref = await firestore().collection('match_feedback').add({
      uid: user.uid,
      email: user.email ?? null,
      eventId,
      photoId,
      verdict,
      runId: runId ?? null,
      createdAt: new Date().toISOString(),
    });

    logger.info({ eventId, photoId, verdict, runId, uid: user.uid }, 'match feedback recorded');
    const body: FeedbackResponse = { ok: true, feedbackId: ref.id };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/feedback — admin review queue (dev plan M4.4 / FR-16/FR-17).
 *
 * Returns the most recent feedback votes, newest first, optionally filtered by
 * `eventId` and `verdict`. We order by `createdAt` (single-field index, no
 * composite index needed) and apply the filters in memory over the fetched
 * window, so `counts`/`total` describe the returned page. Bump `limit` (≤500)
 * if an admin needs to look further back.
 */
feedbackRouter.get('/admin/feedback', requireAuth, attachRole, requireAnyAdmin, async (req, res, next) => {
  try {
    const eventId = typeof req.query.eventId === 'string' && req.query.eventId ? req.query.eventId : undefined;
    const verdictParsed = FeedbackVerdictSchema.safeParse(req.query.verdict);
    const verdict: FeedbackVerdict | undefined = verdictParsed.success ? verdictParsed.data : undefined;
    const limitRaw = Number.parseInt(String(req.query.limit ?? ADMIN_FEEDBACK_DEFAULT), 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : ADMIN_FEEDBACK_DEFAULT, 1), ADMIN_FEEDBACK_MAX);

    const query: Query<DocumentData> = firestore()
      .collection('match_feedback')
      .orderBy('createdAt', 'desc')
      .limit(limit);
    const snap = await query.get();

    let items: FeedbackItem[] = snap.docs.map((d) => {
      const data = d.data();
      return {
        feedbackId: d.id,
        eventId: String(data.eventId ?? ''),
        photoId: String(data.photoId ?? ''),
        verdict: data.verdict as FeedbackVerdict,
        runId: (data.runId as string | null) ?? null,
        uid: String(data.uid ?? ''),
        email: (data.email as string | null) ?? null,
        createdAt: String(data.createdAt ?? ''),
      };
    });
    if (eventId) items = items.filter((i) => i.eventId === eventId);
    if (verdict) items = items.filter((i) => i.verdict === verdict);

    const counts = {
      not_me: items.filter((i) => i.verdict === 'not_me').length,
      confirmed: items.filter((i) => i.verdict === 'confirmed').length,
    };
    const body: AdminFeedbackResponse = { ok: true, total: items.length, counts, items };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
