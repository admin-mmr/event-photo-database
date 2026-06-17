/**
 * userData.ts — "delete my data" / consent-revoke cascade (dev plan M5.2; PRD
 * §8.1, §8.5). Erases everything Find Me has stored for a single user:
 *
 *   - find_me_uploads  (Firestore record + the reference selfie's GCS object)
 *   - consents         (the consent records they granted)
 *   - match_runs       (search history that feeds the eval loop)
 *   - match_feedback   (their "that's me / not me" votes)
 *
 * A single `data_deleted` audit record is written to `consents` AFTER the purge
 * so a tamper-evident trace of the erasure survives (M5.5 audit logging). All
 * deletes are scoped to the caller's uid — there is no cross-user path.
 */

import type { Firestore, Query, QueryDocumentSnapshot } from '@google-cloud/firestore';
import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/config.js';
import { deleteReferenceObject } from './gcsService.js';

/** Firestore caps a write batch at 500 ops; stay safely under it. */
const BATCH_LIMIT = 400;

export interface DeletionCounts {
  references: number;
  consents: number;
  matchRuns: number;
  feedback: number;
}

async function docsForUser(db: Firestore, collection: string, uid: string): Promise<QueryDocumentSnapshot[]> {
  const q: Query = db.collection(collection).where('uid', '==', uid);
  const snap = await q.get();
  return snap.docs;
}

async function deleteInBatches(db: Firestore, docs: QueryDocumentSnapshot[]): Promise<number> {
  for (let i = 0; i < docs.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const d of docs.slice(i, i + BATCH_LIMIT)) batch.delete(d.ref);
    await batch.commit();
  }
  return docs.length;
}

/**
 * Purge all of a user's Find Me data. Reference GCS objects are removed first
 * (best-effort, non-fatal per object) so a failure there can't strand the
 * Firestore cleanup. Returns the per-collection deletion counts.
 */
export async function deleteAllUserData(uid: string, email: string | null): Promise<DeletionCounts> {
  const db = firestore();

  // 1. Reference selfies: delete each GCS object, then the records.
  const refDocs = await docsForUser(db, 'find_me_uploads', uid);
  for (const doc of refDocs) {
    const gcsPath = (doc.data() as { gcsPath?: string }).gcsPath;
    if (!gcsPath) continue;
    try {
      await deleteReferenceObject(gcsPath);
    } catch (err) {
      logger.warn({ err, uid, docId: doc.id }, 'reference object delete failed (continuing)');
    }
  }
  const references = await deleteInBatches(db, refDocs);

  // 2. The remaining user-scoped collections.
  const [consentDocs, runDocs, feedbackDocs] = await Promise.all([
    docsForUser(db, 'consents', uid),
    docsForUser(db, 'match_runs', uid),
    docsForUser(db, 'match_feedback', uid),
  ]);
  const consents = await deleteInBatches(db, consentDocs);
  const matchRuns = await deleteInBatches(db, runDocs);
  const feedback = await deleteInBatches(db, feedbackDocs);

  const counts: DeletionCounts = { references, consents, matchRuns, feedback };

  // 3. Audit record — written after the purge so it survives the erasure.
  await db.collection('consents').add({
    uid,
    email,
    action: 'data_deleted',
    policyVersion: env.CONSENT_POLICY_VERSION,
    deletedCounts: counts,
    createdAt: new Date().toISOString(),
  });

  return counts;
}
