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
 * another's query. We filter `eventId` in memory over the single `uid`
 * equality (Firestore auto-indexes single fields, so no composite index is
 * needed — same pattern as references.ts / userData.ts). `cap` bounds how many
 * references PRF folds in; the most recent confirmations win.
 *
 * Two rules decide what counts, because a wrong fold puts someone else's face
 * into the query:
 *  - **The latest vote on a photo wins.** Votes are immutable, so "that's me"
 *    followed by "not me" leaves both docs; only the second reflects the user.
 *  - **A friend or group tag is not a confirmation of the searcher.** Those keep
 *    the photo for the user, but the face in it is (or may be) somebody else.
 *    A vote with no reason predates reasons and meant "me".
 */
export async function confirmedPhotoIdsForUser(
  uid: string,
  eventId: string,
  cap = 25,
): Promise<string[]> {
  const snap = await firestore().collection('match_feedback').where('uid', '==', uid).get();
  const rows = snap.docs
    .map((d) => d.data())
    .filter((d) => d.eventId === eventId && typeof d.photoId === 'string')
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));

  const decided = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const photoId = r.photoId as string;
    if (decided.has(photoId)) continue; // an older vote on a photo already decided
    decided.add(photoId);
    const reason = r.reason ?? 'me';
    if (r.verdict === 'confirmed' && reason === 'me') out.push(photoId);
    if (out.length >= cap) break;
  }
  return out;
}
