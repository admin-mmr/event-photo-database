/**
 * accountEmails.ts — resolve a member's email from Firebase Auth at READ time,
 * for the admin review screens (quality plan Item 23).
 *
 * Votes used to carry a copy of the member's email on every `match_feedback`
 * doc — thousands of copies of personal data that exist only so an admin table
 * can show a name. New votes store the uid alone; the admin routes look the
 * email up here. Older votes still hold their copy and it is used as-is.
 *
 * Needs `roles/firebaseauth.viewer` on the api's runtime SA (`api-runtime@`);
 * verifying an ID token does not. Every failure degrades to "unknown" — an
 * admin table that shows a uid instead of an email is fine, one that 500s is
 * not.
 */

import { getAuth } from 'firebase-admin/auth';

import { logger } from '../lib/logger.js';

/** Firebase Auth's getUsers() limit per call. */
const LOOKUP_CHUNK = 100;

export async function emailsForUids(uids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(uids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
    const chunk = unique.slice(i, i + LOOKUP_CHUNK);
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await getAuth().getUsers(chunk.map((uid) => ({ uid })));
      for (const u of res.users) if (u.email) out.set(u.uid, u.email);
    } catch (err) {
      logger.warn({ err, count: chunk.length }, 'account email lookup failed — showing uids');
      return out;
    }
  }
  return out;
}

/** The uid behind an email, or null when there is none (or the lookup fails). */
export async function uidForEmail(email: string): Promise<string | null> {
  try {
    return (await getAuth().getUserByEmail(email)).uid;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'auth/user-not-found') logger.warn({ err }, 'account uid lookup by email failed');
    return null;
  }
}
