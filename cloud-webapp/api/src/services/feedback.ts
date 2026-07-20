/**
 * feedback.ts — reads over the `match_feedback` collection.
 *
 * Writes stay inline in routes/feedback.ts (one immutable doc per vote); this
 * module holds the reads that other features need — currently pseudo-relevance
 * feedback (FACE_RECOGNITION_IMPROVEMENT_ANALYSIS §1.2), which folds a user's
 * own confirmed matches back into their next query for the same event.
 */

import { firestore } from '../lib/firestore.js';

/**
 * The photoIds this user has confirmed ("that's me") for `eventId`, de-duped.
 *
 * Scoped to the caller's own uid — one member's confirmations never leak into
 * another's query. We filter `eventId`/`verdict` in memory over the single
 * `uid` equality (Firestore auto-indexes single fields, so no composite index
 * is needed — same pattern as references.ts / userData.ts). `cap` bounds how
 * many references PRF folds in; the most recent confirmations win.
 */
export async function confirmedPhotoIdsForUser(
  uid: string,
  eventId: string,
  cap = 25,
): Promise<string[]> {
  const snap = await firestore().collection('match_feedback').where('uid', '==', uid).get();
  const rows = snap.docs
    .map((d) => d.data())
    .filter((d) => d.eventId === eventId && d.verdict === 'confirmed' && typeof d.photoId === 'string')
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));

  const seen = new Set<string>();
  for (const r of rows) {
    seen.add(r.photoId as string);
    if (seen.size >= cap) break;
  }
  return [...seen];
}
