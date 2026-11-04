/**
 * uploadSweepService.ts — the scheduled safety net for volunteer upload sessions
 * that never reached `POST /api/volunteer/upload/complete`.
 *
 * WHY THIS EXISTS: the browser uploads each file straight to the staging bucket,
 * then calls `/complete` once at the end, and `/complete` is the ONLY thing that
 * dispatches the copy to Drive. A volunteer who closes the tab mid-session — or
 * a page that dies, or a hung chunk that never lets the loop finish — leaves
 * every finished file staged with nothing to file it. On NYC Marathon night
 * (2026-11-01/02) five sessions, 1,550 photos, sat like that until an admin ran
 * `recover-staged-uploads.sh` by hand, and the bucket's lifecycle rule would
 * eventually have deleted them.
 *
 * HOW IT WORKS: it adds no copy logic and no dispatch logic of its own. It only
 * decides WHICH batches are owed, then hands each event to
 * `dispatchStagedRecovery` (uploadRecoveryService.ts) — the admin recovery tool,
 * which re-dispatches the normal Cloud Tasks work item, skips content already
 * in the photo index, chunks by objects AND bytes, and staggers the chunks.
 *
 * A batch is owed when ALL of these hold:
 *   1. It has staged objects (the bucket listing — the one query an idle tick
 *      makes; successful copies delete their staged object, so a healthy bucket
 *      is near-empty).
 *   2. Its NEWEST staged object is older than `minAgeMs` (default 2h). The age
 *      of the newest file, not the oldest: a long session's early files are
 *      hours old while it is still uploading. A file with no reported commit
 *      time makes the whole batch "too recent" — unknown age must never
 *      license racing a `/complete` that may still come.
 *   3. No `upload_batches` record exists for it (`hasUploadBatchRecord`). Any
 *      record means `/complete` ran, or recovery already handled it, so the
 *      normal pipeline (Cloud Tasks retries) or an admin owns it. This is
 *      also what keeps unproven-duplicate orphans — kept on purpose, see
 *      CLAUDE.md — from being swept: their batch has a doc.
 *
 * Every dispatched batch gets a recovery marker on its batch doc, so the next
 * tick skips it; so does a candidate with nothing owed (all content already
 * indexed) or one that cannot be dispatched (no linkId), because otherwise
 * every tick would re-read that event's whole photo index to learn the same
 * thing again.
 *
 * WHAT A LATE `/complete` DOES: if the volunteer was merely slow (the page
 * reopened hours later) their `/complete` still runs after the sweep. Files the
 * sweep already filed are gone from staging (the worker deletes after copying)
 * or caught by the md5 claim, so they are skipped, never copied twice.
 *
 * PROVEN LEFTOVERS ARE DELETED HERE, AND NOTHING ELSE. The worker keeps a
 * staged copy whenever it cannot prove a duplicate (CLAUDE.md: never delete on
 * an unproven one), and nothing went back for them: on 2026-11-04 the bucket
 * held 503 objects / 4.37 GB, every one either empty or the same content as a
 * photo already in the gallery. An object at least `LEFTOVER_MIN_AGE_MS` old is
 * removed only when it is empty or its md5 matches a `photos` doc of its event
 * — the same proof the worker uses, read from the index the gallery serves.
 * Unknown age, unknown md5 or no matching doc keeps it; it is then still a
 * candidate for filing below, as before.
 */

import { env } from '../lib/config.js';
import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { objectStore } from '../lib/storage.js';
import type { StoredObject } from '../lib/storage/types.js';
import { hasUploadBatchRecord, markRecoveryDispatched } from './uploadBatchService.js';
import { isUploadDispatchConfigured } from './uploadDispatch.js';
import { dispatchStagedRecovery, type RecoveryDispatch } from './uploadRecoveryService.js';

/**
 * Default safe age. `/complete` follows the last finished file by seconds on a
 * live page; 2h leaves room for a slow final file, a stalled-then-recovered
 * connection, or a phone that slept, while still filing an abandoned session
 * well inside the staging lifecycle.
 */
export const DEFAULT_MIN_AGE_MS = 2 * 60 * 60 * 1000;

/** Floor on a caller-supplied age, so a fat-fingered `minAgeMinutes: 1` cannot race live uploads. */
export const MIN_AGE_FLOOR_MS = 60 * 60 * 1000;

/**
 * Most staggered work one tick will schedule. The scheduler fires hourly, so
 * capping a tick's schedule just under that keeps one tick's chunks from
 * overlapping the next tick's — the OOM the stagger exists to prevent. A
 * deferred batch is simply picked up next tick (it has no marker yet).
 */
export const MAX_PLANNED_MS = 50 * 60 * 1000;

/**
 * A staged object proven to need nothing (see the header) is deleted once it is
 * this old. A day keeps clear of anything a live session, a queued copy task or
 * a recovery chunk scheduled ~50 min out could still be holding.
 */
export const LEFTOVER_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Parallel photo-index lookups / deletes while clearing leftovers. */
const LEFTOVER_CONCURRENCY = 10;

/** Per-tick object cap — the recovery tool's own `MAX_DISPATCH`. */
const MAX_OBJECTS_PER_TICK = 5000;

/** Parallel `upload_batches` reads while classifying batches. */
const RECORD_READ_CONCURRENCY = 20;

export interface SweepBatch {
  eventId: string;
  batchId: string;
  objects: number;
  bytes: number;
  /** Newest staged object's commit time (ISO). */
  newestAt: string;
}

export interface UploadSweepResult {
  apply: boolean;
  minAgeMinutes: number;
  /** Objects in the staging area (every event). */
  stagedObjects: number;
  /** Distinct batches those objects belong to. */
  stagedBatches: number;
  /** Batches whose newest object is too young (or of unknown age) — left alone. */
  tooRecent: number;
  /** Batches with an `upload_batches` record — the pipeline or an admin owns them. */
  owned: number;
  /** Never-completed batches old enough to file: what this tick acts on. */
  candidates: SweepBatch[];
  /** Objects dispatched (or, on a dry run, that would be). */
  objects: number;
  tasks: number;
  /** Candidate objects left for a later tick (cap, deferral, failure, no link). */
  notDispatched: number;
  /** Candidates whose content was all already indexed — marked, nothing to do. */
  nothingOwed: number;
  estimatedMinutes: number;
  /** Old staged objects proven to need nothing (empty, or content already indexed): deleted, or on a dry run would be. */
  leftoversRemoved: number;
  leftoverBytes: number;
  /** Per-event recovery result, as the admin tool reports it. */
  events: RecoveryDispatch[];
  warnings: string[];
}

interface BatchAcc {
  eventId: string;
  batchId: string;
  objects: number;
  bytes: number;
  newestMs: number;
  /** A staged object reported no commit time. */
  unknownAge: boolean;
  linkId: string;
}

/** Run `fn` over `items` with at most `n` in flight. */
async function mapLimit<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * Find never-completed upload batches and file them. DRY RUN unless `apply` is
 * exactly `true`.
 */
export async function sweepNeverCompletedUploads(
  opts: { apply?: boolean; minAgeMs?: number; now?: number } = {},
): Promise<UploadSweepResult> {
  const apply = opts.apply === true;
  const minAgeMs = Math.max(MIN_AGE_FLOOR_MS, opts.minAgeMs ?? DEFAULT_MIN_AGE_MS);
  const now = opts.now ?? Date.now();

  const result: UploadSweepResult = {
    apply,
    minAgeMinutes: Math.round(minAgeMs / 60_000),
    stagedObjects: 0,
    stagedBatches: 0,
    tooRecent: 0,
    owned: 0,
    candidates: [],
    objects: 0,
    tasks: 0,
    notDispatched: 0,
    nothingOwed: 0,
    estimatedMinutes: 0,
    leftoversRemoved: 0,
    leftoverBytes: 0,
    events: [],
    warnings: [],
  };

  // Checked before touching anything, so a misconfigured api neither dispatches
  // nor writes markers that would hide the batches from the next, working run.
  if (apply && !isUploadDispatchConfigured()) {
    result.warnings.push(
      'Cloud Tasks dispatch is not configured (UPLOAD_DISPATCH_TO_WORKER / queue / worker URL / token) — nothing dispatched',
    );
    return result;
  }

  // The one query an idle tick makes.
  const prefix = `${env.VOLUNTEER_STAGING_PREFIX}/`;
  const listed = await objectStore().list(env.VOLUNTEER_STAGING_BUCKET, { prefix });
  result.stagedObjects = listed.length;
  if (listed.length === 0) return result;

  // Clear proven leftovers first, so they are neither filed nor marked below.
  const cleared = await clearProvenLeftovers(listed, { apply, now, result });
  const staged = listed.filter((o) => !cleared.has(o.key));

  // `<prefix>/<eventId>/<batchId>/<uploadId>.<ext>` — the api chooses the key,
  // so (unlike custom metadata on Azure) it is never client-controlled.
  const batches = new Map<string, BatchAcc>();
  for (const o of staged) {
    const [, eventId = '', batchId = ''] = o.key.split('/');
    if (!eventId || !batchId) continue;
    const id = `${eventId}/${batchId}`;
    let b = batches.get(id);
    if (!b) {
      b = { eventId, batchId, objects: 0, bytes: 0, newestMs: 0, unknownAge: false, linkId: '' };
      batches.set(id, b);
    }
    b.objects += 1;
    b.bytes += o.metadata.size;
    if (o.metadata.createdMs > 0) b.newestMs = Math.max(b.newestMs, o.metadata.createdMs);
    else b.unknownAge = true;
    if (!b.linkId) b.linkId = o.metadata.custom.linkId ?? '';
  }
  result.stagedBatches = batches.size;

  const oldEnough = [...batches.values()].filter((b) => {
    const idle = !b.unknownAge && b.newestMs > 0 && now - b.newestMs >= minAgeMs;
    if (!idle) result.tooRecent += 1;
    return idle;
  });

  const owned = await mapLimit(oldEnough, RECORD_READ_CONCURRENCY, (b) => hasUploadBatchRecord(b.batchId));
  const candidates = oldEnough
    .filter((b, i) => {
      if (owned[i]) result.owned += 1;
      return !owned[i];
    })
    // Oldest first: the closest to the lifecycle deadline goes first.
    .sort((a, b) => a.newestMs - b.newestMs);

  result.candidates = candidates.map((b) => ({
    eventId: b.eventId,
    batchId: b.batchId,
    objects: b.objects,
    bytes: b.bytes,
    newestAt: new Date(b.newestMs).toISOString(),
  }));
  if (candidates.length === 0) return result;

  const byEvent = new Map<string, BatchAcc[]>();
  for (const b of candidates) {
    if (!b.linkId) {
      // The copy path resolves club/tag from the link; without one there is
      // nothing to dispatch, so record it once instead of re-reading the
      // event's photo index every tick to reach the same dead end.
      result.notDispatched += b.objects;
      result.warnings.push(`Batch ${b.batchId} (event ${b.eventId}): no linkId on any staged object — left for an admin`);
      if (apply) await markQuietly(result, b, 0, 'no_link');
      continue;
    }
    const list = byEvent.get(b.eventId);
    if (list) list.push(b);
    else byEvent.set(b.eventId, [b]);
  }

  let plannedMs = 0;
  let budget = MAX_OBJECTS_PER_TICK;
  for (const [eventId, list] of byEvent) {
    const pending = list.reduce((n, b) => n + b.objects, 0);
    if (budget <= 0 || plannedMs >= MAX_PLANNED_MS) {
      result.notDispatched += pending;
      continue;
    }
    const out = await dispatchStagedRecovery(eventId, {
      apply,
      batchIds: list.map((b) => b.batchId),
      startAtMs: plannedMs,
      maxPlannedMs: MAX_PLANNED_MS,
      maxObjects: budget,
    });
    result.events.push(out);
    result.objects += out.objects;
    result.tasks += out.tasks;
    result.notDispatched += out.notDispatched;
    result.warnings.push(...out.warnings);
    plannedMs = out.plannedMs;
    budget -= out.objects;

    // Candidates the recovery tool found nothing owed for: every staged object
    // is already in the photo index. Mark them so the next tick doesn't query
    // that index again. Only once the event was fully examined — a deferred or
    // capped run may simply not have reached them.
    if (out.deferredBatches === 0 && out.notDispatched === 0) {
      const dispatched = new Set(out.dispatchedBatchIds);
      for (const b of list) {
        if (dispatched.has(b.batchId)) continue;
        result.nothingOwed += 1;
        if (apply) await markQuietly(result, b, 0);
      }
    }
  }

  result.estimatedMinutes = result.objects === 0 ? 0 : Math.max(1, Math.round(plannedMs / 60_000));
  logger.info(
    {
      apply,
      stagedObjects: result.stagedObjects,
      stagedBatches: result.stagedBatches,
      candidates: result.candidates.length,
      objects: result.objects,
      tasks: result.tasks,
      notDispatched: result.notDispatched,
      leftoversRemoved: result.leftoversRemoved,
    },
    'never-completed upload sweep',
  );
  return result;
}

/** Does `eventId`'s photo index hold this content? One indexed lookup, ≤1 doc read. */
async function contentIndexed(eventId: string, md5Hex: string): Promise<boolean> {
  const snap = await firestore()
    .collection('photos')
    .where('eventId', '==', eventId)
    .where('contentHash', '==', md5Hex)
    .limit(1)
    .get();
  return !snap.empty;
}

/**
 * Delete (on apply) the staged objects that are old enough and proven to need
 * nothing; returns their keys. Each object's own content is looked up — not the
 * event's whole index — so a tick with nothing old costs nothing, and one with
 * a few unproven old objects costs a few reads. A failed lookup or delete keeps
 * the object and is retried next tick.
 */
async function clearProvenLeftovers(
  staged: ReadonlyArray<StoredObject>,
  opts: { apply: boolean; now: number; result: UploadSweepResult },
): Promise<Set<string>> {
  const old = staged.filter(
    (o) => o.metadata.createdMs > 0 && opts.now - o.metadata.createdMs >= LEFTOVER_MIN_AGE_MS,
  );
  const proven = new Set<string>();
  if (old.length === 0) return proven;

  // The api chose the key, `<prefix>/<eventId>/<batchId>/<file>` (see above).
  const eventOf = (o: StoredObject): string => o.key.split('/')[1] ?? '';
  const known = new Map<string, Promise<boolean>>();
  const verdicts = await mapLimit(old, LEFTOVER_CONCURRENCY, async (o) => {
    if (o.metadata.size === 0) return true;
    const md5 = o.metadata.md5Hex;
    const eventId = eventOf(o);
    // '' = the provider reported no hash: unknown, never "already indexed".
    if (!md5 || !eventId) return false;
    const k = `${eventId}/${md5}`;
    if (!known.has(k)) known.set(k, contentIndexed(eventId, md5));
    try {
      return await known.get(k)!;
    } catch (err) {
      opts.result.warnings.push(`Could not check ${o.key} against the photo index — kept (${String(err)})`);
      return false;
    }
  });

  const doomed = old.filter((_, i) => verdicts[i]);
  const removed = await mapLimit(doomed, LEFTOVER_CONCURRENCY, async (o) => {
    if (!opts.apply) return true;
    try {
      await objectStore().remove(env.VOLUNTEER_STAGING_BUCKET, o.key);
      return true;
    } catch (err) {
      opts.result.warnings.push(`Could not delete leftover ${o.key} — kept (${String(err)})`);
      return false;
    }
  });
  doomed.forEach((o, i) => {
    if (!removed[i]) return;
    proven.add(o.key);
    opts.result.leftoversRemoved += 1;
    opts.result.leftoverBytes += o.metadata.size;
  });
  if (proven.size > 0) {
    logger.info(
      { apply: opts.apply, objects: opts.result.leftoversRemoved, bytes: opts.result.leftoverBytes },
      'staged leftovers already in the gallery cleared',
    );
  }
  return proven;
}

async function markQuietly(result: UploadSweepResult, b: BatchAcc, objects: number, skipped?: string): Promise<void> {
  try {
    await markRecoveryDispatched(b.batchId, {
      eventId: b.eventId,
      linkId: b.linkId,
      objects,
      ...(skipped ? { skipped } : {}),
    });
  } catch (err) {
    result.warnings.push(`Batch ${b.batchId}: could not write the sweep marker — ${String(err)}`);
  }
}
