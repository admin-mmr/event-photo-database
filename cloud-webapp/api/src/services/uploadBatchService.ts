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
  createdAt: string;
  updatedAt: string;
}

/** Create the batch doc. Defaults to phase `saving` (inline path); the async
 *  dispatch path passes `received` (queued, not yet processed). Best-effort. */
export async function initUploadBatch(
  batchId: string,
  eventId: string,
  linkId: string,
  total: number,
  phase: UploadBatchPhase = 'saving',
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await firestore()
      .collection(COLLECTION)
      .doc(batchId)
      .set(
        {
          batchId,
          eventId,
          linkId,
          phase,
          total,
          copied: 0,
          skippedDuplicates: 0,
          skippedDuplicateNames: [],
          failed: 0,
          batchFolderName: '',
          createdAt: now,
          updatedAt: now,
        },
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
