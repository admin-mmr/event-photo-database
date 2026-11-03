/**
 * indexTrigger.ts — start the indexer for an event unless a run is already in
 * flight, claiming the slot atomically so concurrent callers can't both start.
 *
 * The volunteer upload worker used to call `triggerIndexJob` after EVERY batch
 * that copied a file, with no in-flight check. One batch at a time that was
 * harmless; with the upload queue running many batches concurrently (the NYC
 * Marathon, 2026-11-01) every finishing batch would stack another 8-vCPU
 * execution on the same event — all re-embedding the same new photos and
 * racing to write one manifest. index-scan and "Index now" already refuse to
 * stack; this gives the worker the same rule, plus a transactional claim
 * because unlike index-scan (one scheduler tick at a time) workers really do
 * finish simultaneously.
 *
 * Skipping is safe because a skip is RECORDED: the claim stamps
 * `indexPendingAt` on the event in the same transaction, and index-scan starts a
 * run for any event carrying it on its next tick (≤10 min), without walking
 * Drive. Starting a run clears it. It used to rely on index-scan noticing the
 * new photos by listing the whole event in Drive every tick — on the NYC
 * Marathon (27k photos) that was ~80s per tick, ~14,000s/day of api time, more
 * than the whole Cloud Run free tier, to find "no change" 106 times in 107.
 */

import { firestore } from '../lib/firestore.js';
import { isIndexInFlight } from '../lib/indexState.js';
import { logger } from '../lib/logger.js';
import { triggerIndexJob } from './indexerJob.js';

export type GuardedTriggerResult =
  | { triggered: true; execution: string }
  | { triggered: false; reason: 'already_running' };

export async function triggerIndexJobUnlessInFlight(eventId: string): Promise<GuardedTriggerResult> {
  const ref = firestore().collection('events').doc(eventId);
  const now = new Date().toISOString();

  // Claim: flip the state to `queued` only if nothing is in flight, inside a
  // transaction so two workers finishing together can't both win. The prior
  // state is kept so a failed trigger can hand the slot back.
  const prior = await firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const indexState = snap.data()?.indexState as Record<string, unknown> | undefined;
    if (isIndexInFlight(indexState)) {
      // A run was wanted but one is already going: owe another after it, since
      // the running one may have listed Drive before these changes landed.
      tx.set(ref, { indexPendingAt: now }, { merge: true });
      return { claimed: false as const };
    }
    // This run lists Drive after the claim, so it covers everything owed so far.
    tx.set(ref, { indexState: { status: 'queued', updatedAt: now }, indexPendingAt: null }, { merge: true });
    return { claimed: true as const, indexState };
  });

  if (!prior.claimed) return { triggered: false, reason: 'already_running' };

  try {
    const { execution } = await triggerIndexJob(eventId);
    return { triggered: true, execution };
  } catch (err) {
    // Release the claim, or the event would read as `queued` for the whole
    // staleness window and index-scan would skip it. Put the prior state back
    // verbatim; an event never indexed before has none, so record the failure
    // (`failed` is not in flight, so the next scan tick retries). Best-effort:
    // a failed release just means the scan waits out the window.
    try {
      const restored = prior.indexState
        ? prior.indexState
        : { status: 'failed', error: `index trigger failed: ${String((err as Error)?.message ?? err)}`, updatedAt: now };
      // The claim cleared any owed run; put it back so the next scan retries.
      await ref.set({ indexState: restored, indexPendingAt: now }, { merge: true });
    } catch (releaseErr) {
      logger.warn({ err: releaseErr, eventId }, 'index claim release failed (index-scan will retry after the stale window)');
    }
    throw err;
  }
}
