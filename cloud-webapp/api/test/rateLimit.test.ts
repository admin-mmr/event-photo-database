import { describe, it, expect, vi } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';

import { consumeRateLimit } from '../src/middleware/rateLimit.js';

/**
 * Minimal in-memory Firestore double: collection().doc(id) returns a ref whose
 * id keys an in-memory map; runTransaction runs the body with get/set against
 * that map. Enough to exercise the fixed-window counter.
 */
function makeDb(): { db: Firestore; store: Map<string, Record<string, unknown>>; txCount: () => number } {
  const store = new Map<string, Record<string, unknown>>();
  let txCalls = 0;
  const db = {
    collection: () => ({
      doc: (id: string) => ({ _id: id }),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<number>) => {
      txCalls += 1;
      const tx = {
        get: async (ref: { _id: string }) => ({
          exists: store.has(ref._id),
          data: () => store.get(ref._id),
        }),
        set: (ref: { _id: string }, data: Record<string, unknown>) => {
          store.set(ref._id, { ...(store.get(ref._id) ?? {}), ...data });
        },
      };
      return fn(tx);
    },
  } as unknown as Firestore;
  return { db, store, txCount: () => txCalls };
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

  it('fails OPEN when the transaction throws', async () => {
    const db = {
      collection: () => ({ doc: (id: string) => ({ _id: id }) }),
      runTransaction: vi.fn().mockRejectedValue(new Error('firestore down')),
    } as unknown as Firestore;
    const d = await consumeRateLimit(db, 'b', 'u1', 1, 60, NOW);
    expect(d.allowed).toBe(true);
  });
});
