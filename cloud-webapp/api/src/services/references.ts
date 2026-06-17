/**
 * references.ts — Firestore CRUD for `find_me_uploads` (PRD §6.2), the records
 * that let a signed-in member reuse a past reference selfie to search a new
 * event (D7 / FR-10b).
 *
 * One doc per stored reference, keyed by `uploadId`. Listing is scoped to the
 * owning uid (self-service only — a user can never see another person's
 * uploads, PRD §8.1) and filters out expired records in memory so we need only
 * a single-field index on `uid` (no composite index).
 */

import { firestore } from '../lib/firestore.js';

export interface ReferenceRecord {
  uploadId: string;
  uid: string;
  /** Event the reference was first uploaded for (provenance only — it can be
   *  reused against any event). */
  eventId: string;
  gcsPath: string;
  contentType: string;
  /** Search mode that succeeded ('fused' = a usable face; 'person' = outfit). */
  mode: 'fused' | 'person';
  subjectIsMinor: boolean;
  createdAt: string;
  /** ISO timestamp after which this reference is eligible for deletion. */
  expiresAt: string;
}

const COLLECTION = 'find_me_uploads';

export async function createReference(rec: ReferenceRecord): Promise<void> {
  await firestore().collection(COLLECTION).doc(rec.uploadId).set(rec);
}

export async function getReference(uploadId: string): Promise<ReferenceRecord | null> {
  const doc = await firestore().collection(COLLECTION).doc(uploadId).get();
  return doc.exists ? (doc.data() as ReferenceRecord) : null;
}

/** Delete a reference record (My Data self-service delete, M3.4). Caller is
 *  responsible for authorizing ownership and for removing the GCS object. */
export async function deleteReference(uploadId: string): Promise<void> {
  await firestore().collection(COLLECTION).doc(uploadId).delete();
}

/**
 * The user's non-expired references, newest first (capped). Filtering/sorting
 * in memory keeps this on a single-field `uid` index.
 */
export async function listReferencesForUser(
  uid: string,
  now: Date = new Date(),
  limit = 50,
): Promise<ReferenceRecord[]> {
  const snap = await firestore().collection(COLLECTION).where('uid', '==', uid).get();
  const nowIso = now.toISOString();
  return snap.docs
    .map((d) => d.data() as ReferenceRecord)
    .filter((r) => !r.expiresAt || r.expiresAt > nowIso)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}
