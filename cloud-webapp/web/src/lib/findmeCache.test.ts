import { describe, it, expect } from 'vitest';
import type { MatchResult } from '@cloud-webapp/shared';
import {
  saveResults,
  loadResults,
  clearResults,
  FINDME_CACHE_TTL_MS,
  type CachedFindMe,
} from './findmeCache.js';

/** Minimal in-memory Storage double (sessionStorage-shaped). */
function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => m.delete(k),
    setItem: (k: string, v: string) => {
      m.set(k, String(v));
    },
  } as Storage;
}

function match(photoId: string, webUrl = `https://x/${photoId}.jpg`): MatchResult {
  return { photoId, score: 0.9, faceScore: 0.9, personScore: null, thumbUrl: `t/${photoId}`, webUrl };
}

function state(over: Partial<CachedFindMe> = {}): CachedFindMe {
  return {
    activeId: 'run-1',
    confirmed: new Set(['p2']),
    references: [
      {
        id: 'run-1',
        previewUrl: 'https://signed/selfie.jpg',
        label: 'Photo 1',
        runId: 'run-1',
        mode: 'fused',
        results: [match('p1'), match('p2')],
        hidden: new Set(['p9']),
      },
    ],
    ...over,
  };
}

describe('findmeCache', () => {
  it('round-trips references, activeId, confirmed and the hidden Set', () => {
    const s = fakeStorage();
    saveResults('ev1', state(), s);
    const got = loadResults('ev1', s);
    expect(got).not.toBeNull();
    expect(got!.activeId).toBe('run-1');
    expect([...got!.confirmed]).toEqual(['p2']);
    expect(got!.references).toHaveLength(1);
    const ref0 = got!.references[0]!;
    expect(ref0.results.map((r) => r.photoId)).toEqual(['p1', 'p2']);
    expect(ref0.hidden.has('p9')).toBe(true);
    expect(ref0.runId).toBe('run-1');
  });

  it('drops dead blob: preview URLs but keeps durable ones', () => {
    const s = fakeStorage();
    const st = state();
    st.references[0]!.previewUrl = 'blob:http://app/abc-123';
    saveResults('ev1', st, s);
    expect(loadResults('ev1', s)!.references[0]!.previewUrl).toBe('');

    const st2 = state();
    saveResults('ev2', st2, s);
    expect(loadResults('ev2', s)!.references[0]!.previewUrl).toBe('https://signed/selfie.jpg');
  });

  it('returns null and clears the entry once past the TTL', () => {
    const s = fakeStorage();
    saveResults('ev1', state(), s);
    const justAfter = Date.now() + FINDME_CACHE_TTL_MS + 1000;
    expect(loadResults('ev1', s, justAfter)).toBeNull();
    // entry was purged
    expect(s.getItem('findme:results:ev1')).toBeNull();
  });

  it('returns null for a missing or corrupt entry', () => {
    const s = fakeStorage();
    expect(loadResults('nope', s)).toBeNull();
    s.setItem('findme:results:bad', '{not json');
    expect(loadResults('bad', s)).toBeNull();
  });

  it('clearResults removes the cached set', () => {
    const s = fakeStorage();
    saveResults('ev1', state(), s);
    clearResults('ev1', s);
    expect(loadResults('ev1', s)).toBeNull();
  });

  it('scopes entries per eventId', () => {
    const s = fakeStorage();
    saveResults('ev1', state({ activeId: 'a' }), s);
    saveResults('ev2', state({ activeId: 'b' }), s);
    expect(loadResults('ev1', s)!.activeId).toBe('a');
    expect(loadResults('ev2', s)!.activeId).toBe('b');
  });
});
