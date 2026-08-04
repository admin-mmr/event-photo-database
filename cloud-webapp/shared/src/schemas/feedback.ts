import { z } from 'zod';

import { SearchAlgoSchema } from './findme.js';

/**
 * Match feedback (dev plan §5A B7 / FR-15; PRD §7). A user marks a result as
 * "not me" (wrong match) or "confirmed" (that's me). Feedback is attached to
 * the `match_runs` record (via runId) so the eval feedback loop
 * (EVAL_FEEDBACK_LOOP.md) can measure judged precision over time.
 */

export const FeedbackVerdictSchema = z.enum(['not_me', 'confirmed']);
export type FeedbackVerdict = z.infer<typeof FeedbackVerdictSchema>;

export const FeedbackRequestSchema = z.object({
  eventId: z.string().min(1),
  photoId: z.string().min(1),
  verdict: FeedbackVerdictSchema,
  /** The search run this result came from (SearchResponse.runId), if known. */
  runId: z.string().optional(),
});
export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;

export const FeedbackResponseSchema = z.object({
  ok: z.literal(true),
  feedbackId: z.string(),
});
export type FeedbackResponse = z.infer<typeof FeedbackResponseSchema>;

/**
 * Most votes one batch may carry. Matches the largest Find Me page size
 * (FINDME_PAGE_SIZE_OPTIONS caps at 200), because the UI only ever offers a
 * bulk verdict over the results currently ON SCREEN — never the whole result
 * set. Someone with 800 matches judges them a page at a time, which keeps each
 * request bounded and keeps the user looking at what they are labelling.
 */
export const MAX_FEEDBACK_BATCH = 200;

/**
 * One verdict applied to several results at once ("all me" / "all not me").
 *
 * Same shape as a single vote with `photoId` widened to a list: each entry
 * still becomes its own immutable `match_feedback` doc, so the eval loop sees
 * no difference between a bulk vote and the clicks it replaces. Batching is a
 * transport concern, not a data-model one.
 */
export const FeedbackBatchRequestSchema = z.object({
  eventId: z.string().min(1),
  photoIds: z.array(z.string().min(1)).min(1).max(MAX_FEEDBACK_BATCH),
  verdict: FeedbackVerdictSchema,
  runId: z.string().optional(),
});
export type FeedbackBatchRequest = z.infer<typeof FeedbackBatchRequestSchema>;

export const FeedbackBatchResponseSchema = z.object({
  ok: z.literal(true),
  /** Votes actually written (duplicates within the request are collapsed). */
  recorded: z.number(),
});
export type FeedbackBatchResponse = z.infer<typeof FeedbackBatchResponseSchema>;

/**
 * Admin review queue (dev plan M4.4 / FR-16/FR-17). One recorded vote, surfaced
 * to admins so they can audit wrong/confirmed matches and feed model tuning.
 */
export const FeedbackItemSchema = z.object({
  feedbackId: z.string(),
  eventId: z.string(),
  photoId: z.string(),
  verdict: FeedbackVerdictSchema,
  runId: z.string().nullable(),
  uid: z.string(),
  email: z.string().nullable(),
  createdAt: z.string(),
  /**
   * Retrieval-algorithm generation that produced the voted-on result, copied
   * from the run at vote time. `null` for votes whose run predates this field
   * or can't be resolved (older votes, missing runId).
   */
  searchVersion: z.string().nullable(),
  /** Full algorithm descriptor snapshot (knobs), when the run recorded one. */
  algo: SearchAlgoSchema.nullable(),
});
export type FeedbackItem = z.infer<typeof FeedbackItemSchema>;

export const AdminFeedbackResponseSchema = z.object({
  ok: z.literal(true),
  /** Number of items returned in this window (after any filters). */
  total: z.number(),
  /** Verdict tallies over the returned window. */
  counts: z.object({ not_me: z.number(), confirmed: z.number() }),
  items: z.array(FeedbackItemSchema),
});
export type AdminFeedbackResponse = z.infer<typeof AdminFeedbackResponseSchema>;

// ── Verdict batches ──────────────────────────────────────────────────────────
//
// The flat queue above answers "what was voted on"; a *batch* answers "what did
// this one person say about this one search". A batch is a single Find Me search
// run (`match_runs` id, carried on each vote as `runId`) together with the selfie
// that was searched with and every verdict marked against its results — the view
// an admin needs to judge whether the matcher got that search right.

export const VerdictCountsSchema = z.object({ not_me: z.number(), confirmed: z.number() });
export type VerdictCounts = z.infer<typeof VerdictCountsSchema>;

/** One verdict inside a batch, with the voted-on photo resolved for display. */
export const VerdictBatchVoteSchema = z.object({
  feedbackId: z.string(),
  photoId: z.string(),
  verdict: FeedbackVerdictSchema,
  createdAt: z.string(),
  /** Short-lived signed thumbnail URL; `''` when the photo can't be signed. The
   *  full-size `web` derivative is signed on demand by the existing lightbox
   *  route (`GET /events/:id/photos/:photoId/web`), as in the gallery. */
  thumbUrl: z.string(),
  /** Matcher score this photo scored in the run, when the run recorded scores. */
  score: z.number().nullable(),
  /** 1-based position in the run's result list; null if unknown. */
  rank: z.number().nullable(),
});
export type VerdictBatchVote = z.infer<typeof VerdictBatchVoteSchema>;

/** Batch header — enough to list batches without resolving every vote. */
export const VerdictBatchSchema = z.object({
  runId: z.string(),
  eventId: z.string(),
  uid: z.string(),
  email: z.string().nullable(),
  /** Searcher-provided display name, from the selfie record. */
  name: z.string().nullable(),
  /** Newest verdict in the batch — the ordering key for the list. */
  markedAt: z.string(),
  /** When the search itself ran; null when the run record is gone. */
  searchedAt: z.string().nullable(),
  mode: z.string().nullable(),
  modelVersion: z.string().nullable(),
  searchVersion: z.string().nullable(),
  algo: SearchAlgoSchema.nullable(),
  /** Results the search returned, so unjudged results are visible as a gap. */
  resultCount: z.number().nullable(),
  /** Short-lived signed URL for the selfie searched with. Null only when there
   *  is no selfie to show at all — expired, erased by the user, or the searcher
   *  has no stored reference. */
  selfieUrl: z.string().nullable(),
  selfieUploadId: z.string().nullable(),
  /**
   * How confidently the selfie belongs to THIS search:
   *   `linked`   — the run recorded its uploadId. Certain.
   *   `joined`   — matched on the exact timestamp the run and the reference
   *                share. Certain (older fresh-upload searches).
   *   `inferred` — best guess: the searcher's most recent selfie from before
   *                this search. Shown for older *reuse* searches, which
   *                recorded no reference of their own. Treat as a hint.
   */
  selfieSource: z.enum(['linked', 'joined', 'inferred']).nullable(),
  counts: VerdictCountsSchema,
  /** Verdicts in this batch (`counts.not_me + counts.confirmed`). */
  total: z.number(),
});
export type VerdictBatch = z.infer<typeof VerdictBatchSchema>;

export const VerdictBatchDetailSchema = VerdictBatchSchema.extend({
  votes: z.array(VerdictBatchVoteSchema),
});
export type VerdictBatchDetail = z.infer<typeof VerdictBatchDetailSchema>;

export const AdminVerdictBatchListResponseSchema = z.object({
  ok: z.literal(true),
  /** Batches returned (after any filters). */
  total: z.number(),
  /** Verdicts in the scanned window with no `runId` — they belong to no batch
   *  and are only visible in the flat queue. */
  unattributed: z.number(),
  /** The scan hit its window cap; older batches may exist beyond it. */
  capped: z.boolean(),
  batches: z.array(VerdictBatchSchema),
});
export type AdminVerdictBatchListResponse = z.infer<typeof AdminVerdictBatchListResponseSchema>;

export const AdminVerdictBatchResponseSchema = z.object({
  ok: z.literal(true),
  batch: VerdictBatchDetailSchema,
});
export type AdminVerdictBatchResponse = z.infer<typeof AdminVerdictBatchResponseSchema>;
