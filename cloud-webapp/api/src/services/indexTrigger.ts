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
 * Skipping is safe: photos copied while a run is in flight change the Drive
 * fingerprint, so the next index-scan tick (≤10 min) picks them up.
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
    if (isIndexInFlight(indexState)) return { claimed: false as const };
    tx.set(ref, { indexState: { status: 'queued', updatedAt: now } }, { merge: true });
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
      await ref.set({ indexState: restored }, { merge: true });
    } catch (releaseErr) {
      logger.warn({ err: releaseErr, eventId }, 'index claim release failed (index-scan will retry after the stale window)');
    }
    throw err;
  }
}
