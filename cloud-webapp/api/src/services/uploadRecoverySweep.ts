/**
 * uploadRecoverySweep.ts — the hourly backstop that puts stranded volunteer
 * photos into Drive without anyone first having to notice they are missing.
 *
 * WHY THIS EXISTS: the copy path deliberately leaves a photo in staging whenever
 * it cannot PROVE the photo is safe in Drive — a copy that failed, or a skip on
 * an "unconfirmed duplicate" claim left behind by a worker killed mid-copy (the
 * fix for the 9 photos destroyed on 2026-07-27/28). Keeping those bytes is right,
 * but nothing ever came back for them: they reached the gallery only if an admin
 * ran upload-recovery by hand, before the staging bucket's lifecycle rule deleted
 * them. At marathon scale nobody is going to notice a handful of missing photos
 * per session in time.
 *
 * WHAT IT DOES, EACH HOUR:
 *   1. Lists staging across every event and asks the photo index which of those
 *      objects are really still owed a copy (content hash not yet indexed).
 *   2. Judges each batch (`judgeBatch`) and re-dispatches only the ones nothing
 *      else is working on, through the existing recovery tool — so recovery adds
 *      no copy logic of its own, exactly as uploadRecoveryService intends.
 *   3. Emails the super-admins (`ADMIN_EMAILS`) when photos are still stranded
 *      after a day, at most every 12 hours.
 *
 * THE ONE RULE THAT MATTERS: never race a batch that is still alive. Recovery
 * copies under its own batch id, into its own Drive folder, so dispatching a
 * batch whose chunk chain is still running would split a photographer's session
 * across folders and double the Drive work. Every rule below therefore leans
 * towards "leave it for next hour": an unanswerable question (a failed Cloud
 * Tasks lookup, an unknown object age) is never read as "dead".
 *
 * DRY RUN unless `apply` is exactly `true`, like every other repair tool here.
 */

import type { UploadBatchPhase } from '@cloud-webapp/shared';

import { env } from '../lib/config.js';
import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { sendToMany } from './emailService.js';
import { uploadsStranded } from './emailTemplates.js';
import { getUploadBatch, type UploadBatchDoc } from './uploadBatchService.js';
import { processBatchTaskExists } from './uploadDispatch.js';
import { dispatchStagedRecovery, listAllStaged, strandedObjects, type StagedObject } from './uploadRecoveryService.js';

const HOUR = 3_600_000;

/**
 * A chain whose recorded task is gone is still given this long since its last
 * status write. A chunk writes its tally, enqueues its successor, then records
 * the successor's name — so for a moment the doc can name a finished task while
 * the chain is fine. Chunks are capped at 15 minutes, so a live chain always
 * writes more often than this.
 */
export const ACTIVE_GRACE_MS = 30 * 60_000;
/** A pre-chunking batch (no task recorded) is presumed alive this long. */
export const NO_TASK_DEAD_AFTER_MS = 2 * HOUR;
/**
 * How long a FINISHED batch settles before its leftovers are re-sent. Must exceed
 * the 35-minute stale-claim reclaim (uploadDedupService): until a dead worker's
 * claim goes stale, a re-sent copy would just be skipped as a duplicate again.
 */
export const TERMINAL_SETTLE_MS = 45 * 60_000;
/**
 * Objects with no status doc belong to a session that never called /complete —
 * possibly one still uploading (a phone can resume a session for days). Only
 * objects this old are presumed abandoned.
 */
export const NO_DOC_MIN_AGE_MS = 6 * HOUR;
/** A batch recovered this recently is left alone: its spaced-out tasks may still be due. */
export const RECOVERY_COOLDOWN_MS = 6 * HOUR;
/** Stranded this long means the re-dispatch is not fixing it — tell a human. */
export const ALERT_AFTER_MS = 24 * HOUR;
/** At most one alert email per this window. */
export const ALERT_EVERY_MS = 12 * HOUR;
/**
 * The staging bucket's live lifecycle rule (delete at age 14 days, checked
 * 2026-09-26), quoted in the alert so the reader knows the deadline. Note
 * provision-volunteer-uploads.sh still says 7: the live bucket drifted from it.
 */
const STAGING_LIFECYCLE_DAYS = 14;

const IN_FLIGHT: ReadonlySet<UploadBatchPhase> = new Set<UploadBatchPhase>(['received', 'saving']);

export type BatchVerdict = 'recover' | 'active' | 'settling' | 'cooldown' | 'young';

/** Milliseconds since `iso`, or null when it is missing or unparseable. */
function ageMs(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : now - t;
}

/**
 * Decide what to do with one batch's stranded objects. Pure, so every rule is
 * unit-tested without a queue or a database.
 *
 * `taskAlive` is whether `doc.pendingTask` is still in the Cloud Tasks queue, or
 * null when no task is recorded; `lookupFailed` means we asked and got no answer.
 */
export function judgeBatch(input: {
  doc: UploadBatchDoc | null;
  objects: ReadonlyArray<StagedObject>;
  taskAlive: boolean | null;
  lookupFailed: boolean;
  now: number;
}): BatchVerdict {
  const { doc, objects, taskAlive, lookupFailed, now } = input;

  const sinceRecovery = ageMs(doc?.lastRecoveryAt, now);
  if (sinceRecovery !== null && sinceRecovery < RECOVERY_COOLDOWN_MS) return 'cooldown';

  // No phase = /complete never recorded the batch (or only a recovery stamp
  // exists). The volunteer may still be uploading: require every object to be
  // provably old. An unknown age counts as young.
  if (!doc?.phase) {
    const abandoned =
      objects.length > 0 &&
      objects.every((o) => {
        const age = ageMs(o.createdAt, now);
        return age !== null && age >= NO_DOC_MIN_AGE_MS;
      });
    return abandoned ? 'recover' : 'young';
  }

  // Unknown write time reads as "just written" — the conservative direction.
  const sinceUpdate = ageMs(doc.updatedAt, now) ?? 0;

  if (IN_FLIGHT.has(doc.phase)) {
    if (lookupFailed) return 'active';
    if (taskAlive === true) return 'active';
    if (taskAlive === false) return sinceUpdate < ACTIVE_GRACE_MS ? 'active' : 'recover';
    return sinceUpdate < NO_TASK_DEAD_AFTER_MS ? 'active' : 'recover';
  }

  // Finished (indexing/done/ready/error): what is left is a failed copy or an
  // unconfirmed-duplicate keep. Wait out the claim reclaim, then re-send.
  return sinceUpdate < TERMINAL_SETTLE_MS ? 'settling' : 'recover';
}

export interface SweepReport {
  apply: boolean;
  /** Objects in the staging bucket, including ones already safe in Drive. */
  stagedObjects: number;
  /** Staged objects whose content is not yet in the photo index. */
  strandedObjects: number;
  events: number;
  /** Batches holding stranded objects, by verdict. */
  batches: Record<BatchVerdict, number>;
  /** What was (or, on a dry run, would be) re-dispatched. */
  dispatched: { objects: number; tasks: number; batches: number };
  /** Stranded objects older than ALERT_AFTER_MS — the ones the sweep is not fixing. */
  overdue: { objects: number; oldestHours: number; events: Array<{ eventId: string; objects: number }> };
  alerted: boolean;
  warnings: string[];
}

/** A task-name-safe, second-resolution tag for this run: `20261101t092013`. */
function runTagFor(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase();
}

export async function sweepStagedUploads(opts: { apply?: boolean; now?: Date } = {}): Promise<SweepReport> {
  const apply = opts.apply === true;
  const now = (opts.now ?? new Date()).getTime();
  const runTag = runTagFor(now);

  const report: SweepReport = {
    apply,
    stagedObjects: 0,
    strandedObjects: 0,
    events: 0,
    batches: { recover: 0, active: 0, settling: 0, cooldown: 0, young: 0 },
    dispatched: { objects: 0, tasks: 0, batches: 0 },
    overdue: { objects: 0, oldestHours: 0, events: [] },
    alerted: false,
    warnings: [],
  };

  const eventIds = new Set<string>();
  for (const o of await listAllStaged()) {
    report.stagedObjects += 1;
    eventIds.add(o.eventId);
  }
  report.events = eventIds.size;

  // Chained across events so their recovery chunks queue behind each other
  // instead of landing on one instance together (the 2026-07-28 OOM).
  let startDelayMs = 0;
  let oldestMs = 0;

  for (const eventId of eventIds) {
    let stranded: StagedObject[];
    try {
      ({ stranded } = await strandedObjects(eventId));
    } catch (err) {
      report.warnings.push(`${eventId}: could not read the photo index — skipped (${String(err)})`);
      continue;
    }
    report.strandedObjects += stranded.length;

    const byBatch = new Map<string, StagedObject[]>();
    for (const o of stranded) {
      const list = byBatch.get(o.batchId);
      if (list) list.push(o);
      else byBatch.set(o.batchId, [o]);
    }

    let eventOverdue = 0;
    const recoverable: string[] = [];
    for (const [batchId, objects] of byBatch) {
      for (const o of objects) {
        const age = ageMs(o.createdAt, now);
        if (age !== null && age >= ALERT_AFTER_MS) {
          eventOverdue += 1;
          oldestMs = Math.max(oldestMs, age);
        }
      }

      let doc: UploadBatchDoc | null;
      try {
        doc = await getUploadBatch(batchId);
      } catch (err) {
        report.batches.active += 1;
        report.warnings.push(`${eventId}/${batchId}: could not read the batch doc — left for next run (${String(err)})`);
        continue;
      }

      let taskAlive: boolean | null = null;
      let lookupFailed = false;
      if (doc?.phase && IN_FLIGHT.has(doc.phase) && doc.pendingTask) {
        try {
          taskAlive = await processBatchTaskExists(doc.pendingTask);
        } catch (err) {
          lookupFailed = true;
          report.warnings.push(`${eventId}/${batchId}: Cloud Tasks lookup failed — left for next run (${String(err)})`);
        }
      }

      const verdict = judgeBatch({ doc, objects, taskAlive, lookupFailed, now });
      report.batches[verdict] += 1;
      if (verdict === 'recover') recoverable.push(batchId);
    }

    if (eventOverdue > 0) {
      report.overdue.objects += eventOverdue;
      report.overdue.events.push({ eventId, objects: eventOverdue });
    }

    if (recoverable.length > 0) {
      const out = await dispatchStagedRecovery(eventId, { apply, batchIds: recoverable, runTag, startDelayMs });
      startDelayMs = out.scheduledThroughMs;
      report.dispatched.objects += out.objects;
      report.dispatched.tasks += out.tasks;
      report.dispatched.batches += out.batches;
      for (const w of out.warnings) report.warnings.push(`${eventId}: ${w}`);
    }
  }

  report.overdue.oldestHours = Math.floor(oldestMs / HOUR);

  if (report.overdue.objects > 0) {
    // ERROR on purpose: this is the line a log-based alert should key off, and it
    // fires on every run (dry or not) until the backlog clears.
    logger.error(
      { overdue: report.overdue.objects, oldestHours: report.overdue.oldestHours, events: report.overdue.events },
      'upload recovery sweep: volunteer photos stranded in staging over 24h',
    );
    if (apply) report.alerted = await maybeAlert(report, now);
  }

  logger.info(
    {
      apply,
      staged: report.stagedObjects,
      stranded: report.strandedObjects,
      batches: report.batches,
      dispatched: report.dispatched,
      overdue: report.overdue.objects,
    },
    'upload recovery sweep',
  );
  return report;
}

const STATE_COLLECTION = 'ops_state';
const STATE_DOC = 'upload_recovery_sweep';

/**
 * Email the super-admins, at most once per ALERT_EVERY_MS. If the throttle state
 * cannot be read we send anyway: an extra email is cheaper than a silent week
 * that ends with the lifecycle rule deleting photos.
 */
async function maybeAlert(report: SweepReport, now: number): Promise<boolean> {
  const ref = firestore().collection(STATE_COLLECTION).doc(STATE_DOC);
  try {
    const last = ageMs(String((await ref.get()).data()?.lastAlertAt ?? ''), now);
    if (last !== null && last < ALERT_EVERY_MS) return false;
  } catch (err) {
    logger.warn({ err }, 'upload recovery sweep: alert throttle unreadable (sending anyway)');
  }

  const recipients = env.ADMIN_EMAILS.split(',').map((s) => s.trim()).filter(Boolean);
  const sent = await sendToMany(
    recipients,
    uploadsStranded(report.overdue.events, report.overdue.oldestHours, STAGING_LIFECYCLE_DAYS),
  );
  if (sent === 0) return false;
  try {
    await ref.set({ lastAlertAt: new Date(now).toISOString() }, { merge: true });
  } catch (err) {
    logger.warn({ err }, 'upload recovery sweep: could not record the alert time (next run may re-send)');
  }
  return true;
}
