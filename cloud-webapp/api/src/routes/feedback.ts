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
  FeedbackBatchRequestSchema,
  FeedbackReasonSchema,
  FeedbackRequestSchema,
  FeedbackVerdictSchema,
  MatchTierSchema,
  SearchAlgoSchema,
  type FeedbackResponse,
  type FeedbackBatchResponse,
  type FeedbackItem,
  type FeedbackVerdict,
  type FeedbackReason,
  type AdminFeedbackResponse,
  type MatchTier,
  type SearchAlgo,
} from '@cloud-webapp/shared';
import type { Query } from '../lib/db/types.js';

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { attachRole, requireAnyAdmin } from '../middleware/rbac.js';

export const feedbackRouter = Router();

const ADMIN_FEEDBACK_MAX = 500;
const ADMIN_FEEDBACK_DEFAULT = 100;

interface RunContext {
  searchVersion: string | null;
  algo: SearchAlgo | null;
  /** Which band a photo was shown in for this run; null if in neither. */
  tierOf: (photoId: string) => MatchTier | null;
}

const NO_RUN: RunContext = { searchVersion: null, algo: null, tierOf: () => null };

/**
 * Resolve what a vote needs from its search run, so the label is
 * self-describing (the eval loop can filter by pipeline generation and band
 * without joining match_runs, and the snapshot survives run expiry/deletion):
 *  - the retrieval-algorithm snapshot, and
 *  - the TIER of each voted photo — derived here from the run's own lists rather
 *    than trusted from the client, so a "see more" vote can't be mislabelled as
 *    a default-band one (the two are scored separately when tuning a cutoff).
 * Best-effort: a missing runId, absent run, or unparseable `algo` yields nulls —
 * a vote must always record even if we can't attribute it.
 */
async function resolveRun(runId: string | undefined): Promise<RunContext> {
  if (!runId) return NO_RUN;
  try {
    const data = (await firestore().collection('match_runs').doc(runId).get()).data();
    if (!data) return NO_RUN;
    const parsed = SearchAlgoSchema.safeParse(data.algo);
    const shown = new Set(Array.isArray(data.resultPhotoIds) ? (data.resultPhotoIds as string[]) : []);
    const expanded = new Set(Array.isArray(data.expandedPhotoIds) ? (data.expandedPhotoIds as string[]) : []);
    return {
      searchVersion: parsed.success ? parsed.data.version : null,
      algo: parsed.success ? parsed.data : null,
      tierOf: (photoId) => (shown.has(photoId) ? 'default' : expanded.has(photoId) ? 'expanded' : null),
    };
  } catch (err) {
    logger.warn({ err, runId }, 'feedback run lookup failed (non-fatal)');
  }
  return NO_RUN;
}

/** A reason only means something on "that's me"; an omitted one is the UI's
 *  default, `me`. Stored explicitly so the label exporter and PRF never guess. */
function reasonFor(verdict: FeedbackVerdict, reason: FeedbackReason | undefined): FeedbackReason | null {
  return verdict === 'confirmed' ? (reason ?? 'me') : null;
}

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
    const { eventId, photoId, verdict, runId, reason } = parsed.data;
    const user = req.user!;

    // Stamp the vote with the algorithm generation that produced the result, so
    // the eval feedback loop can separate current-pipeline labels (§1.1–1.3)
    // from pre-improvement ones. Denormalized from the run at click time.
    const run = await resolveRun(runId);
    const { searchVersion, algo } = run;

    const ref = await firestore().collection('match_feedback').add({
      uid: user.uid,
      email: user.email ?? null,
      eventId,
      photoId,
      verdict,
      reason: reasonFor(verdict, reason),
      tier: run.tierOf(photoId),
      runId: runId ?? null,
      searchVersion,
      algo,
      createdAt: new Date().toISOString(),
    });

    logger.info(
      { eventId, photoId, verdict, runId, searchVersion, uid: user.uid },
      'match feedback recorded',
    );
    const body: FeedbackResponse = { ok: true, feedbackId: ref.id };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/feedback/batch — one verdict over several results ("all me").
 *
 * The UI offers this only for the results currently on screen, so the list is
 * bounded by the page size (MAX_FEEDBACK_BATCH). Each photoId still becomes its
 * own immutable `match_feedback` doc — identical to the clicks it replaces —
 * so nothing downstream has to know a batch happened.
 *
 * The saving is the round trips and, more importantly, the run lookup:
 * `resolveRun` runs ONCE for the whole batch instead of once per vote. The
 * writes themselves are still individual `add()` calls (the store's WriteBatch
 * only does deletes), run in bounded chunks so a full page can't open 200
 * concurrent writes.
 */
const BATCH_WRITE_CONCURRENCY = 20;

feedbackRouter.post('/feedback/batch', requireAuth, async (req, res, next) => {
  try {
    const parsed = FeedbackBatchRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: 'invalid_request',
        message:
          parsed.error.issues[0]?.message ?? 'eventId, photoIds and verdict are required',
      });
      return;
    }
    const { eventId, photoIds, verdict, runId, reason } = parsed.data;
    const user = req.user!;
    // A double-tap or an overlapping selection must not record the same photo
    // twice in one request.
    const unique = [...new Set(photoIds)];

    const run = await resolveRun(runId);
    const { searchVersion, algo } = run;
    const createdAt = new Date().toISOString();
    const row = {
      uid: user.uid,
      email: user.email ?? null,
      eventId,
      verdict,
      reason: reasonFor(verdict, reason),
      runId: runId ?? null,
      searchVersion,
      algo,
      createdAt,
    };

    for (let i = 0; i < unique.length; i += BATCH_WRITE_CONCURRENCY) {
      const chunk = unique.slice(i, i + BATCH_WRITE_CONCURRENCY);
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(
        chunk.map((photoId) =>
          firestore().collection('match_feedback').add({ ...row, photoId, tier: run.tierOf(photoId) }),
        ),
      );
    }

    logger.info(
      { eventId, verdict, runId, searchVersion, uid: user.uid, count: unique.length },
      'match feedback recorded (batch)',
    );
    const body: FeedbackBatchResponse = { ok: true, recorded: unique.length };
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

    const query: Query = firestore()
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
        searchVersion: (data.searchVersion as string | null) ?? null,
        algo: SearchAlgoSchema.safeParse(data.algo).data ?? null,
        reason: FeedbackReasonSchema.safeParse(data.reason).data ?? null,
        tier: MatchTierSchema.safeParse(data.tier).data ?? null,
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
