/**
 * referenceRetention.ts — enforce the PRD §8.4 retention tiers on stored
 * reference selfies (the M5.1 retention job): 90 days for an adult, 30 for a
 * minor.
 *
 * Nothing enforced them before this. The uploads bucket's lifecycle rule is a
 * flat 90 days, so a minor's selfie outlived its 30-day tier by two months, and
 * the Firestore TTL the runbook describes was never enabled (and could not have
 * worked: `expiresAt` is an ISO string, and a TTL only acts on a Timestamp). On
 * 2026-09-24, 332 of 357 minor records were past expiry and 241 of those
 * selfies were still in the bucket.
 *
 * Rules — keep them if you touch this:
 *   - **Bytes first, then the record.** The record is the only pointer to the
 *     object, so deleting it first would strand the selfie where nothing will
 *     ever look for it again. A failed object delete leaves the record, and the
 *     next run retries. (A missing object is success — for an adult the bucket
 *     lifecycle usually got there first.)
 *   - **Do NOT turn on a Firestore TTL for `find_me_uploads`.** A TTL deletes
 *     only the record, which is exactly the stranding above: a minor's selfie
 *     would then sit unowned until the bucket's day-90 rule.
 *   - **Expiry is the EARLIER of the recorded `expiresAt` and the tier applied
 *     to `createdAt`**, so a record stamped under a longer policy is still
 *     held to the current one. Never the later.
 *   - **DRY RUN unless `apply` is set.** The route only sets it on `apply: true`.
 *   - **Deadline-bounded**, like every bulk tool here: whatever doesn't fit in
 *     `deadlineMs` is reported as `remaining` and the next call picks it up.
 */

import { env } from '../lib/config.js';
import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { deleteReferenceObject } from './gcsService.js';

const COLLECTION = 'find_me_uploads';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Upper bound on one scan. The sweep keeps the collection small (it holds at
 *  most ~90 days of searches), so hitting this is reported, not expected. */
export const SCAN_LIMIT = 5000;
/** Objects deleted in parallel per step. */
const PARALLEL = 10;
/** Default time budget — inside the 60s Hosting ceiling for an admin caller. */
export const DEFAULT_DEADLINE_MS = 40_000;

export interface RetentionSweepOptions {
  apply: boolean;
  now?: Date;
  /** Stop starting new deletes after this many ms. */
  deadlineMs?: number;
}

export interface RetentionSweepResult {
  apply: boolean;
  /** Records read. */
  scanned: number;
  /** Past their retention (minor + adult). */
  expired: number;
  expiredMinor: number;
  expiredAdult: number;
  /** Record AND object removed (apply only). */
  deleted: number;
  /** Object delete failed; record kept for the next run (apply only). */
  failed: number;
  /** Expired but not reached before the deadline (apply only). */
  remaining: number;
  /** The scan filled SCAN_LIMIT — there may be more beyond it. */
  capped: boolean;
  /** When the longest-overdue record expired (ISO), or null. */
  oldestExpiry: string | null;
}

interface Candidate {
  id: string;
  gcsPath: string | null;
  minor: boolean;
  expiry: number;
}

function parseMs(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * When a record's selfie must be gone: the earlier of what the record says and
 * what the current tier says. Null only when neither can be read — such a record
 * is left alone (and counted as scanned), since guessing deletes photos.
 */
export function effectiveExpiry(data: Record<string, unknown>): number | null {
  const recorded = parseMs(data.expiresAt);
  const created = parseMs(data.createdAt);
  const days =
    data.subjectIsMinor === true ? env.REFERENCE_RETENTION_DAYS_MINOR : env.REFERENCE_RETENTION_DAYS_ADULT;
  const byTier = created === null ? null : created + days * DAY_MS;
  if (recorded === null) return byTier;
  if (byTier === null) return recorded;
  return Math.min(recorded, byTier);
}

async function removeOne(c: Candidate): Promise<boolean> {
  try {
    if (c.gcsPath) await deleteReferenceObject(c.gcsPath);
  } catch (err) {
    logger.warn({ err, uploadId: c.id }, 'retention: selfie delete failed — record kept for the next run');
    return false;
  }
  await firestore().collection(COLLECTION).doc(c.id).delete();
  return true;
}

export async function sweepExpiredReferences(opts: RetentionSweepOptions): Promise<RetentionSweepResult> {
  const nowMs = (opts.now ?? new Date()).getTime();
  const stopAt = Date.now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);

  const snap = await firestore().collection(COLLECTION).orderBy('createdAt', 'asc').limit(SCAN_LIMIT).get();
  const expired: Candidate[] = [];
  for (const d of snap.docs) {
    const data = d.data();
    const expiry = effectiveExpiry(data);
    if (expiry === null || expiry > nowMs) continue;
    expired.push({
      id: d.id,
      gcsPath: typeof data.gcsPath === 'string' && data.gcsPath ? data.gcsPath : null,
      minor: data.subjectIsMinor === true,
      expiry,
    });
  }
  // Longest-overdue first, so a run cut short by its deadline spends its budget
  // on the records that have been kept the longest past their promise.
  expired.sort((a, b) => a.expiry - b.expiry);

  const expiredMinor = expired.filter((c) => c.minor).length;
  const result: RetentionSweepResult = {
    apply: opts.apply,
    scanned: snap.docs.length,
    expired: expired.length,
    expiredMinor,
    expiredAdult: expired.length - expiredMinor,
    deleted: 0,
    failed: 0,
    remaining: 0,
    capped: snap.docs.length >= SCAN_LIMIT,
    oldestExpiry: expired.length ? new Date(expired[0]!.expiry).toISOString() : null,
  };
  if (!opts.apply) return result;

  let i = 0;
  while (i < expired.length && Date.now() < stopAt) {
    const chunk = expired.slice(i, i + PARALLEL);
    const outcomes = await Promise.all(chunk.map((c) => removeOne(c)));
    for (const ok of outcomes) {
      if (ok) result.deleted += 1;
      else result.failed += 1;
    }
    i += chunk.length;
  }
  result.remaining = expired.length - i;
  return result;
}
