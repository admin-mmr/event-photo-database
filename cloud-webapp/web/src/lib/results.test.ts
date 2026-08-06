import { describe, it, expect } from 'vitest';
import type { MatchResult, ReferenceFaces } from '@cloud-webapp/shared';
import {
  combineReferences,
  visibleResults,
  scoreBand,
  bandLabel,
  STRONG_MATCH_THRESHOLD,
  displayConfidence,
  DISPLAY_MIDPOINT,
  faceAlertFor,
  bulkVoteTargets,
  shouldAskBeforeLeaving,
} from './results.js';

function mr(photoId: string, score: number): MatchResult {
  return { photoId, score, faceScore: score, personScore: null, thumbUrl: '', webUrl: '' };
}

describe('results helpers (B3)', () => {
  it('visibleResults excludes a reference\'s hidden ("not me") photos', () => {
    const ref = { results: [mr('p1', 0.9), mr('p2', 0.8)], hidden: new Set(['p2']) };
    expect(visibleResults(ref).map((r) => r.photoId)).toEqual(['p1']);
  });

  it('does NOT blend two references outside the combined view', () => {
    const refA = { results: [mr('a1', 0.9)], hidden: new Set<string>() };
    const refB = { results: [mr('b1', 0.7)], hidden: new Set<string>() };
    // Each reference's own view is isolated.
    expect(visibleResults(refA).map((r) => r.photoId)).toEqual(['a1']);
    expect(visibleResults(refB).map((r) => r.photoId)).toEqual(['b1']);
  });

  it('combineReferences unions visible results, deduped by photoId at max score', () => {
    const refA = { results: [mr('shared', 0.6), mr('a1', 0.9)], hidden: new Set<string>() };
    const refB = { results: [mr('shared', 0.8), mr('b1', 0.7)], hidden: new Set<string>() };
    const combined = combineReferences([refA, refB]);
    // Sorted best-first; "shared" appears once at the higher 0.8 score.
    expect(combined.map((r) => r.photoId)).toEqual(['a1', 'shared', 'b1']);
    expect(combined.find((r) => r.photoId === 'shared')?.score).toBe(0.8);
  });

  it('combined view drops a photo only when removed from every reference', () => {
    const refA = { results: [mr('p', 0.6)], hidden: new Set(['p']) };
    const refB = { results: [mr('p', 0.8)], hidden: new Set<string>() };
    // Removed from A but still matching B → stays (sourced from B).
    expect(combineReferences([refA, refB]).map((r) => r.photoId)).toEqual(['p']);
    // Removed from both → gone.
    const refB2 = { results: [mr('p', 0.8)], hidden: new Set(['p']) };
    expect(combineReferences([refA, refB2])).toEqual([]);
  });
});

describe('scoreBand (C7)', () => {
  it('bands at/above the threshold as strong, below as possible', () => {
    expect(scoreBand(STRONG_MATCH_THRESHOLD)).toBe('strong');
    expect(scoreBand(0.97)).toBe('strong');
    expect(scoreBand(STRONG_MATCH_THRESHOLD - 0.001)).toBe('possible');
    expect(scoreBand(0.2)).toBe('possible');
  });

  it('maps bands to human labels', () => {
    expect(bandLabel('strong')).toBe('Strong');
    expect(bandLabel('possible')).toBe('Possible');
  });
});

describe('displayConfidence (calibrated %)', () => {
  it('shows the report threshold (0.25) as 50%', () => {
    expect(displayConfidence(DISPLAY_MIDPOINT)).toBe(50);
  });

  it('lifts a correct-but-modest cosine into an intuitive range', () => {
    // The complaint case: a genuine match at ~0.67 used to read "67%".
    expect(displayConfidence(0.67)).toBeGreaterThanOrEqual(90);
  });

  it('reads a "Strong" match (>=0.6) as ~89%+', () => {
    expect(displayConfidence(STRONG_MATCH_THRESHOLD)).toBeGreaterThanOrEqual(88);
  });

  it('is monotonic in the raw score', () => {
    const xs = [0.25, 0.35, 0.5, 0.6, 0.7, 0.85, 0.95];
    const ys = xs.map(displayConfidence);
    for (let i = 1; i < ys.length; i += 1) {
      expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1]!);
    }
  });

  it('never claims an absolute 0% or 100%', () => {
    expect(displayConfidence(0)).toBeGreaterThanOrEqual(1);
    expect(displayConfidence(1)).toBeLessThanOrEqual(99);
    expect(displayConfidence(5)).toBeLessThanOrEqual(99);
  });
});

describe('faceAlertFor (selfie warnings)', () => {
  const ref = (
    faces: number,
    opts: Partial<Omit<ReferenceFaces, 'faces'>> = {},
  ): ReferenceFaces => ({
    faces,
    usableFaces: opts.usableFaces ?? faces,
    selectedFace: opts.selectedFace === undefined ? [0.1, 0.2, 0.3, 0.4] : opts.selectedFace,
    ...(opts.selectedWarnings ? { selectedWarnings: opts.selectedWarnings } : {}),
  });

  it('stays silent for a good solo selfie', () => {
    expect(faceAlertFor([ref(1)], 'blob:a')).toBeNull();
  });

  it('stays silent when the matcher reports no census (older revision)', () => {
    expect(faceAlertFor(undefined, 'blob:a')).toBeNull();
    expect(faceAlertFor([], 'blob:a')).toBeNull();
  });

  it('warns with the face count and outlines the face that was matched', () => {
    expect(faceAlertFor([ref(3)], 'blob:a')).toEqual({
      count: 3,
      warnings: [],
      previewUrl: 'blob:a',
      selectedFace: [0.1, 0.2, 0.3, 0.4],
    });
  });

  it('reports the busiest selfie of the batch', () => {
    expect(faceAlertFor([ref(1), ref(4)], 'blob:a')?.count).toBe(4);
  });

  it('outlines nothing when the previewed (first) selfie is the clean one', () => {
    // The preview shows selfie 1; selfie 2's box would land on the wrong photo.
    expect(faceAlertFor([ref(1), ref(2)], 'blob:a')?.selectedFace).toBeNull();
  });

  it('outlines nothing when no face was usable', () => {
    expect(
      faceAlertFor([ref(2, { usableFaces: 0, selectedFace: null })], 'blob:a')?.selectedFace,
    ).toBeNull();
  });

  it('warns about a lone face that is small or turned away', () => {
    const alert = faceAlertFor([ref(1, { selectedWarnings: ['not_frontal'] })], 'blob:a');
    expect(alert).toEqual({
      count: 1,
      warnings: ['not_frontal'],
      previewUrl: 'blob:a',
      selectedFace: [0.1, 0.2, 0.3, 0.4],
    });
  });

  it('dedupes warnings across selfies', () => {
    const alert = faceAlertFor(
      [
        ref(1, { selectedWarnings: ['face_small_in_frame'] }),
        ref(1, { selectedWarnings: ['face_small_in_frame', 'not_frontal'] }),
      ],
      'blob:a',
    );
    expect(alert?.warnings).toEqual(['face_small_in_frame', 'not_frontal']);
  });

  it('outlines nothing when only a LATER selfie has the weak face', () => {
    const alert = faceAlertFor([ref(1), ref(1, { selectedWarnings: ['face_small_in_frame'] })], 'blob:a');
    expect(alert?.selectedFace).toBeNull();
  });
});

describe('bulkVoteTargets (what a bulk verdict would label)', () => {
  const shown = ['a', 'b', 'c', 'd'];

  it('treats everything unjudged on the page as fair game', () => {
    const t = bulkVoteTargets(shown, new Set(), () => false);
    expect(t.unvoted).toEqual(shown);
    expect(t.rest).toEqual(shown);
    expect(t.selected).toEqual([]);
  });

  it('never re-labels a photo the user already confirmed', () => {
    const t = bulkVoteTargets(shown, new Set(['a', 'c']), () => false);
    expect(t.unvoted).toEqual(['b', 'd']);
  });

  it('splits on the download ticks', () => {
    const ticked = new Set(['b', 'd']);
    const t = bulkVoteTargets(shown, new Set(), (id) => ticked.has(id));
    expect(t.selected).toEqual(['b', 'd']);
    expect(t.rest).toEqual(['a', 'c']);
  });

  it('a ticked photo that was already confirmed is not labelled twice', () => {
    const ticked = new Set(['a', 'b']);
    const t = bulkVoteTargets(shown, new Set(['a']), (id) => ticked.has(id));
    expect(t.selected).toEqual(['b']);
    expect(t.rest).toEqual(['c', 'd']);
  });

  it('selected and rest partition unvoted exactly — no photo in both, none lost', () => {
    const ticked = new Set(['a', 'd']);
    const t = bulkVoteTargets(shown, new Set(['c']), (id) => ticked.has(id));
    expect([...t.selected, ...t.rest].sort()).toEqual([...t.unvoted].sort());
    expect(t.selected.filter((id) => t.rest.includes(id))).toEqual([]);
  });

  it('is empty when the page is fully judged', () => {
    const t = bulkVoteTargets(shown, new Set(shown), () => true);
    expect(t).toEqual({ unvoted: [], selected: [], rest: [] });
  });

  it('only ever covers the page it was given', () => {
    // The whole result set is larger; the page is what's passed in.
    const t = bulkVoteTargets(['a', 'b'], new Set(), () => false);
    expect(t.unvoted).toEqual(['a', 'b']);
  });
});

describe('shouldAskBeforeLeaving (page-turn checkpoint)', () => {
  const base = { unvoted: 10, voted: 0, selected: 0, asked: false, canVote: true };

  it('asks when they judged some and left others', () => {
    expect(shouldAskBeforeLeaving({ ...base, voted: 3 })).toBe(true);
  });

  it('asks when they ticked photos for download', () => {
    expect(shouldAskBeforeLeaving({ ...base, selected: 2 })).toBe(true);
  });

  it('stays silent for someone just browsing', () => {
    // No vote, no tick — scrolling past is not judging.
    expect(shouldAskBeforeLeaving(base)).toBe(false);
  });

  it('stays silent when the page is fully judged', () => {
    expect(shouldAskBeforeLeaving({ ...base, unvoted: 0, voted: 10 })).toBe(false);
  });

  it('never asks twice on the same page', () => {
    expect(shouldAskBeforeLeaving({ ...base, voted: 3, asked: true })).toBe(false);
  });

  it('never asks in the Combined view, which has no run to attach votes to', () => {
    expect(shouldAskBeforeLeaving({ ...base, voted: 3, canVote: false })).toBe(false);
  });
});
