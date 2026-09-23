/**
 * expandResults.ts — the one bounded "see more" step (EVAL_FEEDBACK_LOOP.md §4b).
 *
 * The matcher returns, beside the results, the candidates that scored just
 * under the cutoff (`nearMisses`), and the api stores them on the `match_runs`
 * doc. "See more" reveals a slice of that band: at most `max` photos within ONE
 * step of the cutoff, best first, never one already in the results.
 *
 * Kept pure so the privacy bound is testable on its own: whatever a stored run
 * holds, this can only ever hand back photos inside the step, capped.
 */

export interface NearMiss {
  photoId: string;
  score: number;
  faceScore: number | null;
  personScore: number | null;
}

/** Parse a stored/returned band defensively — it comes back out of Firestore
 *  (or from a matcher revision that may predate the field). */
export function parseNearMisses(raw: unknown): NearMiss[] {
  if (!Array.isArray(raw)) return [];
  const out: NearMiss[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    if (typeof r.photoId !== 'string' || typeof r.score !== 'number') continue;
    out.push({
      photoId: r.photoId,
      score: r.score,
      faceScore: typeof r.faceScore === 'number' ? r.faceScore : null,
      personScore: typeof r.personScore === 'number' ? r.personScore : null,
    });
  }
  return out;
}

export interface ExpandOpts {
  /** The cutoff the run's results were gated on; null means no cutoff (face /
   *  person mode, or a run from before cutoffs were recorded) → nothing to add. */
  cutoff: number | null;
  /** Width of the one step, in the run's own score units (z or cosine). */
  step: number;
  max: number;
  /** photoIds already shown (the run's results). */
  exclude: ReadonlySet<string>;
}

/** The photos "see more" may reveal for a run, best first. */
export function expansionCandidates(nearMisses: readonly NearMiss[], opts: ExpandOpts): NearMiss[] {
  if (opts.cutoff === null || opts.max <= 0) return [];
  const floor = opts.cutoff - opts.step;
  return nearMisses
    .filter((h) => h.score >= floor && h.score < opts.cutoff! && !opts.exclude.has(h.photoId))
    .sort((a, b) => b.score - a.score || (a.photoId < b.photoId ? -1 : a.photoId > b.photoId ? 1 : 0))
    .slice(0, opts.max);
}
