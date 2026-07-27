/**
 * uploadDedupService.ts — cross-batch duplicate suppression for volunteer
 * uploads.
 *
 * `enqueueStagedBatch` dedupes against a Drive listing snapshot taken once at
 * the START of a batch and updated only with that batch's own writes. Keying
 * that snapshot on content hash (see `gcsMd5ToHex`) fixed the cases where a
 * re-upload was renamed or re-credited, but it cannot fix the remaining one:
 * nothing serialises two batches for the same event. The Cloud Tasks queue
 * dispatches concurrently, so when one photographer uploads several overlapping
 * sessions minutes apart, each worker's snapshot predates the others' writes and
 * every overlapping photo is copied to Drive again. Drive keeps same-named
 * files, and each copy then multiplies into its own Photos_NNN and Album entry.
 *
 * A claim closes that window where a snapshot can't. Before copying, we
 * atomically `create()` one small Firestore doc keyed by (eventId, content
 * hash). `create()` fails if the doc exists, so exactly one worker can win a
 * given key no matter how many run at once. The listing snapshot stays as the
 * backstop for files that predate this collection.
 *
 * Fails OPEN on unexpected backend errors, matching the rest of the upload path
 * — a Firestore blip must not strand a volunteer's photos. It fails CLOSED only
 * on a genuine ALREADY_EXISTS, which is precisely the duplicate case.
 */

import { createHash } from 'node:crypto';

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';

/** Firestore collection holding one doc per copied file. */
export const UPLOAD_DEDUP_COLLECTION = 'upload_dedup';

/** gRPC status code Firestore returns when `create()` hits an existing doc. */
const ALREADY_EXISTS = 6;

export interface ClaimInput {
  eventId: string;
  /**
   * Content hash (lowercase hex MD5) when Drive/GCS gave us one, else the
   * `name|size` fallback key. Whatever the caller deduped the snapshot on —
   * keeping the two in step matters more than which one is used.
   */
  dedupKey: string;
  /** The credited name we are about to write, for logs and the release path. */
  name: string;
  batchId: string;
}

/** Doc id for a claim: hashed so it is always a legal, bounded Firestore id. */
export function claimId(eventId: string, dedupKey: string): string {
  return createHash('sha256').update(`${eventId}|${dedupKey}`).digest('hex').slice(0, 40);
}

function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === ALREADY_EXISTS || code === 'already-exists') return true;
  return /already exists/i.test(String((err as { message?: unknown } | null)?.message ?? ''));
}

/**
 * Try to take ownership of (eventId, dedupKey). Returns true when this caller
 * won and should copy the file, false when another batch already has it.
 *
 * Unexpected errors resolve to `true` (fail open) so a Firestore outage degrades
 * to the old snapshot-only behaviour instead of dropping uploads.
 */
export async function claimUploadedFile(input: ClaimInput): Promise<boolean> {
  try {
    await firestore()
      .collection(UPLOAD_DEDUP_COLLECTION)
      .doc(claimId(input.eventId, input.dedupKey))
      .create({
        eventId: input.eventId,
        dedupKey: input.dedupKey,
        name: input.name,
        batchId: input.batchId,
        claimedAt: new Date(),
      });
    return true;
  } catch (err) {
    if (isAlreadyExists(err)) return false;
    logger.warn(
      { err, eventId: input.eventId, name: input.name },
      'upload dedup claim failed — allowing the copy (fail open)',
    );
    return true;
  }
}

/**
 * Record which Drive file a claim produced, so an admin delete can release it —
 * otherwise the claim would permanently bar re-uploading a deleted photo.
 * Best-effort: a missed stamp only costs us that release path.
 */
export async function recordClaimTarget(input: ClaimInput, driveFileId: string): Promise<void> {
  try {
    await firestore()
      .collection(UPLOAD_DEDUP_COLLECTION)
      .doc(claimId(input.eventId, input.dedupKey))
      .set({ driveFileId }, { merge: true });
  } catch (err) {
    logger.warn({ err, driveFileId }, 'upload dedup target stamp failed (non-fatal)');
  }
}

/**
 * Give a claim back after a failed copy, so a file we never actually wrote is
 * not barred from the Cloud Tasks retry or a later re-upload.
 */
export async function releaseUploadedFile(input: ClaimInput): Promise<void> {
  try {
    await firestore()
      .collection(UPLOAD_DEDUP_COLLECTION)
      .doc(claimId(input.eventId, input.dedupKey))
      .delete();
  } catch (err) {
    logger.warn(
      { err, eventId: input.eventId, name: input.name },
      'upload dedup release failed (non-fatal)',
    );
  }
}

/**
 * Drop the claim(s) pointing at a Drive file that has just been deleted, so the
 * same photo can be uploaded again. Keyed on the `driveFileId` stamped by
 * {@link recordClaimTarget} — a single-field equality query, so no composite
 * index is needed. Best-effort; a failure only leaves a stale claim behind.
 */
export async function releaseClaimsForDriveFile(driveFileId: string): Promise<number> {
  if (!driveFileId) return 0;
  try {
    const snap = await firestore()
      .collection(UPLOAD_DEDUP_COLLECTION)
      .where('driveFileId', '==', driveFileId)
      .get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
    return snap.size;
  } catch (err) {
    logger.warn({ err, driveFileId }, 'upload dedup release-by-file failed (non-fatal)');
    return 0;
  }
}
