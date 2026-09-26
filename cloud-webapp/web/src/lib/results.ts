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
 * match", so we bucket the fused score into a confidence band the eye can scan.
 * Threshold constants are tunable — adjust against the eval harness, not by
 * scattering magic numbers.
 *
 * Scores come in two SCALES, and must never be read with the other one's rules:
 *  - 'raw': fused cosine similarity, at most 1.0 (T-norm off, the pre-July path).
 *  - 'z':   T-normed, how many standard deviations a photo sits above the
 *           event's crowd. Every result shown is at least the cutoff (4.5 as of
 *           2026-09-23), so reading a z with the raw rules made EVERY result
 *           "Strong · 99%" — the bug this scale split fixes.
 */
export type ScoreScale = 'raw' | 'z';

/** The scale a search's scores are on. `algo.tnorm` says so when present; a
 *  result restored from the session cache has no algo, so fall back to the
 *  scores themselves — a fused cosine can never exceed 1.0 (weights sum to 1),
 *  while every T-normed result is several units above it. */
export function scaleOf(algo: { tnorm?: boolean } | null | undefined, scores: readonly number[]): ScoreScale {
  if (algo && typeof algo.tnorm === 'boolean') return algo.tnorm ? 'z' : 'raw';
  return scores.some((s) => s > 1.01) ? 'z' : 'raw';
}

export const STRONG_MATCH_THRESHOLD = 0.6; // raw scale

export type ScoreBand = 'strong' | 'likely' | 'possible';

/**
 * z scale: the badge % IS the evidence — the share of members who said "that's
 * me" to results at that z, fitted from their votes by
 * `matcher/eval/calibrate_display.py` (isotonic, so it never falls as z rises).
 * Knots are [z, %]; between knots it interpolates, beyond them it holds the end
 * value. Re-fit as votes accumulate (quality plan Item 17).
 *
 * Caveat: votes come from results members chose to judge, so this is judged
 * precision, not a true probability over everything shown.
 */
// COPIED in matcher/eval/monthly_calibration.py (CURRENT_Z_CALIBRATION), which the
// monthly report compares the votes against; a test pins the two — change both.
// Fitted 2026-09-23 from 3,425 judged T-normed results (z >= 4.0). Read it as:
// at z 4.4 about 57% of photos were the searcher, at z 6.1 about 95%.
export const Z_CALIBRATION: ReadonlyArray<readonly [number, number]> = [
  [4.12, 39], [4.36, 57], [4.77, 74], [5.13, 87], [5.38, 90],
  [5.63, 92], [6.14, 95], [6.75, 96], [7.38, 97], [8.87, 98],
];

/** Band cut points on the calibrated % (z scale). With the 2026-09-23 fit:
 *  Strong ≈ z 6.1+, Likely ≈ z 5.1–6.1, Possible from the cutoff (4.5 ≈ 63%). */
export const STRONG_PCT = 95;
export const LIKELY_PCT = 85;

export function scoreBand(score: number, scale: ScoreScale = 'raw'): ScoreBand {
  if (scale === 'z') {
    const pct = displayConfidence(score, 'z');
    return pct >= STRONG_PCT ? 'strong' : pct >= LIKELY_PCT ? 'likely' : 'possible';
  }
  return score >= STRONG_MATCH_THRESHOLD ? 'strong' : 'possible';
}

/**
 * A result the member should judge one by one (quality plan Item 16): its badge
 * says Possible, or it came from "see more". These are the photos a cutoff
 * decision turns on — at z 4.0–4.5 only ~47% of judged photos were the searcher,
 * against 95%+ at z 6 — so one careful vote here moves the calibration more than
 * twenty on the obvious top matches. That is also why a blanket "all me / all
 * not me" must skip them: a verdict the member didn't look at is noise exactly
 * where the signal is scarcest.
 */
export function isHardToCall(r: { score: number; tier?: string | null | undefined }, scale: ScoreScale): boolean {
  return r.tier === 'expanded' || scoreBand(r.score, scale) === 'possible';
}

export function bandLabel(band: ScoreBand): string {
  return band === 'strong' ? 'Strong' : band === 'likely' ? 'Likely' : 'Possible';
}

/**
 * Display confidence (1–99) for a fused score on its own scale.
 *
 * raw: the cosine tops out well below 1.0 even for an unmistakable match (a
 * correct face commonly lands around 0.65–0.75, a discouraging "65%"), so it is
 * mapped through a logistic anchored so the old report threshold (0.25) reads as
 * 50% and a "Strong" match (>=0.6) reads as ~89%+.
 *
 * z: interpolated from Z_CALIBRATION (see above).
 *
 * IMPORTANT: this is presentation only. Ranking, selection, paging and the
 * matcher's threshold all stay in score space — never feed a displayed value
 * back into them, or the displayed % and the ordering could diverge. Clamped to
 * 1–99 so a match never claims an absolute 0% or 100%.
 */
export const DISPLAY_MIDPOINT = 0.25; // raw score shown as 50%
export const DISPLAY_STEEPNESS = 6; // curve sharpness around the midpoint

export function displayConfidence(score: number, scale: ScoreScale = 'raw'): number {
  const pct = scale === 'z' ? interpolate(Z_CALIBRATION, score) : 100 / (1 + Math.exp(-DISPLAY_STEEPNESS * (score - DISPLAY_MIDPOINT)));
  return Math.round(Math.min(99, Math.max(1, pct)));
}

function interpolate(knots: ReadonlyArray<readonly [number, number]>, x: number): number {
  const first = knots[0]!;
  const last = knots[knots.length - 1]!;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < knots.length; i += 1) {
    const [x1, y1] = knots[i]!;
    if (x <= x1) {
      const [x0, y0] = knots[i - 1]!;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return last[1];
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

/**
 * Which photos on the CURRENT PAGE a bulk verdict would label.
 *
 * Pulled out and tested on its own because this is the mislabelling surface: a
 * page of 200 results, one tap, and every id in the wrong bucket is a false
 * label in the eval set. The rules are deliberately narrow —
 *
 *  - only what is on screen (`shownIds`), never the whole result set;
 *  - never a photo the user already judged (`confirmed`; a "not me" has already
 *    left the visible list, so it cannot appear here);
 *  - `selected` mirrors the download ticks, which are a per-photo judgement the
 *    user already made, and `rest` is everything else still unjudged;
 *  - a hard-to-call photo (`isHard`, see `isHardToCall`) is never swept into a
 *    blanket verdict: it stays out of `rest` and out of `blanket` (the set "All
 *    me / All not me" labels) and is listed in `hard` for a one-by-one ask. A
 *    TICK on one is still a per-photo judgement, so it stays in `selected`.
 */
export function bulkVoteTargets(
  shownIds: readonly string[],
  confirmed: ReadonlySet<string>,
  isSelected: (id: string) => boolean,
  isHard: (id: string) => boolean = () => false,
): { unvoted: string[]; selected: string[]; rest: string[]; blanket: string[]; hard: string[] } {
  const unvoted = shownIds.filter((id) => !confirmed.has(id));
  return {
    unvoted,
    selected: unvoted.filter(isSelected),
    rest: unvoted.filter((id) => !isSelected(id) && !isHard(id)),
    blanket: unvoted.filter((id) => !isHard(id)),
    hard: unvoted.filter((id) => isHard(id) && !isSelected(id)),
  };
}

/** What a page-turn checkpoint needs to know about the page being left. */
export interface PageTurnState {
  /** Results on this page the user hasn't judged. */
  unvoted: number;
  /** Results on this page they HAVE judged. */
  voted: number;
  /** Unjudged results they've ticked for download. */
  selected: number;
  /** Already interrupted once on this page. */
  asked: boolean;
  /** Voting is per-reference; the Combined view has no single run behind it. */
  canVote: boolean;
}

/**
 * Whether to hold a page turn and ask about the unjudged results first.
 *
 * The ask has to happen while the page is still on screen — once the page
 * changes those photos are gone, and labelling off-screen photos is exactly the
 * mislabelling risk bulk voting is scoped to avoid. So this is an interruption,
 * and it earns its place only under a narrow gate:
 *
 *  - there is something left to judge;
 *  - they were DEMONSTRABLY judging — a vote cast or a photo ticked for
 *    download on this page. Scrolling and hitting Next is browsing, not
 *    judging, and interrupting a browser trains everyone to dismiss on sight.
 *    Deliberately excludes "opened the lightbox": that reads as easily as
 *    "nice photo" as it does "is this me?".
 *  - we haven't already asked on this page. The second Next always goes
 *    through, so the worst case is one extra tap, never a trap.
 */
export function shouldAskBeforeLeaving(s: PageTurnState): boolean {
  if (!s.canVote || s.asked) return false;
  if (s.unvoted === 0) return false;
  return s.voted > 0 || s.selected > 0;
}
