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
