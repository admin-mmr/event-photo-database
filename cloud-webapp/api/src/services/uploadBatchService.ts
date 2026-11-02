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
  /** Set on a COPY CHUNK: the volunteer session (client batchId) it belongs to. */
  parentBatchId?: string;
  /** Set on a SESSION doc whose files are copied as chunks (see uploadChunks.ts). */
  chunked?: boolean;
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
 * Create the SESSION doc of a chunked upload once, and return the Drive batch
 * folder name it holds. Every /complete call of one session (the page flushes
 * every ~100 files) and every copy chunk must land in ONE folder, but
 * `buildBatchFolderName` stamps the current time — so the first caller's name
 * wins, transactionally, and later callers adopt it. A legacy doc (un-chunked)
 * keeps its name. Best-effort: on a Firestore failure the proposal is used.
 */
export async function claimSessionBatch(
  batchId: string,
  eventId: string,
  linkId: string,
  proposedFolderName: string,
): Promise<string> {
  try {
    const ref = firestore().collection(COLLECTION).doc(batchId);
    return await firestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.exists ? (snap.data() as UploadBatchDoc) : null;
      if (existing?.batchFolderName) return existing.batchFolderName;
      const now = new Date().toISOString();
      tx.set(
        ref,
        existing
          ? { batchFolderName: proposedFolderName, chunked: true, updatedAt: now }
          : {
              batchId,
              eventId,
              linkId,
              phase: 'received',
              total: 0,
              copied: 0,
              skippedDuplicates: 0,
              skippedDuplicateNames: [],
              failed: 0,
              batchFolderName: proposedFolderName,
              chunked: true,
              createdAt: now,
              updatedAt: now,
            },
        { merge: true },
      );
      return proposedFolderName;
    });
  } catch (err) {
    logger.warn({ err, batchId }, 'session batch claim failed (non-fatal; using the proposed folder name)');
    return proposedFolderName;
  }
}

/**
 * Create a copy chunk's doc if it does not exist yet, pre-seeded with the
 * session's folder name: `enqueueStagedBatch` reads `batchFolderName` from its
 * own doc before copying, so every chunk resumes the SAME folder. Create-only,
 * because a repeated /complete (a client retry) must not reset a chunk the
 * worker has already advanced. Best-effort.
 */
export async function seedChunkBatch(
  chunkId: string,
  parentBatchId: string,
  eventId: string,
  linkId: string,
  total: number,
  batchFolderName: string,
): Promise<void> {
  try {
    const ref = firestore().collection(COLLECTION).doc(chunkId);
    if ((await ref.get()).exists) return;
    const now = new Date().toISOString();
    await ref.set({
      batchId: chunkId,
      parentBatchId,
      eventId,
      linkId,
      phase: 'received',
      total,
      copied: 0,
      skippedDuplicates: 0,
      skippedDuplicateNames: [],
      failed: 0,
      batchFolderName,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    logger.warn({ err, chunkId, parentBatchId }, 'copy chunk seed failed (non-fatal)');
  }
}

/** Phases that mean "still copying": any such chunk keeps the session there. */
const IN_PROGRESS: ReadonlySet<UploadBatchPhase> = new Set<UploadBatchPhase>(['received', 'saving']);

/** One phase for a session from its chunks' phases. */
export function combinePhases(phases: ReadonlyArray<UploadBatchPhase>): UploadBatchPhase {
  if (phases.length === 0) return 'received';
  if (phases.every((p) => p === 'received')) return 'received';
  if (phases.some((p) => IN_PROGRESS.has(p))) return 'saving';
  if (phases.some((p) => p === 'indexing')) return 'indexing';
  if (phases.every((p) => p === 'ready')) return 'ready';
  if (phases.some((p) => p === 'error')) return 'error';
  return 'done';
}

/**
 * The status the upload page polls: the doc itself, or — for a chunked session —
 * the session summed over its copy chunks. Errors propagate (read path).
 */
export async function getUploadBatchStatus(batchId: string): Promise<UploadBatchDoc | null> {
  const session = await getUploadBatch(batchId);
  if (!session?.chunked) return session;
  const snap = await firestore().collection(COLLECTION).where('parentBatchId', '==', batchId).get();
  const parts = snap.docs.map((d) => d.data() as UploadBatchDoc);
  if (parts.length === 0) return session;
  const sum = (k: 'total' | 'copied' | 'skippedDuplicates' | 'failed') =>
    parts.reduce((a, p) => a + (Number(p[k]) || 0), 0);
  return {
    ...session,
    phase: combinePhases(parts.map((p) => p.phase)),
    total: sum('total'),
    copied: sum('copied'),
    skippedDuplicates: sum('skippedDuplicates'),
    skippedDuplicateNames: parts.flatMap((p) => p.skippedDuplicateNames ?? []),
    failed: sum('failed'),
    updatedAt: parts.reduce((a, p) => (p.updatedAt > a ? p.updatedAt : a), session.updatedAt),
  };
}
