import { describe, it, expect } from 'vitest';
import type { MatchResult } from '@cloud-webapp/shared';
import {
  combineReferences,
  visibleResults,
  scoreBand,
  bandLabel,
  STRONG_MATCH_THRESHOLD,
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
