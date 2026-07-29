/**
 * results.ts — pure helpers for the Find Me results view (dev plan §5A B3).
 *
 * Each reference selfie keeps its OWN result set; result sets must never blend
 * across uploads (that's the bug B3 fixes) EXCEPT in the explicit combined view
 * produced by `combineReferences`. Kept pure so the merge/dedup behaviour is
 * unit-testable without rendering.
 */

import type { MatchResult, ReferenceFaces, SelfieFaceWarning } from '@cloud-webapp/shared';

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

/**
 * What the searcher should be told about the selfie they just uploaded: that it
 * held more than one person, and/or that the face we matched is small or turned
 * away from the camera.
 *
 * The matcher queries with only the most confident *usable* face, which on a
 * group shot may not be the searcher — so we say so, offer a re-pick, and show
 * which face was used. `selectedFace` is [x1, y1, x2, y2] as fractions of the
 * previewed image.
 */
export interface FaceAlert {
  /** Most faces found in any ONE selfie of this search. 1 when the only
   *  problem is the quality of the single face that was found. */
  count: number;
  /** Advisory problems with the face we matched, deduped across the selfies. */
  warnings: SelfieFaceWarning[];
  previewUrl: string;
  selectedFace: readonly [number, number, number, number] | null;
}

/**
 * Build the alert for a completed search, or null when there is nothing worth
 * saying — one face per selfie and no quality warnings (and likewise when an
 * older matcher reported no census at all).
 *
 * `referenceFaces` is per uploaded selfie in upload order and `previewUrl`
 * shows the FIRST one, so a face is only outlined when that first selfie is
 * itself the one with company in it — outlining a box from selfie 2 over
 * selfie 1 would point at the wrong thing.
 */
export function faceAlertFor(
  referenceFaces: readonly ReferenceFaces[] | undefined,
  previewUrl: string,
): FaceAlert | null {
  if (!referenceFaces || referenceFaces.length === 0) return null;
  const count = Math.max(...referenceFaces.map((r) => r.faces));
  const warnings = [...new Set(referenceFaces.flatMap((r) => r.selectedWarnings ?? []))];
  if (count <= 1 && warnings.length === 0) return null;
  const primary = referenceFaces[0]!;
  // Outline the matched face whenever the previewed selfie is the one being
  // talked about — for a group shot, or when its own face is what's weak.
  const primaryIsSubject =
    primary.faces > 1 || (primary.selectedWarnings ?? []).length > 0;
  return {
    count,
    warnings,
    previewUrl,
    selectedFace: primaryIsSubject ? primary.selectedFace : null,
  };
}
