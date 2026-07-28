/**
 * duplicateRemovalQueue.ts — async, bounded runner for duplicate-file removal.
 *
 * WHY THIS EXISTS (the bug it fixes): removing an event's duplicates cannot be
 * done inside one HTTP request, and three attempts to squeeze it in all failed
 * the same way. The api is fronted by Firebase Hosting (hard 60s rewrite cap)
 * and Cloud Run is deployed with `--timeout=60`, while the work itself is
 * rate-paced Drive traffic:
 *
 *   - every Drive call goes through the shared pacing gate in driveRateLimit.ts
 *     (~8 calls/s), and a rate-limited call can back off for tens of seconds;
 *   - trashing one duplicate costs ~1 paced PATCH, and retiring the managed
 *     shortcuts/copies that pointed at it costs ~2–3 more (a photo is usually in
 *     both Photos_NNN and Album);
 *   - so ~100 files ≈ 400 paced calls, and a real event's 639 duplicates ≈ 2,500
 *     calls ≈ 5+ minutes of irreducible wall clock.
 *
 * Measured in the field: one `POST …/remove` logged `totalMs=325833` — 5.4
 * MINUTES — against a 45s "budget", because the budget was only checked between
 * chunks and the post-loop shortcut sweep was unbounded. The files were really
 * being trashed, but Cloud Run killed the connection at 60.000s every time, so
 * the caller only ever saw HTTP 502/504 and never learned what progress was made.
 *
 * THE FIX: enqueue the scanned work list once, then drain it in bounded ticks —
 * the same shape folderRebuildQueue.ts already uses for the managed-folder
 * rebuilds that hit this identical wall. An enqueue costs one live Drive scan and
 * returns 202 with a batch id. Each drain tick trashes a capped number of files,
 * sweeps their managed entries under a deadline, commits progress to the batch
 * doc, and returns well inside 60s. The browser drives the ticks for near-live
 * progress while the admin watches; the Cloud Scheduler drain is the backstop if
 * they close the page.
 *
 * SAFETY PROPERTIES (keep these if you touch this file):
 *   - Progress is committed per CHUNK, not per tick, so a tick that dies loses at
 *     most one chunk's bookkeeping. Re-trashing an already-trashed file is
 *     harmless (Drive no-ops it), so the worst case is a duplicate ledger row.
 *   - One lease per batch, so overlapping ticks (browser + scheduler) never
 *     double-process the same work.
 *   - `pendingSweep` carries trashed IDs whose managed entries are not retired
 *     yet. A sweep cut short by its deadline leaves them queued and the next tick
 *     re-runs it — the sweep is idempotent, so that just finishes the job.
 *   - The batch is only marked done when BOTH the work list and the sweep queue
 *     are empty; the public folder index is refreshed exactly once, at that point.
 */

import { env } from '../lib/config.js';
import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { getDriveToken, DRIVE_SCOPE_READWRITE } from './driveService.js';
import { removeShortcutsForTargets } from './specialFoldersService.js';
import { tryRebuildPublicFolderIndex } from './publicFolderIndexService.js';
import {
  planDuplicateRemoval,
  scanEventDuplicates,
  trashDuplicateChunk,
  TRASH_CHUNK,
  type DuplicateWorkItem,
} from './duplicateFilesService.js';

const COLLECTION = 'duplicateRemovalBatches';

/**
 * Wall-clock budget for one drain tick. Kept well under the 60s Cloud Run /
 * Hosting cap so the commit + response always have headroom; whatever is left
 * rolls to the next tick.
 */
const TICK_BUDGET_MS = 40_000;

/**
 * Files trashed per tick. Sized from the real cost model above (~0.42s of paced
 * Drive time per file once its sweep is counted), so a tick's trash + sweep land
 * inside TICK_BUDGET_MS with room to spare. Deadline checks below are the
 * backstop when Drive is slow, not the primary bound — a fixed cap keeps ticks
 * predictable, which is what makes the progress bar honest.
 */
const MAX_FILES_PER_TICK = 60;

/** Tail of the tick reserved for committing progress and finalising. */
const FINALIZE_RESERVE_MS = 3_000;

/**
 * How long a tick holds the batch. Longer than TICK_BUDGET_MS so a still-running
 * tick is never elbowed aside, but short enough that a tick which died (its
 * request dropped) frees the batch quickly.
 */
const LEASE_MS = 90_000;

/**
 * Cap on duplicates enqueued in one batch. A Firestore document is limited to
 * 1 MiB and the work list lives inline in the batch doc; at ~250 bytes per
 * compact item this stays around 375 KB at the cap. Anything beyond it is
 * reported as `notEnqueued` — never silently dropped — and a re-run picks it up,
 * since the next scan simply finds whatever is still there.
 */
const ENQUEUE_CAP = 1500;

/** Warnings kept on the batch doc, so a pathological run can't grow it unbounded. */
const MAX_WARNINGS = 50;

/**
 * A work item as stored in Firestore. Deliberately short keys — this list is the
 * bulk of the document and the 1 MiB ceiling is the binding constraint here.
 *   i = driveFileId, p = relPath, h = contentHash (md5), k = kept copy's relPath,
 *   s = sizeBytes, c = clubName, b = batchFolderName
 */
interface StoredItem {
  i: string;
  p: string;
  h: string;
  k: string;
  s: number;
  c: string;
  b: string;
}

export type DuplicateBatchStatus = 'running' | 'done';

export interface DuplicateRemovalBatch {
  id: string;
  eventId: string;
  eventName: string;
  status: DuplicateBatchStatus;
  /** Duplicates enqueued for this batch. */
  total: number;
  /** Work items not yet trashed. */
  pending: StoredItem[];
  /** Trashed Drive IDs whose managed shortcuts/copies are not retired yet. */
  pendingSweep: string[];
  removed: number;
  failed: number;
  bytesReclaimed: number;
  /** Managed entries retired by the sweep, across all ticks. */
  shortcutsRemoved: number;
  /** Duplicates the scan found beyond ENQUEUE_CAP — re-run to clear them. */
  notEnqueued: number;
  warnings: string[];
  clubScope?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  /** ISO time the current tick's claim expires. */
  leaseUntil?: string;
}

const now = (): string => new Date().toISOString();

function batchRef(id: string) {
  return firestore().collection(COLLECTION).doc(id);
}

function toStored(w: DuplicateWorkItem): StoredItem {
  return {
    i: w.dup.driveFileId,
    p: w.dup.relPath,
    h: w.contentHash,
    k: w.keptRelPath,
    s: w.dup.sizeBytes,
    c: w.dup.clubName,
    b: w.dup.batchFolderName,
  };
}

/** Rehydrate a stored item. `name` is the basename of relPath — the same string
 *  the scan put there, so the Deleted_Files row reads identically. */
function fromStored(s: StoredItem): DuplicateWorkItem {
  const relPath = s.p ?? '';
  const name = relPath.split('/').filter(Boolean).pop() ?? relPath;
  return {
    dup: {
      driveFileId: s.i,
      name,
      relPath,
      mimeType: '',
      clubName: s.c ?? '',
      batchFolderName: s.b ?? '',
      sizeBytes: Number(s.s) || 0,
    },
    keptRelPath: s.k ?? '',
    contentHash: s.h ?? '',
  };
}

export interface EnqueueResult {
  id: string;
  eventName: string;
  /** Duplicates queued for removal. */
  total: number;
  /** Found but over the cap; a re-run after this batch picks them up. */
  notEnqueued: number;
}

/**
 * Scan the event and queue its duplicates for removal. The scan is the only
 * Drive work here (~10–20s on a 2,000-file tree), so this fits a request; the
 * trashing is left to drain ticks.
 */
export async function enqueueDuplicateRemoval(
  eventId: string,
  opts: {
    createdBy: string;
    hashes?: ReadonlyArray<string> | undefined;
    clubScope?: string | undefined;
  },
): Promise<{ ok: boolean; message: string; data?: EnqueueResult }> {
  const scan = await scanEventDuplicates(eventId, { clubScope: opts.clubScope });
  if (!scan.ok || !scan.data) return { ok: false, message: scan.message };

  const work = planDuplicateRemoval(scan.data.groups, { hashes: opts.hashes });
  // Nothing to queue — `ok` with no `data` is the caller's "no work" signal.
  if (work.length === 0) {
    return { ok: true, message: `No duplicate files to remove in "${scan.data.eventName}"` };
  }

  const queued = work.slice(0, ENQUEUE_CAP);
  const ref = firestore().collection(COLLECTION).doc();
  const ts = now();
  const batch: Omit<DuplicateRemovalBatch, 'id'> = {
    eventId,
    eventName: scan.data.eventName,
    status: 'running',
    total: queued.length,
    pending: queued.map(toStored),
    pendingSweep: [],
    removed: 0,
    failed: 0,
    bytesReclaimed: 0,
    shortcutsRemoved: 0,
    notEnqueued: Math.max(0, work.length - queued.length),
    warnings: [],
    ...(opts.clubScope === undefined ? {} : { clubScope: opts.clubScope }),
    createdBy: opts.createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  await ref.set(batch);
  logger.info(
    { batchId: ref.id, eventId, total: batch.total, notEnqueued: batch.notEnqueued, by: opts.createdBy },
    'duplicate removal batch enqueued',
  );
  return {
    ok: true,
    message: `Queued ${batch.total} duplicate file(s) for removal in "${scan.data.eventName}"${
      batch.notEnqueued ? `, ${batch.notEnqueued} beyond this batch — run again after it finishes` : ''
    }`,
    data: { id: ref.id, eventName: scan.data.eventName, total: batch.total, notEnqueued: batch.notEnqueued },
  };
}

/** The oldest still-running batch, or null. Needs the composite index on
 *  (status ASC, createdAt ASC) in infra/firestore.indexes.json. */
async function oldestRunningBatch(): Promise<DuplicateRemovalBatch | null> {
  const snap = await firestore()
    .collection(COLLECTION)
    .where('status', '==', 'running')
    .orderBy('createdAt', 'asc')
    .limit(1)
    .get();
  const doc = snap.docs[0];
  return doc ? ({ id: doc.id, ...doc.data() } as DuplicateRemovalBatch) : null;
}

/**
 * Take the batch's lease, or return null if another tick holds it. One lease per
 * batch is what keeps the browser-driven drain and the scheduler drain from
 * trashing the same files twice.
 */
async function takeLease(id: string): Promise<DuplicateRemovalBatch | null> {
  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(batchRef(id));
    if (!snap.exists) return null;
    const data = { id: snap.id, ...snap.data() } as DuplicateRemovalBatch;
    if (data.status !== 'running') return null;
    const until = data.leaseUntil ? Date.parse(data.leaseUntil) : 0;
    if (Number.isFinite(until) && until > Date.now()) return null;
    const ts = now();
    tx.update(batchRef(id), { leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(), updatedAt: ts });
    return data;
  });
}

/** Commit one chunk: drop the items from `pending`, bank the counters, and queue
 *  the trashed IDs for the sweep. Read-modify-write in a transaction so a
 *  concurrent finalise can't clobber it. */
async function commitChunk(
  id: string,
  doneIds: ReadonlyArray<string>,
  delta: {
    removed: number;
    failed: number;
    bytesReclaimed: number;
    trashedIds: ReadonlyArray<string>;
    warnings: ReadonlyArray<string>;
  },
  sweepEnabled: boolean,
): Promise<void> {
  const done = new Set(doneIds);
  await firestore().runTransaction(async (tx) => {
    const snap = await tx.get(batchRef(id));
    if (!snap.exists) return;
    const data = snap.data() as DuplicateRemovalBatch;
    const pending = (data.pending ?? []).filter((it) => !done.has(it.i));
    const warnings = [...(data.warnings ?? [])];
    for (const w of delta.warnings) if (warnings.length < MAX_WARNINGS && !warnings.includes(w)) warnings.push(w);
    tx.update(batchRef(id), {
      pending,
      // Only accumulate a sweep queue when managed folders are on; otherwise
      // there is nothing to retire and the list would grow for no reason.
      pendingSweep: sweepEnabled
        ? [...(data.pendingSweep ?? []), ...delta.trashedIds]
        : (data.pendingSweep ?? []),
      removed: (data.removed ?? 0) + delta.removed,
      failed: (data.failed ?? 0) + delta.failed,
      bytesReclaimed: (data.bytesReclaimed ?? 0) + delta.bytesReclaimed,
      warnings,
      updatedAt: now(),
    });
  });
}

/** Record what the sweep achieved; clear the queue only if it finished. */
async function commitSweep(
  id: string,
  swept: ReadonlyArray<string>,
  res: { shortcutsRemoved: number; errors: ReadonlyArray<string>; completed: boolean },
): Promise<void> {
  const sweptSet = new Set(swept);
  await firestore().runTransaction(async (tx) => {
    const snap = await tx.get(batchRef(id));
    if (!snap.exists) return;
    const data = snap.data() as DuplicateRemovalBatch;
    const warnings = [...(data.warnings ?? [])];
    for (const e of res.errors) {
      const w = `Shortcut sweep: ${e}`;
      if (warnings.length < MAX_WARNINGS && !warnings.includes(w)) warnings.push(w);
    }
    tx.update(batchRef(id), {
      // Cut short → leave these queued; the sweep is idempotent so the next tick
      // just finishes it. Finished → drop exactly what we swept, keeping any IDs
      // a concurrent chunk commit appended while the sweep ran.
      pendingSweep: res.completed
        ? (data.pendingSweep ?? []).filter((x) => !sweptSet.has(x))
        : (data.pendingSweep ?? []),
      shortcutsRemoved: (data.shortcutsRemoved ?? 0) + res.shortcutsRemoved,
      warnings,
      updatedAt: now(),
    });
  });
}

/** Mark the batch done when nothing is left, and release the lease either way. */
async function releaseLease(id: string): Promise<{ justFinished: boolean }> {
  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(batchRef(id));
    if (!snap.exists) return { justFinished: false };
    const data = snap.data() as DuplicateRemovalBatch;
    const empty = (data.pending ?? []).length === 0 && (data.pendingSweep ?? []).length === 0;
    const finishing = empty && data.status === 'running';
    const ts = now();
    tx.update(batchRef(id), {
      leaseUntil: '',
      updatedAt: ts,
      ...(finishing ? { status: 'done', finishedAt: ts } : {}),
    });
    return { justFinished: finishing };
  });
}

export interface DuplicateDrainSummary {
  drained: boolean;
  batchId?: string;
  /** Files trashed by THIS tick. */
  processed: number;
  failed: number;
  /** Files still queued (plus sweep work) after this tick. */
  remaining: number;
  finished: boolean;
  /** True when another tick held the lease, so this one did nothing. */
  busy?: boolean;
}

/**
 * Drain the oldest running batch for up to `budgetMs`, then return. A cheap
 * single-query no-op when nothing is queued, so a frequent scheduler tick costs
 * almost nothing while idle (the zero-idle-cost policy).
 */
export async function drainDuplicateRemovalQueue(
  budgetMs = TICK_BUDGET_MS,
): Promise<DuplicateDrainSummary> {
  const found = await oldestRunningBatch();
  if (!found) return { drained: false, processed: 0, failed: 0, remaining: 0, finished: false };

  const batch = await takeLease(found.id);
  if (!batch) {
    return { drained: true, batchId: found.id, processed: 0, failed: 0, remaining: -1, finished: false, busy: true };
  }

  const start = Date.now();
  const deadline = start + budgetMs;
  const sweepEnabled = env.MANAGED_FOLDERS_ENABLED === 'true';
  const spreadsheetId = env.MASTER_SPREADSHEET_ID ?? '';
  let processed = 0;
  let failed = 0;

  try {
    if (!spreadsheetId) {
      // Refuse to trash without a ledger, exactly like the route's apply guard.
      await commitChunk(batch.id, [], {
        removed: 0,
        failed: 0,
        bytesReclaimed: 0,
        trashedIds: [],
        warnings: ['MASTER_SPREADSHEET_ID is not set — cannot ledger removals, so nothing was trashed'],
      }, sweepEnabled);
      return { drained: true, batchId: batch.id, processed: 0, failed: 0, remaining: batch.pending.length, finished: false };
    }

    const token = await getDriveToken(DRIVE_SCOPE_READWRITE);

    // 1) Finish any sweep left over from a previous tick before making more work.
    if (sweepEnabled && batch.pendingSweep.length > 0) {
      const targets = [...batch.pendingSweep];
      const res = await removeShortcutsForTargets(targets, {
        eventId: batch.eventId,
        deadlineMs: deadline - FINALIZE_RESERVE_MS,
      });
      await commitSweep(batch.id, targets, res);
    }

    // 2) Trash a capped slice of the work list, committing each chunk.
    const queue = [...batch.pending];
    const trashedThisTick: string[] = [];
    let chunks = 0;
    while (queue.length > 0 && processed < MAX_FILES_PER_TICK) {
      // Always run one chunk. If a leftover sweep ate the budget, doing a little
      // work beats returning zero progress — otherwise a batch whose sweep keeps
      // filling the tick would never advance its work list at all.
      if (chunks > 0 && Date.now() >= deadline - FINALIZE_RESERVE_MS) break;
      chunks += 1;
      const chunk = queue.splice(0, TRASH_CHUNK).map(fromStored);
      const res = await trashDuplicateChunk(chunk, {
        eventId: batch.eventId,
        actorEmail: batch.createdBy,
        spreadsheetId,
        token,
      });
      processed += res.removed;
      failed += res.failed;
      trashedThisTick.push(...res.trashedIds);
      await commitChunk(
        batch.id,
        chunk.map((c) => c.dup.driveFileId),
        res,
        sweepEnabled,
      );
      // Every file in the chunk failed to trash and none is coming back — stop
      // burning the tick on a systemic failure (bad token, revoked access).
      if (res.removed === 0) break;
    }

    // 3) Retire the managed entries for what we just trashed.
    if (sweepEnabled && trashedThisTick.length > 0) {
      const res = await removeShortcutsForTargets(trashedThisTick, {
        eventId: batch.eventId,
        deadlineMs: deadline - FINALIZE_RESERVE_MS,
      });
      await commitSweep(batch.id, trashedThisTick, res);
    }
  } catch (err) {
    logger.warn({ err, batchId: batch.id, eventId: batch.eventId }, 'duplicate removal drain tick failed');
    await commitChunk(batch.id, [], {
      removed: 0,
      failed: 0,
      bytesReclaimed: 0,
      trashedIds: [],
      warnings: [`Drain tick failed (will retry): ${err instanceof Error ? err.message : String(err)}`],
    }, sweepEnabled);
  }

  const { justFinished } = await releaseLease(batch.id);
  if (justFinished && sweepEnabled) {
    // Once per batch, not once per tick — refreshing the public index is a whole
    // extra Sheet rewrite and nothing reads it mid-run.
    try {
      await tryRebuildPublicFolderIndex();
    } catch (err) {
      logger.warn({ err, batchId: batch.id }, 'duplicate removal: public index refresh failed (non-fatal)');
    }
  }

  const after = await batchRef(batch.id).get();
  const remaining =
    ((after.get('pending') as StoredItem[] | undefined) ?? []).length +
    ((after.get('pendingSweep') as string[] | undefined) ?? []).length;
  logger.info(
    {
      batchId: batch.id,
      eventId: batch.eventId,
      processed,
      failed,
      remaining,
      finished: justFinished,
      tickMs: Date.now() - start,
    },
    'duplicate removal drain tick',
  );
  return { drained: true, batchId: batch.id, processed, failed, remaining, finished: justFinished };
}

/** Read one batch (for UI polling). */
export async function getDuplicateBatch(id: string): Promise<DuplicateRemovalBatch | null> {
  const doc = await batchRef(id).get();
  return doc.exists ? ({ id: doc.id, ...doc.data() } as DuplicateRemovalBatch) : null;
}

/** Most recent batch, optionally for one event (for a UI with no id in hand). */
export async function latestDuplicateBatch(eventId?: string): Promise<DuplicateRemovalBatch | null> {
  let q = firestore().collection(COLLECTION).orderBy('createdAt', 'desc').limit(1);
  if (eventId) {
    q = firestore()
      .collection(COLLECTION)
      .where('eventId', '==', eventId)
      .orderBy('createdAt', 'desc')
      .limit(1);
  }
  const snap = await q.get();
  const doc = snap.docs[0];
  return doc ? ({ id: doc.id, ...doc.data() } as DuplicateRemovalBatch) : null;
}
