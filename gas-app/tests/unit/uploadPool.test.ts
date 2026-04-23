/**
 * uploadPool.test.ts
 *
 * Tests for makeConcurrentPool(), computeEtaSeconds(), and formatEtaText()
 * from src/utils/uploadPool.ts.
 *
 * All tests run in the standard Node environment (no DOM / GAS globals needed).
 */

import {
  makeConcurrentPool,
  computeEtaSeconds,
  formatEtaText,
} from '../../src/utils/uploadPool';

// ─── makeConcurrentPool ───────────────────────────────────────────────────────

describe('makeConcurrentPool()', () => {

  // ── Zero / trivial cases ───────────────────────────────────────────────────

  it('calls onAllDone immediately when total === 0', () => {
    const done = jest.fn();
    makeConcurrentPool(0, 3, jest.fn(), done).start();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('processes exactly one item when total === 1', () => {
    const order: number[] = [];
    const done = jest.fn();
    makeConcurrentPool(1, 3, (idx, settle) => {
      order.push(idx);
      settle();
    }, done).start();
    expect(order).toEqual([0]);
    expect(done).toHaveBeenCalledTimes(1);
  });

  // ── Concurrency === 1 (sequential) ────────────────────────────────────────

  it('processes all items in order when concurrency === 1', () => {
    const order: number[] = [];
    const done = jest.fn();
    makeConcurrentPool(5, 1, (idx, settle) => {
      order.push(idx);
      settle();
    }, done).start();
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(done).toHaveBeenCalledTimes(1);
  });

  // ── Concurrency > 1 (parallel) ────────────────────────────────────────────

  it('launches exactly `concurrency` items in the first pump', () => {
    const started: number[] = [];
    const settlers: Array<() => void> = [];

    makeConcurrentPool(10, 3, (idx, settle) => {
      started.push(idx);
      settlers.push(settle);
    }, jest.fn()).start();

    // Three items should have been dispatched immediately.
    expect(started).toEqual([0, 1, 2]);
    expect(settlers).toHaveLength(3);
  });

  it('dispatches a new item each time one settles, keeping concurrency full', () => {
    const started: number[] = [];
    const settlers: Array<() => void> = [];

    makeConcurrentPool(6, 2, (idx, settle) => {
      started.push(idx);
      settlers.push(settle);
    }, jest.fn()).start();

    expect(started).toEqual([0, 1]); // initial pump: 2 slots

    settlers[0](); // item 0 done → pump → start item 2
    expect(started).toEqual([0, 1, 2]);

    settlers[1](); // item 1 done → pump → start item 3
    expect(started).toEqual([0, 1, 2, 3]);
  });

  it('calls onAllDone exactly once after all items settle', () => {
    const settlers: Array<() => void> = [];
    const onAllDone = jest.fn();

    makeConcurrentPool(4, 2, (_idx, settle) => {
      settlers.push(settle);
    }, onAllDone).start();

    expect(onAllDone).not.toHaveBeenCalled();

    settlers[0](); expect(onAllDone).not.toHaveBeenCalled();
    settlers[2](); expect(onAllDone).not.toHaveBeenCalled(); // settler 2 started after 0 settled
    settlers[1](); expect(onAllDone).not.toHaveBeenCalled();
    settlers[3](); // last item — 4 done / 4 total
    expect(onAllDone).toHaveBeenCalledTimes(1);
  });

  it('processes all items even when some "fail" (settle is still called)', () => {
    // Simulates uploads where some fail — settle() should still be called.
    const results: string[] = [];
    const done = jest.fn();

    makeConcurrentPool(4, 4, (idx, settle) => {
      results.push(idx % 2 === 0 ? 'ok' : 'err');
      settle(); // always settle, regardless of outcome
    }, done).start();

    expect(results).toHaveLength(4);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('handles concurrency >= total (all items start at once)', () => {
    const started: number[] = [];
    const settlers: Array<() => void> = [];
    const done = jest.fn();

    makeConcurrentPool(3, 10, (idx, settle) => {
      started.push(idx);
      settlers.push(settle);
    }, done).start();

    // All 3 items started immediately.
    expect(started).toEqual([0, 1, 2]);
    expect(done).not.toHaveBeenCalled();

    settlers.forEach(s => s());
    expect(done).toHaveBeenCalledTimes(1);
  });

  // ── Async work simulation ──────────────────────────────────────────────────

  it('works correctly with asynchronous work items (Promise-based)', async () => {
    const completionOrder: number[] = [];
    const onAllDone = jest.fn();

    const delays = [30, 10, 20, 5]; // ms; item 3 finishes first, then 1, 2, 0

    await new Promise<void>(resolve => {
      makeConcurrentPool(4, 2, (idx, settle) => {
        setTimeout(() => {
          completionOrder.push(idx);
          settle();
          if (completionOrder.length === 4) resolve();
        }, delays[idx]);
      }, onAllDone).start();
    });

    expect(onAllDone).toHaveBeenCalledTimes(1);
    expect(completionOrder).toHaveLength(4);
    // All four indices must appear exactly once (order may vary).
    expect(completionOrder.slice().sort()).toEqual([0, 1, 2, 3]);
  });

  it('start() is idempotent: calling it twice does not double-dispatch', () => {
    const started: number[] = [];
    const pool = makeConcurrentPool(3, 1, (idx, settle) => {
      started.push(idx);
      settle();
    }, jest.fn());

    pool.start();
    pool.start(); // second call: nextIdx is already past the end, pump is a no-op

    expect(started).toHaveLength(3); // still just 3, not 6
  });
});

// ─── computeEtaSeconds ───────────────────────────────────────────────────────

describe('computeEtaSeconds()', () => {

  it('returns null when elapsedMs < 1000 (not enough data yet)', () => {
    expect(computeEtaSeconds(500_000, 10_000_000, 500)).toBeNull();
    expect(computeEtaSeconds(1_000_000, 10_000_000, 999)).toBeNull();
  });

  it('returns null when doneBytes === 0', () => {
    expect(computeEtaSeconds(0, 10_000_000, 5000)).toBeNull();
  });

  it('returns 0 when all bytes are already done', () => {
    const eta = computeEtaSeconds(10_000_000, 10_000_000, 5000);
    expect(eta).toBe(0);
  });

  it('estimates correctly: 50 % done after 10 s → ~10 s remaining', () => {
    // 5 MB done in 10 000 ms → rate = 500 B/ms = 500 000 B/s
    // 5 MB remaining → 10 s
    const eta = computeEtaSeconds(5_000_000, 10_000_000, 10_000);
    expect(eta).toBeCloseTo(10, 1);
  });

  it('estimates correctly: 10 % done after 5 s → ~45 s remaining', () => {
    // 1 MB done in 5 000 ms → rate = 200 B/ms = 200 000 B/s
    // 9 MB remaining → 45 s
    const eta = computeEtaSeconds(1_000_000, 10_000_000, 5_000);
    expect(eta).toBeCloseTo(45, 1);
  });

  it('returns a non-negative number even when done > total (rounding edge case)', () => {
    const eta = computeEtaSeconds(10_000_001, 10_000_000, 5000);
    expect(eta).toBeGreaterThanOrEqual(0);
  });

  it('handles very fast transfers without dividing by zero', () => {
    // 10 MB done in exactly 1 000 ms
    const eta = computeEtaSeconds(10_000_000, 10_000_000, 1_000);
    expect(eta).toBe(0);
  });
});

// ─── formatEtaText ───────────────────────────────────────────────────────────

describe('formatEtaText()', () => {

  it('returns bilingual "Calculating" for null input', () => {
    expect(formatEtaText(null)).toBe('Calculating… / 计算中…');
  });

  it('returns bilingual "Almost done" for 0 seconds', () => {
    expect(formatEtaText(0)).toBe('Almost done… / 即将完成…');
  });

  it('returns bilingual "Almost done" for values ≤ 3 s', () => {
    expect(formatEtaText(1)).toBe('Almost done… / 即将完成…');
    expect(formatEtaText(3)).toBe('Almost done… / 即将完成…');
  });

  it('returns seconds-only format for < 60 s', () => {
    expect(formatEtaText(4)).toBe('~4 sec remaining  /  约 4 秒');
    expect(formatEtaText(45)).toBe('~45 sec remaining  /  约 45 秒');
    expect(formatEtaText(59)).toBe('~59 sec remaining  /  约 59 秒');
  });

  it('returns minutes+seconds format for ≥ 60 s', () => {
    expect(formatEtaText(60)).toBe('~1 min 0 sec remaining  /  约 1 分 0 秒');
    expect(formatEtaText(90)).toBe('~1 min 30 sec remaining  /  约 1 分 30 秒');
    expect(formatEtaText(185)).toBe('~3 min 5 sec remaining  /  约 3 分 5 秒');
  });

  it('ceil()s sub-second remainders into the seconds field', () => {
    // 61.4 s → m=1, s=ceil(1.4)=2
    expect(formatEtaText(61.4)).toBe('~1 min 2 sec remaining  /  约 1 分 2 秒');
  });

  it('handles exactly 60 minutes', () => {
    expect(formatEtaText(3600)).toBe('~60 min 0 sec remaining  /  约 60 分 0 秒');
  });
});
