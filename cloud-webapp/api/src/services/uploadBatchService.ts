/**
 * uploadBatchService.ts — observable status for a volunteer upload batch.
 *
 * Writes a `upload_batches/{batchId}` Firestore doc as a batch moves through
 * saving (copying to Drive) → indexing (indexer triggered) → done. The public
 * upload page polls GET /api/volunteer/upload/status/:batchId to show the phase
 * without blocking on the slow Drive copy.
 *
 * Step 1 of UPLOAD_ASYNC_QUEUE_DESIGN.md: the copy is still synchronous in
 * /complete, but the pipeline is now observable. When the copy moves to a
 * background worker (step 3), the worker advances the SAME doc through the same
 * phases and the client polling is unchanged.
 *
 * Writes are BEST-EFFORT: status tracking must never fail an upload whose bytes
 * are safely staged. init/update swallow + log errors. Reads (for the endpoint)
 * surface errors normally.
 */

import type { UploadBatchPhase } from '@cloud-webapp/shared';
// (UploadBatchPhase includes 'received' for the queued-but-not-yet-processed state.)

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';

const COLLECTION = 'upload_batches';

export interface UploadBatchDoc {
  batchId: string;
  eventId: string;
  linkId: string;
  phase: UploadBatchPhase;
  total: number;
  copied: number;
  skippedDuplicates: number;
  skippedDuplicateNames: string[];
  failed: number;
  batchFolderName: string;
  error?: string;
  /**
   * Set when staging recovery (the admin tool or the never-completed sweep)
   * re-dispatched this batch's staged objects under `<batchId>-recN` ids. Its
   * presence is what keeps the sweep from dispatching the same batch every tick.
   */
  recoveryDispatchedAt?: string;
  /** Objects that recovery dispatched (0 = it looked and nothing was owed). */
  recoveryObjects?: number;
  /** Why recovery could not dispatch the batch, when it could not. */
  recoverySkipped?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create the batch doc. Defaults to phase `saving` (inline path); the async
 * dispatch path passes `received` (queued, not yet processed). Best-effort.
 *
 * A RE-INIT (the Cloud Tasks retry of a batch that already ran) resets the
 * per-attempt counters but MUST NOT touch `batchFolderName` or `createdAt`: the
 * folder name is how a retry finds and resumes the folder its dead predecessor
 * created instead of minting a second one beside it, and blanking it here was
 * enough to reintroduce duplicate batch folders on its own.
 */
export async function initUploadBatch(
  batchId: string,
  eventId: string,
  linkId: string,
  total: number,
  phase: UploadBatchPhase = 'saving',
): Promise<void> {
  const now = new Date().toISOString();
  const perAttempt = {
    batchId,
    eventId,
    linkId,
    phase,
    total,
    copied: 0,
    skippedDuplicates: 0,
    skippedDuplicateNames: [],
    failed: 0,
    updatedAt: now,
  };
  try {
    const ref = firestore().collection(COLLECTION).doc(batchId);
    const existing = await ref.get();
    await ref.set(
      existing.exists ? perAttempt : { ...perAttempt, batchFolderName: '', createdAt: now },
      { merge: true },
    );
  } catch (err) {
    logger.warn({ err, batchId }, 'upload batch init failed (non-fatal)');
  }
}

/** Merge a partial update + bump `updatedAt`. Best-effort. */
export async function updateUploadBatch(
  batchId: string,
  patch: Partial<Omit<UploadBatchDoc, 'batchId' | 'createdAt'>>,
): Promise<void> {
  try {
    await firestore()
      .collection(COLLECTION)
      .doc(batchId)
      .set({ ...patch, updatedAt: new Date().toISOString() }, { merge: true });
  } catch (err) {
    logger.warn({ err, batchId }, 'upload batch update failed (non-fatal)');
  }
}

/** Read the batch doc, or null when it doesn't exist. Errors propagate. */
export async function getUploadBatch(batchId: string): Promise<UploadBatchDoc | null> {
  const snap = await firestore().collection(COLLECTION).doc(batchId).get();
  return snap.exists ? (snap.data() as UploadBatchDoc) : null;
}

/**
 * True when ANY record says the upload pipeline has seen this batch: the
 * volunteer's own doc (written by `/complete`, the inline copy, or a recovery
 * marker) or the first recovery chunk's doc (`<batchId>-rec1`, written when that
 * worker starts — which covers recoveries dispatched before markers existed).
 *
 * This is the never-completed sweep's whole definition of "owned elsewhere", so
 * errors PROPAGATE: a failed read must not be mistaken for "no record" and get
 * a live batch re-dispatched.
 */
export async function hasUploadBatchRecord(batchId: string): Promise<boolean> {
  const col = firestore().collection(COLLECTION);
  if ((await col.doc(batchId).get()).exists) return true;
  return (await col.doc(`${batchId}-rec1`).get()).exists;
}

/**
 * Record that staging recovery has handled a batch, so the scheduled sweep does
 * not dispatch it again on its next tick.
 *
 * A batch that never reached `/complete` has no doc at all, so one is CREATED
 * (phase `received` — its bytes are queued for the worker). A batch that already
 * has one — the volunteer's own status doc — only gains the recovery fields:
 * its phase and counters belong to the original run and are never overwritten.
 *
 * Errors propagate so the caller can report them; a lost marker is not data
 * loss (the next tick re-dispatches, and the worker's md5 claim stops a second
 * copy), only wasted work.
 */
export async function markRecoveryDispatched(
  batchId: string,
  info: { eventId: string; linkId: string; objects: number; skipped?: string },
): Promise<void> {
  const ref = firestore().collection(COLLECTION).doc(batchId);
  const now = new Date().toISOString();
  const stamp = {
    recoveryDispatchedAt: now,
    recoveryObjects: info.objects,
    ...(info.skipped ? { recoverySkipped: info.skipped } : {}),
    updatedAt: now,
  };
  try {
    await ref.create({
      batchId,
      eventId: info.eventId,
      linkId: info.linkId,
      phase: 'received' satisfies UploadBatchPhase,
      total: info.objects,
      copied: 0,
      skippedDuplicates: 0,
      skippedDuplicateNames: [],
      failed: 0,
      batchFolderName: '',
      createdAt: now,
      ...stamp,
    });
  } catch {
    // Already exists (the volunteer's doc, or an earlier marker): add the
    // recovery fields only. A genuine store failure throws again here.
    await ref.set(stamp, { merge: true });
  }
}
