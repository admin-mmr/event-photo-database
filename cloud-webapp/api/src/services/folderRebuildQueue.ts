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

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import {
  rebuildEventPhotoFolders,
  rebuildAllSpecialFoldersForEvent,
  migrateEventPhotoShortcutsToFiles,
  rebuildEventVideoFolders,
  rebuildEventAlbumFolders,
  countEventMedia,
} from './specialFoldersService.js';
import { rebuildPublicFolderIndex } from './publicFolderIndexService.js';

/**
 * What a batch rebuilds.
 *   - The "all events" kinds ('photos' | 'videos-albums' | 'migrate-shortcuts')
 *     map 1:1 to the synchronous service fns and process a LIST OF EVENTS, one
 *     event per claim (see `pending`/`done`/`failed`).
 *   - 'full' is a SINGLE-event full rebuild broken into ordered STEPS
 *     (Photos_NNN → Videos → Albums → public sheet). It used to run inline and
 *     trip the 60s cap (HTTP 502); now it drains step-by-step like the batches
 *     and reports per-step progress in `steps` so the UI can show a progress bar.
 */
export type RebuildKind = 'photos' | 'videos-albums' | 'migrate-shortcuts' | 'full';

/** Kinds processed by the per-event drain loop (everything except 'full'). */
type EventLoopKind = Exclude<RebuildKind, 'full'>;

export type BatchStatus = 'running' | 'done';

/** The ordered steps of a single-event 'full' rebuild. 'count' is a quick
 *  read-only pre-pass that surfaces how many photos/videos the rebuild will
 *  touch and pre-fills the later steps' denominators. */
export type StepKey = 'count' | 'photos' | 'videos' | 'albums' | 'public';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface StepProgress {
  key: StepKey;
  status: StepStatus;
  /** Denominator for the step (photos found / scopes to process / index rows). */
  total?: number;
  /** Numerator (Photos_NNN folders built / Videos|Album folders touched). */
  done?: number;
  /** Short human summary shown under the step label. */
  note?: string;
  /** Failure message when status === 'failed'. */
  error?: string;
  /** When the current attempt was claimed — used for stale-lease reclaim. */
  startedAt?: string;
}

export interface RebuildBatch {
  id: string;
  kind: RebuildKind;
  status: BatchStatus;
  total: number;
  /** Event IDs not yet claimed. */
  pending: string[];
  /** Events claimed by a drain but not yet finished, with the claim time. A
   *  drain that dies mid-event (e.g. the request 502s at the 60s cap) leaves its
   *  event here; once the lease expires another drain reclaims it instead of the
   *  event being lost — which used to strand a batch at "0 done, 0 failed". */
  inProgress?: Array<{ eventId: string; startedAt: string }>;
  /** Event IDs rebuilt successfully. */
  done: string[];
  /** Event IDs that failed, with the error message. */
  failed: Array<{ eventId: string; error: string }>;
  /** Refresh the public folder index once the batch empties. */
  refreshPublic: boolean;
  /** Single event a 'full' batch targets (undefined for the list kinds). */
  eventId?: string;
  /** Ordered step progress for a 'full' batch (undefined for the list kinds). */
  steps?: StepProgress[];
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

/** A step left 'running' longer than this (its drain died mid-step) is treated
 *  as abandoned and re-claimable. Every step is idempotent, so re-running just
 *  resumes — already-represented sources are skipped. */
const STEP_LEASE_MS = 90_000;

/** An event claimed by a drain that then died (its request 502'd at the 60s cap,
 *  or a transient network drop) is considered abandoned after this and becomes
 *  re-claimable. The per-event rebuilds are idempotent (already-represented
 *  sources are skipped), so a reclaim just resumes. Comfortably above the 60s
 *  request cap so a still-running event is never reclaimed out from under itself. */
const EVENT_LEASE_MS = 120_000;

const now = (): string => new Date().toISOString();

function batchRef(id: string) {
  return firestore().collection(COLLECTION).doc(id);
}

/** Run one event through the rebuild for the given kind. Throws on failure so
 *  the caller can record it against the batch. */
async function rebuildOne(kind: EventLoopKind, eventId: string): Promise<void> {
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
    inProgress: [],
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

/** The fixed, ordered steps of a single-event full rebuild. */
const FULL_STEP_KEYS: readonly StepKey[] = ['count', 'photos', 'videos', 'albums', 'public'] as const;

/**
 * Create a single-event 'full' rebuild batch (Photos_NNN → Videos → Albums →
 * public sheet). Returns the batch id. Drain ticks run the steps; nothing
 * Drive-heavy runs here. Replaces the old inline `rebuildAllSpecialFoldersForEvent`
 * call that 502'd at the 60s cap.
 */
export async function enqueueFullRebuild(
  eventId: string,
  opts: { createdBy: string },
): Promise<{ id: string; total: number }> {
  const ref = firestore().collection(COLLECTION).doc();
  const ts = now();
  const steps: StepProgress[] = FULL_STEP_KEYS.map((key) => ({ key, status: 'pending' }));
  const batch: Omit<RebuildBatch, 'id'> = {
    kind: 'full',
    status: 'running',
    total: 1,
    pending: [],
    done: [],
    failed: [],
    // Public-index refresh is an explicit step here, not the post-drain hook.
    refreshPublic: false,
    eventId,
    steps,
    createdBy: opts.createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  await ref.set(batch);
  logger.info({ batchId: ref.id, eventId, by: opts.createdBy }, 'full rebuild batch enqueued');
  return { id: ref.id, total: 1 };
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

/** Atomically claim the next event to process and record it as in-flight (with a
 *  claim timestamp) so no other drain picks it up. Prefers an in-flight event
 *  whose lease has expired (a previous drain died mid-event) and re-stamps it;
 *  otherwise pops the next pending event. Returns the claimed event id, or null
 *  if nothing is runnable right now. */
async function claimNext(id: string): Promise<string | null> {
  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(batchRef(id));
    if (!snap.exists) return null;
    const pending = (snap.get('pending') as string[] | undefined) ?? [];
    const inProgress = (snap.get('inProgress') as Array<{ eventId: string; startedAt: string }> | undefined) ?? [];
    const nowTs = now();
    const nowMs = Date.now();

    // 1) Reclaim the first abandoned in-flight event (lease expired), re-stamping it.
    const staleIdx = inProgress.findIndex((e) => nowMs - Date.parse(e.startedAt) > EVENT_LEASE_MS);
    if (staleIdx !== -1) {
      const reclaimed = inProgress[staleIdx]!.eventId;
      const updated = inProgress.map((e, i) => (i === staleIdx ? { eventId: e.eventId, startedAt: nowTs } : e));
      tx.update(batchRef(id), { inProgress: updated, updatedAt: nowTs });
      return reclaimed;
    }

    // 2) Otherwise claim the next pending event and move it to in-flight.
    if (pending.length === 0) return null;
    const [next, ...rest] = pending;
    if (!next) return null;
    tx.update(batchRef(id), {
      pending: rest,
      inProgress: [...inProgress, { eventId: next, startedAt: nowTs }],
      updatedAt: nowTs,
    });
    return next;
  });
}

/** Record a finished event against the batch and drop it from the in-flight
 *  list. Transactional (rather than arrayUnion) because in-flight entries carry
 *  a timestamp, and a reclaim may have produced more than one entry to clear. */
async function recordResult(id: string, eventId: string, error: string | null): Promise<void> {
  await firestore().runTransaction(async (tx) => {
    const snap = await tx.get(batchRef(id));
    if (!snap.exists) return;
    const inProgress = (snap.get('inProgress') as Array<{ eventId: string; startedAt: string }> | undefined) ?? [];
    const done = (snap.get('done') as string[] | undefined) ?? [];
    const failed = (snap.get('failed') as Array<{ eventId: string; error: string }> | undefined) ?? [];
    const remainingInFlight = inProgress.filter((e) => e.eventId !== eventId);
    const patch: Record<string, unknown> = { inProgress: remainingInFlight, updatedAt: now() };
    if (error) {
      if (!failed.some((f) => f.eventId === eventId)) patch.failed = [...failed, { eventId, error }];
    } else if (!done.includes(eventId)) {
      patch.done = [...done, eventId];
    }
    tx.update(batchRef(id), patch);
  });
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
    const empty = (b.pending?.length ?? 0) === 0 && (b.inProgress?.length ?? 0) === 0;
    if (b.status === 'running' && empty && processed >= b.total) {
      tx.update(batchRef(id), { status: 'done', finishedAt: now(), updatedAt: now() });
      return { justFinished: true, refreshPublic: b.refreshPublic ?? false };
    }
    return { justFinished: false, refreshPublic: false };
  });
}

// ─── 'full' single-event step drain ──────────────────────────────────────────

/** Claim the next runnable step (the first 'pending', or a 'running' one whose
 *  lease has expired) and mark it 'running'. Returns its key, or null if every
 *  step is terminal / freshly running. Transactional so overlapping drains never
 *  run the same step at once. */
async function claimNextStep(id: string): Promise<StepKey | null> {
  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(batchRef(id));
    if (!snap.exists) return null;
    const steps = (snap.get('steps') as StepProgress[] | undefined) ?? [];
    const nowMs = Date.now();
    const idx = steps.findIndex(
      (s) =>
        s.status === 'pending' ||
        (s.status === 'running' && s.startedAt != null && nowMs - Date.parse(s.startedAt) > STEP_LEASE_MS),
    );
    if (idx === -1) return null;
    const updated = steps.map((s, i) =>
      i === idx ? { ...s, status: 'running' as StepStatus, startedAt: now() } : s,
    );
    tx.update(batchRef(id), { steps: updated, updatedAt: now() });
    return steps[idx]!.key;
  });
}

/** A step field patch. Values may be `undefined` (the runStep counts are
 *  optional); patchStep drops those so Firestore never sees an undefined. */
interface StepPatch {
  status?: StepStatus;
  total?: number | undefined;
  done?: number | undefined;
  note?: string | undefined;
  error?: string | undefined;
}

/** Merge a patch into one step (skipping `undefined` so Firestore never sees it). */
async function patchStep(id: string, key: StepKey, patch: StepPatch): Promise<void> {
  await firestore().runTransaction(async (tx) => {
    const snap = await tx.get(batchRef(id));
    if (!snap.exists) return;
    const steps = (snap.get('steps') as StepProgress[] | undefined) ?? [];
    const updated = steps.map((s) => {
      if (s.key !== key) return s;
      const merged: Record<string, unknown> = { ...s };
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) merged[k] = v;
      return merged as unknown as StepProgress;
    });
    tx.update(batchRef(id), { steps: updated, updatedAt: now() });
  });
}

type StepOutcome = {
  total?: number;
  done?: number;
  note?: string;
  /** Totals to pre-fill on OTHER steps (the count step seeds the denominators). */
  siblingTotals?: Partial<Record<StepKey, number>>;
};

/** Run one step's Drive work. Throws only on a fundamental failure (missing
 *  Sheet / event); per-scope hiccups are folded into the note as warnings. */
async function runStep(eventId: string, key: StepKey): Promise<StepOutcome> {
  if (key === 'count') {
    const c = await countEventMedia(eventId);
    return {
      total: c.media,
      done: c.media,
      note: `${c.photos} photo(s), ${c.videos} video(s)`,
      siblingTotals: { photos: c.photos, videos: c.videos, albums: c.media },
    };
  }
  if (key === 'photos') {
    const r = await rebuildEventPhotoFolders(eventId);
    if (!r.ok) throw new Error(r.message || 'photo rebuild failed');
    const d = r.data;
    return { total: d?.targetFilesScanned ?? 0, done: d?.foldersTouched ?? 0, note: r.message };
  }
  if (key === 'videos' || key === 'albums') {
    const r = key === 'videos' ? await rebuildEventVideoFolders(eventId) : await rebuildEventAlbumFolders(eventId);
    const warn = r.warnings.length ? `, ${r.warnings.length} warning(s)` : '';
    return {
      total: r.scopesProcessed,
      done: r.foldersTouched,
      note: `${r.shortcutsCreated} new, ${r.shortcutsExisting} existing${warn}`,
    };
  }
  // key === 'public'
  const rows = await rebuildPublicFolderIndex();
  return { total: rows, done: rows, note: `${rows} row(s)` };
}

/** Flip a 'full' batch to done once every step is terminal (done/failed). */
async function finalizeFullIfComplete(id: string): Promise<boolean> {
  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(batchRef(id));
    if (!snap.exists) return false;
    const b = snap.data() as Omit<RebuildBatch, 'id'>;
    const steps = b.steps ?? [];
    const allTerminal = steps.length > 0 && steps.every((s) => s.status === 'done' || s.status === 'failed');
    if (b.status === 'running' && allTerminal) {
      tx.update(batchRef(id), { status: 'done', finishedAt: now(), updatedAt: now() });
      return true;
    }
    return false;
  });
}

/** Drain a single-event 'full' batch step-by-step within the budget. Each step
 *  is bounded Drive work that fits the 60s cap, so the request never 502s. */
async function drainFullBatch(batch: RebuildBatch, budgetMs: number): Promise<DrainSummary> {
  const eventId = batch.eventId ?? '';
  const start = Date.now();
  let processed = 0;
  let failed = 0;

  while (Date.now() - start < budgetMs) {
    const key = await claimNextStep(batch.id);
    if (!key) break;
    try {
      const out = await runStep(eventId, key);
      await patchStep(batch.id, key, { status: 'done', total: out.total, done: out.done, note: out.note });
      // Seed the later steps' denominators from the count pre-pass.
      if (out.siblingTotals) {
        for (const [sibling, total] of Object.entries(out.siblingTotals)) {
          await patchStep(batch.id, sibling as StepKey, { total });
        }
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err, batchId: batch.id, eventId, step: key }, 'full rebuild step failed');
      await patchStep(batch.id, key, { status: 'failed', error: msg });
    }
    processed++;
  }

  const justFinished = await finalizeFullIfComplete(batch.id);
  const after = await batchRef(batch.id).get();
  const steps = (after.get('steps') as StepProgress[] | undefined) ?? [];
  const remaining = steps.filter((s) => s.status === 'pending' || s.status === 'running').length;
  logger.info({ batchId: batch.id, eventId, processed, failed, remaining, finished: justFinished }, 'full rebuild drain tick');
  return { drained: true, batchId: batch.id, processed, failed, remaining, finished: justFinished };
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

  // Single-event 'full' rebuilds drain by ordered step, not by event.
  if (batch.kind === 'full') return drainFullBatch(batch, budgetMs);

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
  const remaining =
    ((after.get('pending') as string[] | undefined) ?? []).length +
    ((after.get('inProgress') as unknown[] | undefined) ?? []).length;
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
