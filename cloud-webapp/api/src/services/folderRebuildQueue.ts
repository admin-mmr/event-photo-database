/**
 * folderRebuildQueue.ts — async, scale-to-zero-safe runner for the "all events"
 * managed-folder rebuilds.
 *
 * Why a queue instead of running inline: the api is fronted by Firebase Hosting
 * (60s rewrite cap) and Cloud Run with `--timeout=60`, and runs scale-to-zero
 * with CPU only during requests — so a single request can neither run a
 * Drive-heavy "rebuild every event" loop to completion (it 502s at 60s) nor do
 * background work after responding (CPU is throttled once the response is sent).
 *
 * Instead an enqueue request writes a *batch* doc to Firestore and returns 202
 * immediately. A Cloud Scheduler job (`findme-folder-rebuild`) POSTs
 * `/admin/folders/rebuild-drain` every couple of minutes; each drain claims
 * pending events one at a time (transactional, so overlapping drains never
 * double-process), rebuilds them until a soft time budget elapses, and the
 * drain that empties the batch refreshes the public folder index once and marks
 * the batch done. Progress lives in the batch doc so the web UI can poll it.
 *
 * Drive calls inside the rebuilds are already paced by driveRateLimit, so a big
 * batch simply spreads across several drain ticks rather than timing out.
 */

import { FieldValue } from '@google-cloud/firestore';

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import {
  rebuildEventPhotoFolders,
  rebuildAllSpecialFoldersForEvent,
  migrateEventPhotoShortcutsToFiles,
} from './specialFoldersService.js';
import { rebuildPublicFolderIndex } from './publicFolderIndexService.js';

/** What a batch rebuilds per event. Maps 1:1 to the synchronous service fns. */
export type RebuildKind = 'photos' | 'videos-albums' | 'migrate-shortcuts';

export type BatchStatus = 'running' | 'done';

export interface RebuildBatch {
  id: string;
  kind: RebuildKind;
  status: BatchStatus;
  total: number;
  /** Event IDs not yet claimed. */
  pending: string[];
  /** Event IDs rebuilt successfully. */
  done: string[];
  /** Event IDs that failed, with the error message. */
  failed: Array<{ eventId: string; error: string }>;
  /** Refresh the public folder index once the batch empties. */
  refreshPublic: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

const COLLECTION = 'folderRebuildBatches';

/** Soft budget for event processing in one drain call. Kept well under the
 *  60s Cloud Run/Hosting cap so the final public-index refresh + response have
 *  headroom; leftover events roll to the next scheduler tick. */
const DRAIN_BUDGET_MS = 40_000;

const now = (): string => new Date().toISOString();

function batchRef(id: string) {
  return firestore().collection(COLLECTION).doc(id);
}

/** Run one event through the rebuild for the given kind. Throws on failure so
 *  the caller can record it against the batch. */
async function rebuildOne(kind: RebuildKind, eventId: string): Promise<void> {
  if (kind === 'videos-albums') {
    await rebuildAllSpecialFoldersForEvent(eventId);
    return;
  }
  const r =
    kind === 'photos'
      ? await rebuildEventPhotoFolders(eventId)
      : await migrateEventPhotoShortcutsToFiles(eventId);
  if (!r.ok) throw new Error(r.message || `rebuild failed for ${eventId}`);
}

/**
 * Create a batch for `eventIds`. Returns the batch id + total. The work is done
 * later by drain ticks; nothing Drive-heavy runs here.
 */
export async function enqueueRebuild(
  kind: RebuildKind,
  eventIds: string[],
  opts: { createdBy: string; refreshPublic?: boolean },
): Promise<{ id: string; total: number }> {
  const ref = firestore().collection(COLLECTION).doc();
  const ts = now();
  const batch: Omit<RebuildBatch, 'id'> = {
    kind,
    status: 'running',
    total: eventIds.length,
    pending: [...eventIds],
    done: [],
    failed: [],
    refreshPublic: opts.refreshPublic ?? true,
    createdBy: opts.createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  await ref.set(batch);
  logger.info({ batchId: ref.id, kind, total: eventIds.length, by: opts.createdBy }, 'rebuild batch enqueued');
  return { id: ref.id, total: eventIds.length };
}

/** The oldest still-running batch, or null. */
async function oldestRunningBatch(): Promise<RebuildBatch | null> {
  const snap = await firestore()
    .collection(COLLECTION)
    .where('status', '==', 'running')
    .orderBy('createdAt', 'asc')
    .limit(1)
    .get();
  const doc = snap.docs[0];
  return doc ? ({ id: doc.id, ...doc.data() } as RebuildBatch) : null;
}

/** Atomically move the next pending event out of the batch so no other drain
 *  picks it up. Returns the claimed event id, or null if none remain. */
async function claimNext(id: string): Promise<string | null> {
  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(batchRef(id));
    if (!snap.exists) return null;
    const pending = (snap.get('pending') as string[] | undefined) ?? [];
    if (pending.length === 0) return null;
    const [next, ...rest] = pending;
    tx.update(batchRef(id), { pending: rest, updatedAt: now() });
    return next ?? null;
  });
}

/** Record a finished event against the batch. */
async function recordResult(id: string, eventId: string, error: string | null): Promise<void> {
  await batchRef(id).update(
    error
      ? { failed: FieldValue.arrayUnion({ eventId, error }), updatedAt: now() }
      : { done: FieldValue.arrayUnion(eventId), updatedAt: now() },
  );
}

/** Flip a fully-processed batch to `done` exactly once. Returns true only for
 *  the caller that performed the transition (so just it refreshes the public
 *  index). */
async function finalizeIfComplete(id: string): Promise<{ justFinished: boolean; refreshPublic: boolean }> {
  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(batchRef(id));
    if (!snap.exists) return { justFinished: false, refreshPublic: false };
    const b = snap.data() as Omit<RebuildBatch, 'id'>;
    const processed = (b.done?.length ?? 0) + (b.failed?.length ?? 0);
    const empty = (b.pending?.length ?? 0) === 0;
    if (b.status === 'running' && empty && processed >= b.total) {
      tx.update(batchRef(id), { status: 'done', finishedAt: now(), updatedAt: now() });
      return { justFinished: true, refreshPublic: b.refreshPublic ?? false };
    }
    return { justFinished: false, refreshPublic: false };
  });
}

export interface DrainSummary {
  drained: boolean;
  batchId?: string;
  processed: number;
  failed: number;
  remaining: number;
  finished: boolean;
}

/**
 * Process the oldest running batch for up to DRAIN_BUDGET_MS, then return. Cheap
 * no-op (one indexed query) when nothing is queued, so a frequent scheduler tick
 * costs almost nothing while idle.
 */
export async function drainRebuildQueue(budgetMs = DRAIN_BUDGET_MS): Promise<DrainSummary> {
  const batch = await oldestRunningBatch();
  if (!batch) return { drained: false, processed: 0, failed: 0, remaining: 0, finished: false };

  const start = Date.now();
  let processed = 0;
  let failed = 0;

  while (Date.now() - start < budgetMs) {
    const eventId = await claimNext(batch.id);
    if (!eventId) break;
    try {
      await rebuildOne(batch.kind, eventId);
      await recordResult(batch.id, eventId, null);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err, batchId: batch.id, eventId, kind: batch.kind }, 'rebuild batch event failed');
      await recordResult(batch.id, eventId, msg);
    }
    processed++;
  }

  const { justFinished, refreshPublic } = await finalizeIfComplete(batch.id);
  if (justFinished && refreshPublic) {
    try {
      await rebuildPublicFolderIndex();
    } catch (err) {
      logger.warn({ err, batchId: batch.id }, 'rebuild batch: public index refresh failed (non-fatal)');
    }
  }

  const after = await batchRef(batch.id).get();
  const remaining = ((after.get('pending') as string[] | undefined) ?? []).length;
  logger.info(
    { batchId: batch.id, kind: batch.kind, processed, failed, remaining, finished: justFinished },
    'rebuild drain tick',
  );
  return { drained: true, batchId: batch.id, processed, failed, remaining, finished: justFinished };
}

/** Read one batch (for UI polling). */
export async function getBatch(id: string): Promise<RebuildBatch | null> {
  const doc = await batchRef(id).get();
  return doc.exists ? ({ id: doc.id, ...doc.data() } as RebuildBatch) : null;
}

/** Most recently created batch, or null (for a UI with no batch id in hand). */
export async function latestBatch(): Promise<RebuildBatch | null> {
  const snap = await firestore().collection(COLLECTION).orderBy('createdAt', 'desc').limit(1).get();
  const doc = snap.docs[0];
  return doc ? ({ id: doc.id, ...doc.data() } as RebuildBatch) : null;
}
