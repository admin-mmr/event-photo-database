/**
 * storageLost.ts — Safari dropped its local database connection.
 *
 * WebKit (iOS and macOS Safari) can lose its IndexedDB connection after the tab
 * is backgrounded or the device sleeps, and only a reload restores it. Firebase
 * Auth keeps the session there, so from then on sign-in and token refreshes
 * reject with "Connection to Indexed Database server lost. Refresh the page to
 * try again." On 2026-11-04 one user hit it 19:49–21:26 on an iPhone and a Mac:
 * Google sign-in failed with "allow pop-ups" advice that could not help, and the
 * repeats paged at ERROR. It is the browser's fault and has one remedy, so the
 * app says "reload" instead of reporting it.
 */

/** Window event the App listens for to show the reload banner. */
export const STORAGE_LOST_EVENT = 'app:storage-lost';

export function isStorageLost(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String((err as { message?: unknown } | null)?.message ?? '');
  return /Indexed ?Database server lost/i.test(message);
}

/**
 * Why the page needs a reload: Safari lost its database (`storage`), or the api
 * rejected a request as signed-out (`session`). The second is what the first
 * usually looks like from the server: on 2026-11-08 an iPhone sent six requests
 * with no token at all — the token read failed and api.ts went on without one —
 * and the user just saw searches fail.
 */
export type LostReason = 'storage' | 'session';

/** Tell the App to show its "reload the page" banner. */
export function announceStorageLost(reason: LostReason = 'storage'): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(STORAGE_LOST_EVENT, { detail: { reason } }));
}

/** The reason an event carries; `storage` for one without (older senders). */
export function lostReasonOf(e: Event): LostReason {
  return (e as CustomEvent<{ reason?: LostReason }>).detail?.reason === 'session' ? 'session' : 'storage';
}
