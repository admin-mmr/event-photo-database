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
   * Per-chunk tallies for a batch the worker splits across Cloud Tasks (see
   * `enqueueStagedBatch`'s `chunk` option), keyed by chunk index. Each chunk
   * overwrites only its own entry, so a retried chunk replaces its tally rather
   * than adding to it; the batch's `copied`/`skippedDuplicates`/`failed` are the
   * sum. Absent for a batch that ran in one piece.
   */
  chunks?: Record<string, BatchChunkTally>;
  /**
   * Cloud Tasks task that currently owns this batch (the original dispatch, or
   * the continuation of a chunked batch); `''` once the last chunk finished.
   * The recovery sweep asks the queue whether it still exists, which is how it
   * tells a batch still being worked on from one whose chain died.
   */
  pendingTask?: string;
  /** When the recovery sweep last re-dispatched this batch's stranded objects. */
  lastRecoveryAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** What one chunk of a batch did. */
export interface BatchChunkTally {
  copied: number;
  copiedBytes: number;
  skippedDuplicates: number;
  skippedDuplicateNames: string[];
  failed: number;
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
 * Record what chunk `chunk` of a batch did and return the batch-wide totals.
 *
 * Read-modify-write of the whole `chunks` map rather than a nested-field merge:
 * the Cosmos port and the test double both treat a merge as shallow, and chunks
 * of one batch never overlap (each continuation is enqueued only after its
 * predecessor finished), so there is no concurrent writer to race. Best-effort
 * like every other status write: on failure the caller still gets this chunk's
 * own tally, which under-reports rather than failing an upload whose bytes are
 * safely in Drive.
 */
export async function recordChunkTally(
  batchId: string,
  chunk: number,
  tally: BatchChunkTally,
): Promise<BatchChunkTally> {
  try {
    const chunks = { ...((await getUploadBatch(batchId))?.chunks ?? {}), [String(chunk)]: tally };
    await updateUploadBatch(batchId, { chunks });
    return sumChunkTallies(Object.values(chunks));
  } catch (err) {
    logger.warn({ err, batchId, chunk }, 'upload batch chunk tally failed (non-fatal)');
    return tally;
  }
}

/** Batch-wide totals across chunk tallies. */
export function sumChunkTallies(tallies: ReadonlyArray<BatchChunkTally>): BatchChunkTally {
  const out: BatchChunkTally = { copied: 0, copiedBytes: 0, skippedDuplicates: 0, skippedDuplicateNames: [], failed: 0 };
  for (const t of tallies) {
    out.copied += t.copied;
    out.copiedBytes += t.copiedBytes;
    out.skippedDuplicates += t.skippedDuplicates;
    out.skippedDuplicateNames.push(...t.skippedDuplicateNames);
    out.failed += t.failed;
  }
  return out;
}
