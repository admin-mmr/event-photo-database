/**
 * uploadPool.ts — Pure utilities for the volunteer photo upload pipeline.
 *
 * Design constraints (same pattern as exifStripper.ts):
 *   - Files uploaded directly from the browser to Drive; bytes never pass
 *     through GAS.  These helpers contain zero DOM / GAS / XHR dependencies
 *     so they can be unit-tested in Node without any mocks.
 *   - The browser copy in volunteer/upload.html is an inline duplicate kept
 *     in sync manually (GAS HTML templates cannot import TS modules at runtime).
 *
 * Exports
 *   makeConcurrentPool  — generic concurrency-limited work scheduler
 *   computeEtaSeconds   — bytes-based estimated time remaining (pure math)
 *   formatEtaText       — bilingual EN/ZH display string for ETA
 */

// ─── Concurrent upload pool ───────────────────────────────────────────────────

/**
 * A handle returned by makeConcurrentPool.
 * Call `start()` to kick off the first wave of work items.
 */
export interface PoolHandle {
  start(): void;
}

/**
 * Creates a concurrency-limited work pool for processing `total` items.
 *
 * Up to `concurrency` items run simultaneously.  When an item finishes, the
 * pool immediately dispatches the next queued item so the concurrency slot is
 * never left idle.
 *
 * `work(index, done)` — called for each item.  The caller MUST invoke `done()`
 *   exactly once when the item is finished (regardless of success/failure).
 *   Calling `done()` more than once per item produces undefined behaviour.
 *
 * `onAllDone()` — called exactly once after every item has settled.
 *
 * Edge cases:
 *   - total === 0 → `onAllDone()` is called synchronously on `start()`.
 *   - concurrency ≥ total → all items are dispatched immediately.
 *   - concurrency === 1 → strictly sequential (same as the old uploadNext loop).
 */
export function makeConcurrentPool(
  total: number,
  concurrency: number,
  work: (index: number, done: () => void) => void,
  onAllDone: () => void,
): PoolHandle {
  if (total <= 0) {
    return { start: () => onAllDone() };
  }

  let nextIdx    = 0;
  let activeCount = 0;
  let doneCount   = 0;

  function settle(): void {
    activeCount--;
    doneCount++;
    if (doneCount >= total) {
      onAllDone();
      return;
    }
    pump();
  }

  function pump(): void {
    while (activeCount < concurrency && nextIdx < total) {
      const idx = nextIdx++;
      activeCount++;
      work(idx, settle);
    }
  }

  return { start: pump };
}

// ─── ETA calculation ──────────────────────────────────────────────────────────

/**
 * Estimates seconds remaining based on bytes transferred so far.
 *
 * @param doneBytes   Bytes transferred (across all completed files).
 * @param totalBytes  Total bytes to transfer.
 * @param elapsedMs   Wall-clock milliseconds since the upload started.
 * @returns           Estimated seconds remaining, or `null` when there is not
 *                    yet enough data to produce a reliable estimate (< 1 s
 *                    elapsed, or no bytes counted yet).
 */
export function computeEtaSeconds(
  doneBytes: number,
  totalBytes: number,
  elapsedMs: number,
): number | null {
  if (elapsedMs < 1000 || doneBytes <= 0) return null;
  const rateBytesPerSec = doneBytes / (elapsedMs / 1000);
  const remaining = (totalBytes - doneBytes) / rateBytesPerSec;
  return Math.max(0, remaining);
}

/**
 * Formats an ETA value (in seconds) into a bilingual EN / ZH display string.
 *
 * @param seconds  Value from `computeEtaSeconds()`, or `null` while estimating.
 * @returns        Human-readable string suitable for an upload progress banner.
 *
 * Examples:
 *   null  → "Calculating… / 计算中…"
 *   2     → "Almost done… / 即将完成…"
 *   45    → "~45 sec remaining  /  约 45 秒"
 *   185   → "~3 min 5 sec remaining  /  约 3 分 5 秒"
 */
export function formatEtaText(seconds: number | null): string {
  if (seconds === null) return 'Calculating… / 计算中…';
  if (seconds <= 3)     return 'Almost done… / 即将完成…';

  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);

  if (m === 0) {
    return `~${s} sec remaining  /  约 ${s} 秒`;
  }
  return `~${m} min ${s} sec remaining  /  约 ${m} 分 ${s} 秒`;
}
