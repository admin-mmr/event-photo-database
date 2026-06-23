/**
 * results.ts — pure helpers for the Find Me results view (dev plan §5A B3).
 *
 * Each reference selfie keeps its OWN result set; result sets must never blend
 * across uploads (that's the bug B3 fixes) EXCEPT in the explicit combined view
 * produced by `combineReferences`. Kept pure so the merge/dedup behaviour is
 * unit-testable without rendering.
 */

import type { MatchResult } from '@cloud-webapp/shared';

export interface ReferenceLike {
  results: MatchResult[];
  /** photoIds the user removed from this reference via "not me" (FR-15). */
  hidden: ReadonlySet<string>;
}

/** A single reference's visible results (its matches minus removed ones). */
export function visibleResults(ref: ReferenceLike): MatchResult[] {
  return ref.results.filter((r) => !ref.hidden.has(r.photoId));
}

/**
 * Score banding (dev plan §5B C7). A bare "51%" and "97%" both read as "a
 * match", so we bucket the fused score into a confidence band the eye can scan:
 * a high-confidence "Strong" vs a "Possible" worth a closer look in the
 * lightbox. The raw % stays available as detail. Threshold is a single tunable
 * constant — adjust against the eval harness, not by scattering magic numbers.
 */
export const STRONG_MATCH_THRESHOLD = 0.6;

export type ScoreBand = 'strong' | 'possible';

export function scoreBand(score: number): ScoreBand {
  return score >= STRONG_MATCH_THRESHOLD ? 'strong' : 'possible';
}

export function bandLabel(band: ScoreBand): string {
  return band === 'strong' ? 'Strong' : 'Possible';
}

/**
 * Calibrated display confidence (0–100) for a raw fused score.
 *
 * The raw score is a cosine similarity, which tops out well below 1.0 even for
 * an unmistakable match — a correct face match commonly lands around 0.65–0.75,
 * which reads as a discouraging "65%" to a user who expects a percentage. This
 * maps the raw score through a logistic curve anchored so the matcher's report
 * threshold (0.25, the weakest score ever shown) reads as 50% and a "Strong"
 * match (>=0.6) reads as ~89%+, giving an intuitive number.
 *
 * IMPORTANT: this is presentation only. Ranking, selection, paging, banding and
 * the matcher's threshold all stay in RAW-score space — never feed a calibrated
 * value back into them, or the displayed % and the ordering/band could diverge.
 * Clamped to 1–99 so a match never claims an absolute 0% or 100%.
 */
export const DISPLAY_MIDPOINT = 0.25; // raw score shown as 50%
export const DISPLAY_STEEPNESS = 6; // curve sharpness around the midpoint

export function displayConfidence(score: number): number {
  const pct = 100 / (1 + Math.exp(-DISPLAY_STEEPNESS * (score - DISPLAY_MIDPOINT)));
  return Math.round(Math.min(99, Math.max(1, pct)));
}

/**
 * Combined, de-duplicated view across references: the union of each reference's
 * *visible* results, keyed by photoId, keeping the highest score. A photo
 * removed from every reference disappears; one still matching another selfie
 * stays. This is the ONLY place result sets merge across uploads.
 */
export function combineReferences(refs: readonly ReferenceLike[]): MatchResult[] {
  const best = new Map<string, MatchResult>();
  for (const ref of refs) {
    for (const r of visibleResults(ref)) {
      const cur = best.get(r.photoId);
      if (!cur || r.score > cur.score) best.set(r.photoId, r);
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}
