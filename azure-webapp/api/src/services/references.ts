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
  /** Search mode that succeeded ('fused' = a usable face; 'person' = outfit),
   *  or null when the search FAILED (e.g. no usable face). We now keep failed
   *  selfies too so admins can reproduce reported issues — only matched ones are
   *  offered back to the user for reuse. */
  mode: 'fused' | 'person' | null;
  /** Outcome of the search this selfie was uploaded for: 'matched' or the
   *  matcher error code reproduced (e.g. 'no_usable_face', 'event_not_indexed').
   *  Older records predate this field; treat a missing value as 'matched'. */
  outcome?: string;
  /** Searcher-provided display name captured at search time (required going
   *  forward; null on older records). */
  name?: string | null;
  /** Account email if signed in; null for anonymous guests / older records. */
  email?: string | null;
  subjectIsMinor: boolean;
  createdAt: string;
  /** ISO timestamp after which this reference is eligible for deletion. */
  expiresAt: string;
}

const COLLECTION = 'find_me_uploads';

/** Treat a record with no recorded outcome (pre-change) as a successful match. */
function effectiveOutcome(r: ReferenceRecord): string {
  return r.outcome ?? 'matched';
}

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
 * The user's non-expired, REUSABLE references, newest first (capped). Only
 * selfies whose search actually matched (a real face/outfit signal) are offered
 * back for reuse — failed/no-face selfies are kept for admin repro but would be
 * useless (and confusing) to re-run. Filtering/sorting in memory keeps this on a
 * single-field `uid` index.
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
    .filter((r) => effectiveOutcome(r) === 'matched' && r.mode !== null)
    .filter((r) => !r.expiresAt || r.expiresAt > nowIso)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

/** Hard cap on the window an admin scan reads, to bound cost/latency. */
const ADMIN_SCAN_LIMIT = 500;

export interface AdminReferenceFilter {
  uid?: string;
  /** Case-insensitive exact match on the recorded account email. */
  email?: string;
  eventId?: string;
  /** e.g. 'matched' | 'no_usable_face' | 'event_not_indexed'. */
  outcome?: string;
  limit?: number;
}

/**
 * Cross-user reference listing for the admin repro tooling. Ordered by
 * `createdAt` desc (single-field index, no composite needed) over a bounded
 * window, with filters applied in memory — mirrors the admin feedback queue.
 * This is the ONLY path that returns another user's uploads, and it is gated by
 * requireAdmin + audited at the route.
 */
export async function listAllReferences(
  filter: AdminReferenceFilter = {},
): Promise<ReferenceRecord[]> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), ADMIN_SCAN_LIMIT);
  const snap = await firestore()
    .collection(COLLECTION)
    .orderBy('createdAt', 'desc')
    .limit(ADMIN_SCAN_LIMIT)
    .get();
  let recs = snap.docs.map((d) => d.data() as ReferenceRecord);
  if (filter.uid) recs = recs.filter((r) => r.uid === filter.uid);
  if (filter.email) {
    const wanted = filter.email.toLowerCase();
    recs = recs.filter((r) => (r.email ?? '').toLowerCase() === wanted);
  }
  if (filter.eventId) recs = recs.filter((r) => r.eventId === filter.eventId);
  if (filter.outcome) recs = recs.filter((r) => effectiveOutcome(r) === filter.outcome);
  return recs.slice(0, limit);
}
