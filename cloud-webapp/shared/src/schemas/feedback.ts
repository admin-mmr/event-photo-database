import { z } from 'zod';

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
