/**
 * driveRateLimit.ts — process-wide pacing + retry for Google Drive calls.
 *
 * Why this exists
 * ───────────────
 * Every Drive call the app makes is impersonated as the SAME domain-wide-
 * delegation subject (env.DWD_SUBJECT), so they all draw from ONE user's Drive
 * quota — the same gotcha the Upload_Links cache guards against for Sheets. The
 * managed-folders rebuild is bursty (walk listings, per-photo copy/convert,
 * shortcut creates, permission grants), and async `fetch` would happily fire
 * them all at once. A burst trips `403 rateLimitExceeded` /
 * `403 userRateLimitExceeded` / `429`, and the rebuild fails mid-flight.
 *
 * Two defences, both applied by `driveFetch`:
 *
 *   1. PACING — calls are scheduled at least `DRIVE_MIN_INTERVAL_MS` apart
 *      (default 120 ms ≈ 8 req/s), well under Drive's per-user limit, so a
 *      steady rebuild never bursts. The gate is a single module-global promise
 *      chain, so it paces ALL Drive work in the process, not just one rebuild.
 *
 *   2. BACKOFF — on `429`, `403` whose body names a rate-limit reason, or any
 *      `5xx`, the call is retried with exponential backoff + jitter (honouring
 *      a `Retry-After` header when present), up to `DRIVE_MAX_RETRIES` times.
 *      This is Google's recommended handling for rateLimitExceeded /
 *      userRateLimitExceeded. After the last retry the raw response is returned
 *      so the caller's existing error handling still runs.
 *
 * Tunables (env): DRIVE_MIN_INTERVAL_MS, DRIVE_MAX_RETRIES, DRIVE_BACKOFF_CAP_MS.
 */

import { logger } from '../lib/logger.js';

const MIN_INTERVAL_MS = Math.max(0, Number(process.env.DRIVE_MIN_INTERVAL_MS ?? 120));
const MAX_RETRIES = Math.max(0, Number(process.env.DRIVE_MAX_RETRIES ?? 6));
const BACKOFF_CAP_MS = Math.max(1000, Number(process.env.DRIVE_BACKOFF_CAP_MS ?? 32_000));

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Pacing gate ─────────────────────────────────────────────────────────────
// Serialise the SCHEDULING of calls (not their full duration) so each starts at
// least MIN_INTERVAL_MS after the previous one. fetches still overlap in flight,
// but the start-rate is bounded — enough to stay under the per-user quota.
let gate: Promise<void> = Promise.resolve();
let lastStart = 0;

function reserveSlot(): Promise<void> {
  const next = gate.then(async () => {
    const wait = Math.max(0, lastStart + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
  });
  // Keep the chain alive even if a waiter rejects (it won't here, but be safe).
  gate = next.catch(() => undefined);
  return next;
}

/** Test-only: reset the pacing gate between cases. */
export function __resetDrivePacing(): void {
  gate = Promise.resolve();
  lastStart = 0;
}

// ── Retry classification ─────────────────────────────────────────────────────

const RATE_LIMIT_REASONS = ['ratelimitexceeded', 'userratelimitexceeded', 'rate_limit', 'rate limit'];

async function isRateLimited403(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().text()).toLowerCase();
    return RATE_LIMIT_REASONS.some((r) => body.includes(r));
  } catch {
    return false;
  }
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const headerSec = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(headerSec) && headerSec >= 0) return Math.min(BACKOFF_CAP_MS, headerSec * 1000);
  const base = Math.min(BACKOFF_CAP_MS, 1000 * 2 ** attempt);
  return base + Math.floor(Math.random() * 1000); // full jitter
}

/**
 * Drive-aware `fetch`: paces every call and retries on transient throttling /
 * server errors. Drop-in replacement for `fetch` in the Drive REST clients.
 * `ctx` is a short label used only for logging a retry.
 */
export async function driveFetch(
  url: string,
  init: RequestInit,
  ctx = 'drive',
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    await reserveSlot();

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      const delay = retryDelayMs(attempt, null);
      logger.warn({ ctx, attempt, delay, err: String(err) }, 'drive fetch network error; backing off');
      await sleep(delay);
      continue;
    }

    const throttled =
      res.status === 429 ||
      res.status >= 500 ||
      (res.status === 403 && (await isRateLimited403(res)));

    if (!throttled || attempt >= MAX_RETRIES) return res;

    const delay = retryDelayMs(attempt, res.headers.get('retry-after'));
    logger.warn({ ctx, status: res.status, attempt, delay }, 'drive throttled; backing off');
    await sleep(delay);
  }
}
