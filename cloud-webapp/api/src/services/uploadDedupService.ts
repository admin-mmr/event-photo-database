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

/**
 * How long an unstamped claim is respected before another worker may take it.
 *
 * A claim is created BEFORE the copy and stamped with `driveFileId` only AFTER
 * it succeeds, so an unstamped claim means "someone is copying this right now".
 * That is true only while their request is alive — and a request cannot outlive
 * the Cloud Run timeout (1800s). Past that, the holder is definitively gone.
 *
 * WHY THIS EXISTS: on 2026-07-27 the api was deployed with a 60s timeout, so the
 * upload worker was KILLED mid-batch. A kill runs no catch block, so
 * `releaseUploadedFile` never ran and the claim was stranded forever — and every
 * later re-upload of those exact bytes was then silently skipped as a duplicate,
 * which is why the loss did not self-heal. Reclaiming a stale claim closes that
 * hole for good, independent of whatever the deployed timeout happens to be.
 */
const STALE_CLAIM_MS = 35 * 60 * 1000;

/** Milliseconds since a Firestore timestamp / Date / ISO string, or null. */
function ageMsOf(value: unknown): number | null {
  if (value == null) return null;
  const d =
    typeof (value as { toDate?: () => Date }).toDate === 'function'
      ? (value as { toDate: () => Date }).toDate()
      : value instanceof Date
        ? value
        : new Date(String(value));
  const t = d.getTime();
  return Number.isFinite(t) ? Date.now() - t : null;
}

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
    if (isAlreadyExists(err)) return reclaimIfStale(input);
    logger.warn(
      { err, eventId: input.eventId, name: input.name },
      'upload dedup claim failed — allowing the copy (fail open)',
    );
    return true;
  }
}

/**
 * The claim already exists. Decide whether it is a genuine duplicate or the
 * wreckage of a worker that died before it could produce a Drive file.
 *
 *   - stamped with `driveFileId`  → the bytes really are in Drive. Duplicate.
 *   - unstamped and recent        → another worker is copying it right now.
 *   - unstamped and older than    → its holder is gone (a request cannot outlive
 *     STALE_CLAIM_MS                the Cloud Run timeout). Take it over.
 *
 * The read-and-take runs in a transaction so two workers racing on the same
 * stale claim cannot both win it.
 */
async function reclaimIfStale(input: ClaimInput): Promise<boolean> {
  const ref = firestore().collection(UPLOAD_DEDUP_COLLECTION).doc(claimId(input.eventId, input.dedupKey));
  try {
    return await firestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      // Vanished between create() and here — nothing owns the key now.
      if (!snap.exists) return true;
      const data = snap.data() ?? {};
      if (data.driveFileId) return false;

      const age = ageMsOf(data.claimedAt);
      if (age === null || age < STALE_CLAIM_MS) return false;

      tx.update(ref, { claimedAt: new Date(), batchId: input.batchId, name: input.name, reclaimedFrom: data.batchId ?? '' });
      return true;
    }).then((won) => {
      if (won) {
        logger.warn(
          { eventId: input.eventId, name: input.name, batchId: input.batchId },
          'reclaimed a stale upload claim — its previous holder died before copying to Drive',
        );
      }
      return won;
    });
  } catch (err) {
    // Fail CLOSED here: we already know a claim exists, so the safe reading of an
    // unreadable one is "someone owns it" rather than risking a second copy.
    logger.warn({ err, eventId: input.eventId, name: input.name }, 'stale-claim check failed — treating as duplicate');
    return false;
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
