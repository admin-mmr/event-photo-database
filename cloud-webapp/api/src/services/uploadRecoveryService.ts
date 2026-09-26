/**
 * uploadRecoveryService.ts — re-drive volunteer photos that are still sitting in
 * the staging bucket because their copy-to-Drive never completed.
 *
 * WHY THIS EXISTS: on 2026-07-27 the api was deployed with a 60s request timeout
 * (below the Cloud Tasks dispatchDeadline of 1800s), so
 * `/api/internal/process-batch` was killed mid-batch on roughly half its
 * requests. Cloud Tasks retried, gave up after `maxAttempts: 5`, and the batch
 * was dropped — leaving 1,188 photos (~5.1 GB) staged, never copied to Drive,
 * therefore never indexed, therefore invisible in the gallery. One batch alone
 * stranded 857 photos at `phase: saving`.
 *
 * HOW IT WORKS: it deliberately adds NO new copy logic. Every staged object
 * carries the metadata the normal path needs (eventId, linkId, clubName, tag,
 * originalName, photographerName, batchId — stamped by `createResumableSession`),
 * so recovery just re-dispatches the SAME Cloud Tasks work item that a volunteer
 * upload would, and `enqueueStagedBatch` does the rest: batch folder, credited
 * filename, md5 dedup + claim, Drive copy, Deleted_Files-safe bookkeeping,
 * Upload_Log row and the indexer trigger. Reusing the tested path is the whole
 * point; a bespoke copier would be a second implementation to get wrong.
 *
 * WHAT MAKES IT SAFE TO RE-RUN:
 *   - The scan is read-only and is the default (`apply` must be exactly `true`,
 *     matching the resync-names / duplicate-removal convention).
 *   - Objects whose content is already in Drive are filtered out before
 *     dispatch, and the worker's own md5 claim is the authoritative backstop —
 *     so a double-run cannot create duplicate Drive files.
 *   - Dispatch is idempotent per chunk: the Cloud Tasks task name is derived
 *     from the chunk, so re-dispatching an in-flight chunk is a 409 no-op.
 *   - Recovery uses its own batchId suffix, so the volunteer's original status
 *     doc is never overwritten.
 */

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { firestore } from '../lib/firestore.js';
import { objectStore } from '../lib/storage.js';
import { enqueueProcessBatchTask, isUploadDispatchConfigured } from './uploadDispatch.js';
import { updateUploadBatch } from './uploadBatchService.js';
import { objectCostMs } from './uploadCostModel.js';

/**
 * Staged objects per dispatched task. The worker gets the full 1800s window, and
 * a copy runs around a second per photo, so this leaves generous headroom while
 * keeping any single failure's blast radius small. Chunking also bounds how much
 * a Cloud Tasks retry re-does.
 */
const DEFAULT_CHUNK = 400;

/** Hard cap on objects dispatched in one call, so a mis-aimed run stays bounded. */
const MAX_DISPATCH = 5000;

/**
 * WHY DISPATCHES ARE SPACED: Cloud Run packs concurrent requests onto ONE
 * instance (`--concurrency`), and every in-flight copy buffers a whole file. The
 * first live recovery dispatched all 10 chunks at once, they landed together, and
 * the container was OOM-killed — 503s, and the tasks had to be forced through by
 * hand one at a time. Spacing keeps roughly one chunk in flight, which is what
 * the copy path is sized for. Finishing early just leaves the instance idle
 * until the next chunk is due, which costs nothing on a scale-to-zero service.
 *
 * The spacing is costed in BYTES as well as objects (see uploadCostModel.ts): a
 * flat per-object estimate once called 8.8 GB of video "~1 minute" when it took
 * 21.6, and under-estimating also under-spaces the dispatches — the OOM again.
 */

/**
 * Byte ceiling for one chunk, so a chunk cannot outlive the 1800s request
 * timeout however few objects it holds. At uploadCostModel's 6 MB/s, 6 GiB is ~1,000s
 * — comfortable headroom. Without this, `DEFAULT_CHUNK` (400) objects of video
 * would be a single task needing hours, and the worker would be killed mid-batch:
 * the original bug, reintroduced by the recovery tool.
 */
const MAX_CHUNK_BYTES = 6 * 1024 * 1024 * 1024;

/** Wall-clock a chunk should take: fixed per-object cost + transfer time. */
function chunkCostMs(objs: ReadonlyArray<StagedObject>): number {
  return objs.reduce((ms, o) => ms + objectCostMs(o.size), 0);
}

/**
 * Split a batch into chunks bounded by BOTH object count and total bytes, so a
 * chunk of large videos is smaller than a chunk of photos.
 */
function buildChunks(objs: ReadonlyArray<StagedObject>, maxCount: number): StagedObject[][] {
  const out: StagedObject[][] = [];
  let cur: StagedObject[] = [];
  let bytes = 0;
  for (const o of objs) {
    // A single object over the byte cap still gets its own chunk — never dropped.
    if (cur.length > 0 && (cur.length >= maxCount || bytes + o.size > MAX_CHUNK_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(o);
    bytes += o.size;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export interface StrandedBatch {
  batchId: string;
  linkId: string;
  clubName: string;
  photographerName: string;
  /** Staged objects for this batch whose content is not in Drive. */
  stranded: number;
  /** Total staged objects for this batch (including ones already in Drive). */
  staged: number;
  bytes: number;
  /** True when every stranded object still carries its photographer credit. */
  fullyCredited: boolean;
}

export interface RecoveryScan {
  eventId: string;
  stagedObjects: number;
  strandedObjects: number;
  strandedBytes: number;
  /** Stranded objects with no `photographerName` — recovered as `volunteer`. */
  uncredited: number;
  batches: StrandedBatch[];
}

export interface RecoveryDispatch {
  eventId: string;
  apply: boolean;
  /** Objects that would be / were dispatched. */
  objects: number;
  /** Cloud Tasks work items created. */
  tasks: number;
  batches: number;
  notDispatched: number;
  /** Roughly how long the staggered run takes end to end. */
  estimatedMinutes: number;
  /**
   * Offset (ms from now) at which the last dispatched chunk is due to finish —
   * `startDelayMs` plus this run's spacing. A caller recovering several events
   * passes it on as the next event's `startDelayMs`, so their chunks queue behind
   * each other instead of landing on one instance together.
   */
  scheduledThroughMs: number;
  warnings: string[];
}

export interface StagedObject {
  name: string;
  md5Hex: string;
  size: number;
  eventId: string;
  batchId: string;
  linkId: string;
  clubName: string;
  photographerName: string;
  /** ISO creation time, or '' when the provider reports none (= unknown age). */
  createdAt: string;
}

const STAGED_ROOT = 'volunteer_uploads/';

/** Every staged object for an event, with the metadata the copy path needs. */
async function listStaged(eventId: string): Promise<StagedObject[]> {
  return listStagedUnder(`${STAGED_ROOT}${eventId}/`);
}

/** Every staged object in the bucket, across all events (the recovery sweep). */
export async function listAllStaged(): Promise<StagedObject[]> {
  return listStagedUnder(STAGED_ROOT);
}

async function listStagedUnder(prefix: string): Promise<StagedObject[]> {
  const objects = await objectStore().list(env.VOLUNTEER_STAGING_BUCKET, { prefix });
  const out: StagedObject[] = [];
  for (const o of objects) {
    const custom = o.metadata.custom;
    // The batch id is the third path segment; trust the path over metadata so a
    // half-stamped object still groups with its siblings. (On Azure the custom
    // metadata is client-supplied — see `UploadSession.clientStampsMetadata` —
    // which makes preferring the api-chosen key the right default there too.)
    const [, eventId = '', batchId = ''] = o.key.split('/');
    if (!eventId || !batchId) continue;
    out.push({
      name: o.key,
      // '' = the provider reports no hash. Treated as "still owed a copy" by
      // strandedObjects, never as "already done".
      md5Hex: o.metadata.md5Hex,
      size: o.metadata.size,
      eventId,
      batchId,
      linkId: custom.linkId ?? '',
      clubName: custom.clubName ?? '',
      photographerName: (custom.photographerName ?? '').trim(),
      createdAt: o.metadata.createdAt,
    });
  }
  return out;
}

/**
 * Content hashes already in Drive, read from the photo index (`contentHash`
 * mirrors Drive's md5 — indexer/job.py). Used only to avoid dispatching pointless
 * work; the worker's own claim remains the authoritative duplicate check, so a
 * stale index here can never cause a double copy.
 */
async function hashesInDrive(eventId: string): Promise<Set<string>> {
  const snap = await firestore().collection('photos').where('eventId', '==', eventId).select('contentHash').get();
  const out = new Set<string>();
  for (const doc of snap.docs) {
    const h = String(doc.get('contentHash') ?? '').toLowerCase();
    if (h) out.add(h);
  }
  return out;
}

/** Objects still owed a Drive copy, newest-path-last for stable output. */
export async function strandedObjects(eventId: string): Promise<{ all: StagedObject[]; stranded: StagedObject[] }> {
  const [all, inDrive] = await Promise.all([listStaged(eventId), hashesInDrive(eventId)]);
  // An object with no md5 cannot be matched — treat it as stranded and let the
  // worker's name+size fallback decide. Unknown must not read as "already done".
  const stranded = all.filter((o) => !o.md5Hex || !inDrive.has(o.md5Hex));
  return { all, stranded };
}

/** Read-only report of what recovery would copy. */
export async function scanStagedRecovery(eventId: string): Promise<RecoveryScan> {
  const { all, stranded } = await strandedObjects(eventId);

  const byBatch = new Map<string, StagedObject[]>();
  for (const o of stranded) {
    const list = byBatch.get(o.batchId);
    if (list) list.push(o);
    else byBatch.set(o.batchId, [o]);
  }
  const stagedPerBatch = new Map<string, number>();
  for (const o of all) stagedPerBatch.set(o.batchId, (stagedPerBatch.get(o.batchId) ?? 0) + 1);

  const batches: StrandedBatch[] = [...byBatch.entries()]
    .map(([batchId, objs]) => ({
      batchId,
      linkId: objs.find((o) => o.linkId)?.linkId ?? '',
      clubName: objs.find((o) => o.clubName)?.clubName ?? '',
      photographerName: objs.find((o) => o.photographerName)?.photographerName ?? '',
      stranded: objs.length,
      staged: stagedPerBatch.get(batchId) ?? objs.length,
      bytes: objs.reduce((n, o) => n + o.size, 0),
      fullyCredited: objs.every((o) => o.photographerName),
    }))
    .sort((a, b) => b.stranded - a.stranded);

  return {
    eventId,
    stagedObjects: all.length,
    strandedObjects: stranded.length,
    strandedBytes: stranded.reduce((n, o) => n + o.size, 0),
    uncredited: stranded.filter((o) => !o.photographerName).length,
    batches,
  };
}

/**
 * Re-dispatch stranded objects to the upload worker. DRY RUN unless `apply` is
 * exactly `true`.
 *
 * Nothing Drive-heavy happens here — this only lists staging and creates Cloud
 * Tasks work items, so the request itself stays far inside the 60s browser
 * ceiling no matter how many photos are recovered.
 */
export async function dispatchStagedRecovery(
  eventId: string,
  opts: {
    apply?: boolean;
    chunkSize?: number;
    batchIds?: ReadonlyArray<string> | undefined;
    /**
     * Distinguishes this run's task names. Cloud Tasks refuses to reuse a name
     * for a while after its task ran, and `enqueueProcessBatchTask` reads that
     * refusal as "already queued" — so without a tag, recovering the same batch
     * twice in that window silently dispatches nothing. The hourly sweep passes
     * one; a one-off admin run need not.
     */
    runTag?: string;
    /** Delay before the first chunk is due; see `scheduledThroughMs`. */
    startDelayMs?: number;
  } = {},
): Promise<RecoveryDispatch> {
  const apply = opts.apply === true;
  const chunk = opts.chunkSize && opts.chunkSize > 0 ? Math.min(opts.chunkSize, 1000) : DEFAULT_CHUNK;
  const only = opts.batchIds && opts.batchIds.length > 0 ? new Set(opts.batchIds) : null;

  const result: RecoveryDispatch = {
    eventId,
    apply,
    objects: 0,
    tasks: 0,
    batches: 0,
    notDispatched: 0,
    estimatedMinutes: 0,
    scheduledThroughMs: opts.startDelayMs ?? 0,
    warnings: [],
  };

  if (apply && !isUploadDispatchConfigured()) {
    result.warnings.push(
      'Cloud Tasks dispatch is not configured (UPLOAD_DISPATCH_TO_WORKER / queue / worker URL / token) — nothing dispatched',
    );
    return result;
  }

  const { stranded } = await strandedObjects(eventId);
  const byBatch = new Map<string, StagedObject[]>();
  for (const o of stranded) {
    if (only && !only.has(o.batchId)) continue;
    const list = byBatch.get(o.batchId);
    if (list) list.push(o);
    else byBatch.set(o.batchId, [o]);
  }

  let budget = MAX_DISPATCH;
  // Grows as chunks are planned, so each is scheduled after the previous should
  // have finished rather than all firing at once. Also the run's duration
  // estimate, which is why it accrues on a dry run too.
  let plannedMs = 0;
  const startDelayMs = opts.startDelayMs ?? 0;
  for (const [batchId, objs] of byBatch) {
    const linkId = objs.find((o) => o.linkId)?.linkId ?? '';
    if (!linkId) {
      // Without a link we cannot resolve the club/tag the copy path needs.
      result.warnings.push(`Batch ${batchId}: no linkId on any staged object — skipped`);
      result.notDispatched += objs.length;
      continue;
    }
    result.batches += 1;

    const chunks = buildChunks(objs, chunk);
    let done = 0;
    let dispatchedForBatch = 0;
    for (const [n, slice] of chunks.entries()) {
      if (slice.length > budget) {
        result.notDispatched += objs.length - done;
        result.warnings.push(`Dispatch cap (${MAX_DISPATCH}) reached — re-run to continue`);
        budget = 0;
        break;
      }
      budget -= slice.length;
      done += slice.length;
      result.objects += slice.length;
      result.tasks += 1;
      // Accrued for BOTH modes so a dry run reports an honest duration.
      const cost = chunkCostMs(slice);

      if (!apply) {
        plannedMs += cost;
        continue;
      }

      // A recovery-specific batchId keeps the volunteer's original status doc
      // intact AND gives the Cloud Tasks item a name that cannot collide with
      // the original dispatch (whose task may still be known to the queue).
      const recoveryBatchId = opts.runTag ? `${batchId}-rec${opts.runTag}-${n + 1}` : `${batchId}-rec${n + 1}`;
      try {
        await enqueueProcessBatchTask(
          {
            linkId,
            batchId: recoveryBatchId,
            objectNames: slice.map((o) => o.name),
          },
          // Spread the chunks out so they do not all land on one instance.
          { scheduleTime: new Date(Date.now() + startDelayMs + plannedMs).toISOString() },
        );
        plannedMs += cost;
        dispatchedForBatch += 1;
      } catch (err) {
        result.tasks -= 1;
        result.objects -= slice.length;
        result.notDispatched += slice.length;
        result.warnings.push(`Batch ${batchId} chunk ${n + 1}: dispatch failed — ${String(err)}`);
      }
    }
    // Stamp the volunteer's ORIGINAL batch doc, so the hourly sweep leaves this
    // batch alone while the (spaced-out) recovery is still working through it.
    if (dispatchedForBatch > 0) await updateUploadBatch(batchId, { lastRecoveryAt: new Date().toISOString() });
    if (budget === 0) break;
  }
  result.scheduledThroughMs = startDelayMs + plannedMs;

  // Rounded, not ceilinged: ceil turned 2.0003 minutes into "3", and an estimate
  // that rounds up on a rounding artefact reads as sloppy. Any non-empty run
  // still reports at least 1 minute.
  result.estimatedMinutes = result.objects === 0 ? 0 : Math.max(1, Math.round(plannedMs / 60_000));

  logger.info(
    {
      eventId,
      apply,
      objects: result.objects,
      tasks: result.tasks,
      batches: result.batches,
      estimatedMinutes: result.estimatedMinutes,
    },
    'staged upload recovery dispatch',
  );
  return result;
}
