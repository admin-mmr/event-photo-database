import { z } from 'zod';

/**
 * Pilot metrics (dev plan M6.2; PRD §2). A lightweight admin-only roll-up of the
 * PRD success metrics that are derivable from Firestore — search volume, unique
 * searchers, consent coverage, the feedback-based precision proxy, and erasure
 * activity — computed over a recent window.
 *
 * The metrics this does NOT cover are measured out of band and documented in
 * `docs/FINDME_RUNBOOK.md`: p95 latency (Cloud Run request metrics), monthly
 * spend (budget alert / billing), recall (labeled holdout), and volunteer-request
 * deflection (qualitative). This endpoint is the data-derived slice only.
 */

export const AdminMetricsResponseSchema = z.object({
  ok: z.literal(true),
  /** Window the figures cover. `eventId` is null when not filtered. */
  window: z.object({
    sinceDays: z.number(),
    since: z.string(),
    eventId: z.string().nullable(),
  }),
  /** Total Find Me searches (one `match_runs` doc each). */
  searches: z.number(),
  /** Distinct users who ran ≥1 search (PRD §2 adoption numerator). */
  distinctSearchers: z.number(),
  /** Search count split by matching mode. */
  searchesByMode: z.object({ fused: z.number(), person: z.number() }),
  /** Searches recorded as performed on behalf of a minor subject (D8). */
  minorSearches: z.number(),
  /**
   * Consent coverage (PRD §2 target: 100%). `records` counts `findme_search`
   * consent docs; coverage is records/searches, capped at 1. A consent is
   * written before every search, so this should sit at 1.0 — a dip flags a
   * code path that searched without recording consent.
   */
  consent: z.object({
    records: z.number(),
    coverage: z.number(),
  }),
  /**
   * Feedback-based judged precision (PRD §2 target ≥ 0.85). `precision` is
   * confirmed / (confirmed + not_me), or null when there are no votes yet.
   */
  feedback: z.object({
    confirmed: z.number(),
    not_me: z.number(),
    precision: z.number().nullable(),
  }),
  /** "Delete my data" / consent-revoke erasures recorded in the window (§8.5). */
  dataDeletions: z.number(),
  /**
   * Control-plane totals (current, not windowed): events + indexed photos from
   * Firestore, active/total users + clubs from the master Sheet. `null` when the
   * Sheet isn't configured (counts that need it are skipped, not faked).
   */
  platform: z
    .object({
      events: z.number(),
      photos: z.number(),
      users: z.number().nullable(),
      activeUsers: z.number().nullable(),
      clubs: z.number().nullable(),
    })
    .optional(),
});
export type AdminMetricsResponse = z.infer<typeof AdminMetricsResponseSchema>;
