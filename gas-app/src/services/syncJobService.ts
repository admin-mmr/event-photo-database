/**
 * SyncJobService — progress tracking for long-running Photos operations.
 *
 * Why this exists
 * ───────────────
 * Photos backfills / event syncs walk every club → every batch → every photo
 * and can easily run 10+ minutes for a large archive. `google.script.run` is
 * a blocking RPC from the admin's browser — without any signal in between,
 * the UI just shows "Working…" for the whole duration and the admin has no
 * idea whether the job is healthy, stuck, or finished.
 *
 * This service gives the Photos page a way to:
 *   1. Generate a jobId before kicking off the worker call.
 *   2. Poll job state every ~3s in parallel with the worker call (google.script.run
 *      calls run concurrently on the server).
 *   3. Render a progress bar + current step + counts while the worker runs.
 *   4. Request cancellation mid-run; the worker checks the flag between units
 *      of work and aborts gracefully.
 *
 * Storage
 * ───────
 * Job state is persisted in `PropertiesService.getScriptProperties()` under
 * keys of the form `sync_job_<uuid>`. Properties are fast (single-digit ms),
 * survive GAS execution boundaries, and don't spam the Sheets DB with one
 * write per photo. Values are JSON-serialised `SyncJob` objects.
 *
 * Completed jobs are kept for 24 hours so the UI can show the final state
 * after a page refresh, then cleaned up opportunistically by `sweepExpired()`.
 */

/* global PropertiesService */

import { generateUuid } from '../utils/uuid';
import { nowIsoTimestamp } from '../utils/dateFormatter';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Top-level operation the job represents. Used only for UI labels/filtering. */
export type SyncJobType = 'sync-event' | 'backfill-all';

export type SyncJobStatus =
  | 'pending'    // created, worker hasn't started yet
  | 'running'    // worker is actively making progress
  | 'completed'  // worker finished successfully
  | 'failed'     // worker threw or returned ERROR
  | 'cancelled'; // admin clicked Cancel and worker stopped

/**
 * The persisted shape of a sync job. All fields are optional on the wire so
 * old records written by older code still deserialise; defaults are applied
 * in `getJob()`.
 */
export interface SyncJob {
  jobId:            string;
  jobType:          SyncJobType;
  status:           SyncJobStatus;

  /** Event UUID if this is a per-event sync; empty for backfill-all. */
  eventId:          string;

  /** Human-readable current step, e.g. "Syncing 'Misty Mountain' → batch 2/4". */
  currentStep:      string;

  /** Total photos the worker plans to process (0 if unknown upfront). */
  totalPhotos:      number;

  /** Photos successfully uploaded so far. */
  photosSynced:     number;

  /** Photos skipped (wrong MIME type). */
  photosSkipped:    number;

  /** Photos already in Photo_Files (dedup). */
  photosDeduplicated: number;

  /** Albums created this run. */
  albumsCreated:    number;

  /** Per-event counts (used by backfill-all). */
  eventsProcessed:  number;
  eventsTotal:      number;

  /** Error messages collected so far (non-fatal). */
  errors:           string[];

  /** Set to true by `requestCancel`; polled by the worker. */
  cancelRequested:  boolean;

  /** Final human-readable message shown when status is completed/failed/cancelled. */
  finalMessage:     string;

  startedAt:        string;
  updatedAt:        string;

  /** ISO timestamp when the record becomes eligible for cleanup. */
  expiresAt:        string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const KEY_PREFIX = 'sync_job_';

/** How long a terminal (completed/failed/cancelled) job is kept around. */
const TERMINAL_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Fallback TTL for running jobs that never complete (process killed, etc.). */
const RUNNING_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// ─── Helpers ──────────────────────────────────────────────────────────────────

function propKey(jobId: string): string {
  return `${KEY_PREFIX}${jobId}`;
}

function emptyJob(jobId: string, jobType: SyncJobType, eventId: string): SyncJob {
  const now = nowIsoTimestamp();
  return {
    jobId,
    jobType,
    status:             'pending',
    eventId,
    currentStep:        'Initializing…',
    totalPhotos:        0,
    photosSynced:       0,
    photosSkipped:      0,
    photosDeduplicated: 0,
    albumsCreated:      0,
    eventsProcessed:    0,
    eventsTotal:        0,
    errors:             [],
    cancelRequested:    false,
    finalMessage:       '',
    startedAt:          now,
    updatedAt:          now,
    expiresAt:          new Date(Date.now() + RUNNING_TTL_MS).toISOString(),
  };
}

function writeJob(job: SyncJob): void {
  job.updatedAt = nowIsoTimestamp();
  PropertiesService.getScriptProperties().setProperty(
    propKey(job.jobId),
    JSON.stringify(job)
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Creates a new job record in 'pending' state and returns it. The worker
 * should transition it to 'running' on its first progress update.
 */
export function createJob(jobType: SyncJobType, eventId = ''): SyncJob {
  const job = emptyJob(generateUuid(), jobType, eventId);
  writeJob(job);
  return job;
}

/**
 * Fetches a job by id, or null if the record is gone (expired / invalid id).
 *
 * Merges stored values over `emptyJob()` defaults so older records without
 * newer fields still deserialise cleanly.
 */
export function getJob(jobId: string): SyncJob | null {
  const raw = PropertiesService.getScriptProperties().getProperty(propKey(jobId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SyncJob>;
    const defaults = emptyJob(jobId, parsed.jobType ?? 'sync-event', parsed.eventId ?? '');
    return { ...defaults, ...parsed } as SyncJob;
  } catch {
    return null;
  }
}

/**
 * Applies a partial update to a job atomically (read → merge → write).
 * Always transitions status from 'pending' to 'running' on first update
 * unless the caller explicitly passes a terminal status.
 */
export function updateJob(jobId: string, patch: Partial<SyncJob>): SyncJob | null {
  const existing = getJob(jobId);
  if (!existing) return null;

  // Auto-promote pending → running on the first progress update
  const nextStatus: SyncJobStatus =
    patch.status ??
    (existing.status === 'pending' ? 'running' : existing.status);

  const merged: SyncJob = {
    ...existing,
    ...patch,
    status: nextStatus,
    // Preserve the errors array: concat if caller sent new errors, else keep
    errors: patch.errors ? [...existing.errors, ...patch.errors] : existing.errors,
  };

  writeJob(merged);
  return merged;
}

/**
 * Convenience: adjust a running counter without reading-and-spreading the
 * whole record in the caller.
 */
export function incrementJobCounters(
  jobId: string,
  deltas: Partial<Pick<
    SyncJob,
    'photosSynced' | 'photosSkipped' | 'photosDeduplicated' |
    'albumsCreated' | 'eventsProcessed'
  >>,
  currentStep?: string
): SyncJob | null {
  const existing = getJob(jobId);
  if (!existing) return null;

  const patch: Partial<SyncJob> = {
    photosSynced:       existing.photosSynced       + (deltas.photosSynced       ?? 0),
    photosSkipped:      existing.photosSkipped      + (deltas.photosSkipped      ?? 0),
    photosDeduplicated: existing.photosDeduplicated + (deltas.photosDeduplicated ?? 0),
    albumsCreated:      existing.albumsCreated      + (deltas.albumsCreated      ?? 0),
    eventsProcessed:    existing.eventsProcessed    + (deltas.eventsProcessed    ?? 0),
  };
  if (currentStep !== undefined) patch.currentStep = currentStep;

  return updateJob(jobId, patch);
}

/**
 * Marks a job terminal. The record is kept for TERMINAL_TTL_MS so the UI can
 * render the final summary even after a page refresh.
 */
export function completeJob(
  jobId: string,
  status: 'completed' | 'failed' | 'cancelled',
  finalMessage: string
): SyncJob | null {
  const existing = getJob(jobId);
  if (!existing) return null;
  const now = nowIsoTimestamp();
  const merged: SyncJob = {
    ...existing,
    status,
    finalMessage,
    currentStep: status === 'completed' ? 'Done' : status === 'cancelled' ? 'Cancelled' : 'Failed',
    updatedAt:  now,
    expiresAt:  new Date(Date.now() + TERMINAL_TTL_MS).toISOString(),
  };
  writeJob(merged);
  return merged;
}

/**
 * Sets the cancel flag. The worker is responsible for checking
 * `isCancelRequested()` between units of work and calling `completeJob(…, 'cancelled')`.
 *
 * Returns true if the request was recorded; false if the job doesn't exist or
 * is already in a terminal state.
 */
export function requestCancel(jobId: string): boolean {
  const existing = getJob(jobId);
  if (!existing) return false;
  if (existing.status === 'completed' ||
      existing.status === 'failed'    ||
      existing.status === 'cancelled') {
    return false;
  }
  writeJob({ ...existing, cancelRequested: true });
  return true;
}

/** Non-mutating check used by the worker between loop iterations. */
export function isCancelRequested(jobId: string): boolean {
  return getJob(jobId)?.cancelRequested === true;
}

/**
 * Best-effort cleanup of expired job records. Called opportunistically by
 * `createJob()` so the property store doesn't grow unbounded.
 *
 * GAS Properties limits: 9 kB per value, 500 kB total per scope. Each SyncJob
 * serialises to ~600 bytes, so we can hold ~800 concurrent records — plenty of
 * headroom, but this sweeper keeps it tidy.
 */
export function sweepExpired(): number {
  const props = PropertiesService.getScriptProperties();
  const all   = props.getProperties();
  const now   = Date.now();
  let removed = 0;
  for (const key of Object.keys(all)) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    try {
      const job = JSON.parse(all[key]) as SyncJob;
      if (job.expiresAt && Date.parse(job.expiresAt) < now) {
        props.deleteProperty(key);
        removed++;
      }
    } catch {
      // Corrupt record — drop it
      props.deleteProperty(key);
      removed++;
    }
  }
  return removed;
}
