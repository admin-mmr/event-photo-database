import { describe, it, expect, vi } from 'vitest';

import type { DocumentStore } from '../src/lib/db/types.js';
import { fakeStore, type FakeStore } from './helpers/fakeDb.js';

import { consumeRateLimit, humanizeRetry } from '../src/middleware/rateLimit.js';

/** The shared in-memory DocumentStore (see helpers/fakeDb.ts) — no bespoke
 *  double here, so these assertions hold for any adapter that satisfies the
 *  interface, Cosmos included. */
function makeDb(): { db: FakeStore; txCount: () => number } {
  const db = fakeStore();
  return { db, txCount: () => db.transactions };
}

const NOW = 1_700_000_000_000; // fixed clock

describe('consumeRateLimit', () => {
  it('disables the bucket when limit <= 0 (no Firestore call)', async () => {
    const { db, txCount } = makeDb();
    const d = await consumeRateLimit(db, 'b', 'u1', 0, 60, NOW);
    expect(d.allowed).toBe(true);
    expect(txCount()).toBe(0);
  });

  it('allows calls up to the limit, then blocks', async () => {
    const { db } = makeDb();
    const opts = ['b', 'u1', 3, 60, NOW] as const;
    const d1 = await consumeRateLimit(db, ...opts);
    const d2 = await consumeRateLimit(db, ...opts);
    const d3 = await consumeRateLimit(db, ...opts);
    const d4 = await consumeRateLimit(db, ...opts);
    expect([d1.allowed, d2.allowed, d3.allowed, d4.allowed]).toEqual([true, true, true, false]);
    expect(d1.remaining).toBe(2);
    expect(d3.remaining).toBe(0);
    expect(d4.resetSec).toBeGreaterThan(0);
    expect(d4.resetSec).toBeLessThanOrEqual(60);
  });

  it('scopes counts per (bucket, key)', async () => {
    const { db } = makeDb();
    await consumeRateLimit(db, 'search', 'u1', 1, 60, NOW);
    const other = await consumeRateLimit(db, 'search', 'u2', 1, 60, NOW); // different key
    const sameBucketDiffAction = await consumeRateLimit(db, 'download', 'u1', 1, 60, NOW);
    expect(other.allowed).toBe(true);
    expect(sameBucketDiffAction.allowed).toBe(true);
  });

  it('resets when the window rolls over', async () => {
    const { db } = makeDb();
    const a = await consumeRateLimit(db, 'b', 'u1', 1, 60, NOW);
    const blockedSameWindow = await consumeRateLimit(db, 'b', 'u1', 1, 60, NOW + 30_000);
    const nextWindow = await consumeRateLimit(db, 'b', 'u1', 1, 60, NOW + 61_000);
    expect(a.allowed).toBe(true);
    expect(blockedSameWindow.allowed).toBe(false);
    expect(nextWindow.allowed).toBe(true);
  });

  it('humanizes the retry delay for the user-facing message (§5B C1)', () => {
    expect(humanizeRetry(1)).toBe('about 1 second');
    expect(humanizeRetry(45)).toBe('about 45 seconds');
    expect(humanizeRetry(90)).toBe('about 2 minutes');
    expect(humanizeRetry(60)).toBe('about 1 minute');
    // the real-world bug case: a ~6.9h reset should read as hours, not "24814s".
    expect(humanizeRetry(24814)).toBe('about 7 hours');
    expect(humanizeRetry(3600)).toBe('about 1 hour');
    expect(humanizeRetry(-5)).toBe('about 0 seconds');
  });

  it('fails OPEN when the transaction throws', async () => {
    const db: DocumentStore = Object.assign(fakeStore(), {
      runTransaction: vi.fn().mockRejectedValue(new Error('firestore down')),
    });
    const d = await consumeRateLimit(db, 'b', 'u1', 1, 60, NOW);
    expect(d.allowed).toBe(true);
  });
});
