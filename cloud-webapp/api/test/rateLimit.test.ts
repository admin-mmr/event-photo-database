import { describe, it, expect, vi } from 'vitest';

import type { DocumentStore } from '../src/lib/db/types.js';
import { fakeStore, type FakeStore } from './helpers/fakeDb.js';

import { consumeRateLimit, decideGuestIpLimit, humanizeRetry } from '../src/middleware/rateLimit.js';

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

describe('decideGuestIpLimit', () => {
  const GFE = '66.102.8.7';
  const opts = (mode: 'off' | 'shadow' | 'enforce', limit = 2) => ({ bucket: 'findme_search_ip', limit, windowSec: 3600, mode });
  function guest(xff: string, signInProvider?: string) {
    return {
      headers: { 'x-forwarded-for': xff },
      socket: {},
      user: { uid: `u-${Math.random()}`, ...(signInProvider ? { signInProvider } : {}) },
    } as never;
  }

  it('off: skips without touching the store', async () => {
    const { db, txCount } = makeDb();
    expect(await decideGuestIpLimit(db, guest(`198.51.100.4, ${GFE}`), opts('off'), NOW)).toEqual({ kind: 'skip', reason: 'off' });
    expect(txCount()).toBe(0);
  });

  it('a Google-signed-in user is exempt (fixed uid — the per-uid limit binds)', async () => {
    const { db, txCount } = makeDb();
    const out = await decideGuestIpLimit(db, guest(`198.51.100.4, ${GFE}`, 'google.com'), opts('enforce'), NOW);
    expect(out).toEqual({ kind: 'skip', reason: 'verified_sign_in' });
    expect(txCount()).toBe(0);
  });

  it('never limits on an untrusted IP (a front end posing as the client)', async () => {
    const { db } = makeDb();
    const out = await decideGuestIpLimit(db, guest(`74.125.210.5, ${GFE}`), opts('enforce'), NOW);
    expect(out).toEqual({ kind: 'skip', reason: 'no_trusted_ip' });
  });

  // The point of the per-IP limit: each request below is a NEW anonymous uid
  // (a fresh per-uid quota), but they all come from one network.
  it('shadow: fresh guest uids from one IP are counted together, over-limit is would_block', async () => {
    const { db } = makeDb();
    const kinds = [];
    for (let i = 0; i < 3; i++) kinds.push((await decideGuestIpLimit(db, guest(`198.51.100.4, ${GFE}`), opts('shadow'), NOW)).kind);
    expect(kinds).toEqual(['allow', 'allow', 'would_block']);
  });

  it('enforce: over-limit is block', async () => {
    const { db } = makeDb();
    let last;
    for (let i = 0; i < 3; i++) last = await decideGuestIpLimit(db, guest(`198.51.100.4, ${GFE}`, 'anonymous'), opts('enforce'), NOW);
    expect(last).toMatchObject({ kind: 'block', key: 'ip:198.51.100.4', via: 'hosting' });
  });

  it('direct to run.app, rotating a forged X-Forwarded-For does not get a fresh quota', async () => {
    const { db } = makeDb();
    const kinds = [];
    for (const forged of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      kinds.push((await decideGuestIpLimit(db, guest(`${forged}, 198.51.100.9`), opts('enforce'), NOW)).kind);
    }
    expect(kinds).toEqual(['allow', 'allow', 'block']);
  });

  it('different networks have separate budgets; one IPv6 /64 shares one', async () => {
    const { db } = makeDb();
    await decideGuestIpLimit(db, guest(`198.51.100.4, ${GFE}`), opts('enforce', 1), NOW);
    const other = await decideGuestIpLimit(db, guest(`198.51.100.5, ${GFE}`), opts('enforce', 1), NOW);
    expect(other.kind).toBe('allow');
    await decideGuestIpLimit(db, guest(`2001:db8:1:2::1, ${GFE}`), opts('enforce', 1), NOW);
    const sameSlash64 = await decideGuestIpLimit(db, guest(`2001:db8:1:2::99, ${GFE}`), opts('enforce', 1), NOW);
    expect(sameSlash64).toMatchObject({ kind: 'block', key: 'ip:2001:db8:1:2::/64' });
  });
});
