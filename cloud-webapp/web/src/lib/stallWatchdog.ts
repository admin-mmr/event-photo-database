/**
 * stallWatchdog.ts — give up on a network request that has gone silent.
 *
 * Neither XHR nor fetch has a timeout by default, so a connection that stalls
 * (venue wifi dropping, a phone backgrounding the tab, a half-open socket)
 * leaves its request pending FOREVER — no `onerror`, no rejection. In the upload
 * page that is not one lost file: the upload loop only calls /complete once
 * every file has settled, so one hung chunk keeps the whole session from ever
 * being saved. NYC Marathon night (2026-11-01) had five sessions — 1,550 photos,
 * one of them 1,088 — staged all but one or two files and never reached
 * /complete; the volunteers left, and the bytes sat in staging until an admin
 * recovered them.
 *
 * The watchdog measures SILENCE, not total time: an 8 MiB chunk on a slow link
 * can legitimately take minutes, but it reports upload progress every few
 * hundred ms while it does. A stall is reported as `StallError` — a retryable
 * failure — so the caller's backoff + resync loop handles it like any dropped
 * connection, and a user Cancel still surfaces as `AbortError`.
 */

/** No progress or response for this long ⇒ the request is dead. */
export const STALL_MS = 60_000;

export class StallError extends Error {
  constructor(what: string) {
    super(`${what} stalled (no response for ${Math.round(STALL_MS / 1000)}s)`);
    this.name = 'StallError';
  }
}

export interface XhrWatchdog {
  /** Call on every sign of life (upload progress) to restart the countdown. */
  touch(): void;
  /** Disarm once the request has settled. */
  stop(): void;
  /** True when the watchdog, not the caller, aborted the request. */
  readonly stalled: boolean;
}

/**
 * Arm a watchdog on `xhr`: abort it after `ms` without a `touch()`. The XHR's
 * own `onabort` fires either way, so it must check `stalled` to tell a stall
 * (retry) from a user Cancel (stop).
 */
export function watchXhr(xhr: Pick<XMLHttpRequest, 'abort'>, ms = STALL_MS): XhrWatchdog {
  let stalled = false;
  const fire = (): void => {
    stalled = true;
    xhr.abort();
  };
  let timer = setTimeout(fire, ms);
  return {
    touch() {
      clearTimeout(timer);
      timer = setTimeout(fire, ms);
    },
    stop() {
      clearTimeout(timer);
    },
    get stalled() {
      return stalled;
    },
  };
}

/**
 * A signal that aborts after `ms`, for fetch() calls that carry no progress.
 * (Hand-rolled rather than `AbortSignal.timeout` so older iOS Safari, which
 * many volunteers upload from, gets it too.) Call `clear()` once settled.
 */
export function timeoutSignal(ms = STALL_MS): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

/** fetch() that rejects with `StallError` instead of hanging past `ms`. */
export async function fetchWithStall(
  what: string,
  url: string,
  init: RequestInit = {},
  ms = STALL_MS,
): Promise<Response> {
  const t = timeoutSignal(ms);
  try {
    return await fetch(url, { ...init, signal: t.signal });
  } catch (err) {
    if (t.signal.aborted) throw new StallError(what);
    throw err;
  } finally {
    t.clear();
  }
}
