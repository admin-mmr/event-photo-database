/**
 * warmRetry.ts — retry a Find-Me search once when the matcher is still warming up.
 *
 * The matcher scales to zero, and the first search after a quiet spell waits for
 * it to load the whole event store. The api stops waiting before Firebase
 * Hosting's 60s cutoff and answers 429 `matcher_warming_up` (it keeps nothing
 * from that attempt); the matcher keeps loading, so a retry a few seconds later
 * finds it ready. On 2026-11-04 12:27 the user had to do that retry by hand,
 * after an opaque "search failed".
 */

import { ApiError } from './api.js';

export const MATCHER_WARMING_UP = 'matcher_warming_up';

const DEFAULT_WAIT_SEC = 3;

export function isWarmingUp(err: unknown): err is ApiError {
  // 429 since 2026-11-09 (a 5xx paged via Cloud Run's request log); 503 from
  // an api deployed before that.
  return err instanceof ApiError && (err.status === 429 || err.status === 503) && err.code === MATCHER_WARMING_UP;
}

/**
 * Run `attempt`; if the api says the matcher is warming up, call `onWait`, wait
 * the api's `retryAfterSec`, and run it ONCE more. `attempt` is called afresh,
 * so anything single-use (a reCAPTCHA token) must be obtained inside it.
 */
export async function retryWhileWarming<T>(
  attempt: () => Promise<T>,
  opts: { onWait?: () => void; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (!isWarmingUp(err)) throw err;
    opts.onWait?.();
    const sec = typeof err.body.retryAfterSec === 'number' ? err.body.retryAfterSec : DEFAULT_WAIT_SEC;
    await (opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(Math.max(0, sec) * 1000);
    return attempt();
  }
}
