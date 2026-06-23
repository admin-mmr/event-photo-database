import { describe, it, expect } from 'vitest';
import type { MatchResult } from '@cloud-webapp/shared';
import {
  combineReferences,
  visibleResults,
  scoreBand,
  bandLabel,
  STRONG_MATCH_THRESHOLD,
  displayConfidence,
  DISPLAY_MIDPOINT,
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
