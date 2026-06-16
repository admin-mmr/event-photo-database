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
import { FeedbackRequestSchema, type FeedbackResponse } from '@cloud-webapp/shared';

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';

export const feedbackRouter = Router();

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
