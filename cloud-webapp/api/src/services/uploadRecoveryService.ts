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
import { getStorage } from './volunteerUploadService.js';
import { enqueueProcessBatchTask, isUploadDispatchConfigured } from './uploadDispatch.js';

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
 * Spacing between dispatched chunks, per object in the preceding chunk.
 *
 * WHY: Cloud Run packs concurrent requests onto ONE instance (`--concurrency`),
 * and every in-flight copy buffers a whole photo (~4 MB). The first live
 * recovery dispatched all 10 chunks at once, they landed together, and the
 * container was OOM-killed — 503s, and the tasks had to be forced through by
 * hand one at a time. Spreading them means roughly one chunk is in flight at a
 * time, which is what the copy path is sized for. ~1.2s per photo is a
 * deliberately conservative estimate of copy throughput; finishing early just
 * leaves the instance idle until the next chunk is due, which costs nothing on a
 * scale-to-zero service.
 */
const STAGGER_MS_PER_OBJECT = 1_200;

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
  warnings: string[];
}

interface StagedObject {
  name: string;
  md5Hex: string;
  size: number;
  batchId: string;
  linkId: string;
  clubName: string;
  photographerName: string;
}

/** GCS reports md5 base64; Drive and the photo index use lowercase hex. */
function b64ToHex(md5Base64: string | undefined): string {
  if (!md5Base64) return '';
  try {
    return Buffer.from(md5Base64, 'base64').toString('hex').toLowerCase();
  } catch {
    return '';
  }
}

/** Every staged object for an event, with the metadata the copy path needs. */
async function listStaged(eventId: string): Promise<StagedObject[]> {
  const prefix = `volunteer_uploads/${eventId}/`;
  const [files] = await getStorage().bucket(env.VOLUNTEER_STAGING_BUCKET).getFiles({ prefix });
  const out: StagedObject[] = [];
  for (const f of files) {
    const meta = (f.metadata ?? {}) as { md5Hash?: string; size?: string | number; metadata?: Record<string, string> };
    const custom = meta.metadata ?? {};
    // The batch id is the third path segment; trust the path over metadata so a
    // half-stamped object still groups with its siblings.
    const batchId = String(f.name).split('/')[2] ?? '';
    if (!batchId) continue;
    out.push({
      name: String(f.name),
      md5Hex: b64ToHex(meta.md5Hash),
      size: Number(meta.size ?? 0) || 0,
      batchId,
      linkId: custom.linkId ?? '',
      clubName: custom.clubName ?? '',
      photographerName: (custom.photographerName ?? '').trim(),
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
async function strandedObjects(eventId: string): Promise<{ all: StagedObject[]; stranded: StagedObject[] }> {
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
  opts: { apply?: boolean; chunkSize?: number; batchIds?: ReadonlyArray<string> | undefined } = {},
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
  // Grows as chunks are queued, so each is scheduled after the previous should
  // have finished rather than all firing at once.
  let staggerMs = 0;
  for (const [batchId, objs] of byBatch) {
    const linkId = objs.find((o) => o.linkId)?.linkId ?? '';
    if (!linkId) {
      // Without a link we cannot resolve the club/tag the copy path needs.
      result.warnings.push(`Batch ${batchId}: no linkId on any staged object — skipped`);
      result.notDispatched += objs.length;
      continue;
    }
    result.batches += 1;

    for (let i = 0; i < objs.length; i += chunk) {
      const slice = objs.slice(i, i + chunk);
      if (slice.length > budget) {
        result.notDispatched += objs.length - i;
        result.warnings.push(`Dispatch cap (${MAX_DISPATCH}) reached — re-run to continue`);
        budget = 0;
        break;
      }
      budget -= slice.length;
      result.objects += slice.length;
      result.tasks += 1;
      if (!apply) continue;

      // A recovery-specific batchId keeps the volunteer's original status doc
      // intact AND gives the Cloud Tasks item a name that cannot collide with
      // the original dispatch (whose task may still be known to the queue).
      const recoveryBatchId = `${batchId}-rec${Math.floor(i / chunk) + 1}`;
      try {
        await enqueueProcessBatchTask(
          {
            linkId,
            batchId: recoveryBatchId,
            objectNames: slice.map((o) => o.name),
          },
          // Spread the chunks out so they do not all land on one instance.
          { scheduleTime: new Date(Date.now() + staggerMs).toISOString() },
        );
        staggerMs += slice.length * STAGGER_MS_PER_OBJECT;
      } catch (err) {
        result.tasks -= 1;
        result.objects -= slice.length;
        result.notDispatched += slice.length;
        result.warnings.push(`Batch ${batchId} chunk ${i / chunk + 1}: dispatch failed — ${String(err)}`);
      }
    }
    if (budget === 0) break;
  }

  result.estimatedMinutes = Math.ceil((result.objects * STAGGER_MS_PER_OBJECT) / 60_000);

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
