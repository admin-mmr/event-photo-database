/**
 * syncQueueService.ts — Sheet-backed queue for Drive → Google Photos sync jobs.
 *
 * Phase 4 introduces an asynchronous sync pipeline to replace the synchronous
 * `syncBatchToAlbums()` call that previously blocked the upload response:
 *
 *   Upload completes
 *     → enqueueBatchSync() writes a 'pending' row to Sync_Queue
 *     → upload response is returned immediately to the client
 *
 *   [every 5 minutes, via time-trigger]
 *   drainSyncQueue() picks up to SYNC_DRAIN_BATCH_SIZE pending rows,
 *     → marks each in_progress
 *     → calls photosService.syncBatchToAlbums()
 *     → marks done or failed (up to MAX_SYNC_ATTEMPTS retries)
 *
 * Why a Sheet queue instead of PropertiesService?
 *   The syncJobService already uses PropertiesService for short-lived admin
 *   progress tracking (suitable for <1 h jobs). The Sync_Queue needs durable
 *   persistence across multiple trigger invocations and may grow to thousands
 *   of rows over the life of the project. Sheets handles this without a size
 *   limit concern and makes the queue human-inspectable in the admin spreadsheet.
 *
 * Stuck-item recovery:
 *   If a GAS execution is killed at the 6-minute wall-clock limit while a row
 *   is in_progress, the row is never marked done/failed. The drain detects items
 *   stuck in_progress for longer than SYNC_STUCK_THRESHOLD_MINUTES and resets
 *   them to pending so the next run can retry them.
 */

import { getConfig, COLUMNS, SYNC_QUEUE_HEADERS, MAX_SYNC_ATTEMPTS, SYNC_STUCK_THRESHOLD_MINUTES, SYNC_DRAIN_BATCH_SIZE } from '../config/constants';
import { SyncQueueStatus } from '../types/enums';
import { SyncQueueRecord } from '../types/models';
import { toSyncQueueRecord, fromSyncQueueRecord } from '../utils/sheetMapper';
import { getAllRows, appendRow, updateRow, findRowIndex, ensureHeaders } from './sheetService';

/* global Utilities, Logger */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sheetName(): string {
  return getConfig().SHEET_NAMES.SYNC_QUEUE;
}

/** Generates a UUID v4 string for use as queueId. */
function newUuid(): string {
  return Utilities.getUuid();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Writes a new 'pending' row to the Sync_Queue sheet.
 *
 * Called by serverCompleteUpload and serverCompleteVolunteerUpload immediately
 * after an upload session completes. Does NOT perform any Drive or Photos API
 * call — that is deferred to the next drainSyncQueue() invocation.
 *
 * Idempotency note: duplicate (eventId, clubName, batchFolderId) rows are
 * harmless — each will produce at most one Photos sync attempt; the Photos
 * deduplication layer (Photo_Files sheet) prevents double-uploading the same
 * Drive file to the same album.
 */
export function enqueueBatchSync(params: {
  eventId:         string;
  clubName:        string;
  tag:             string;
  batchFolderId:   string;
  batchFolderName: string;
}): SyncQueueRecord {
  const name = sheetName();
  ensureHeaders(name, [...SYNC_QUEUE_HEADERS]);

  const record: SyncQueueRecord = {
    queueId:        newUuid(),
    eventId:        params.eventId,
    clubName:       params.clubName,
    tag:            params.tag,
    batchFolderId:  params.batchFolderId,
    batchFolderName: params.batchFolderName,
    enqueuedAt:     new Date().toISOString(),
    status:         SyncQueueStatus.PENDING,
    attempts:       0,
    lastAttemptAt:  '',
    errorMsg:       '',
    completedAt:    '',
  };

  appendRow(name, fromSyncQueueRecord(record));
  Logger.log(`[SyncQueueService.enqueueBatchSync] Queued ${record.queueId} — event=${params.eventId} club=${params.clubName} tag=${params.tag} batch=${params.batchFolderName}`);
  return record;
}

/**
 * Returns all rows from the Sync_Queue sheet, parsed to SyncQueueRecord.
 * Invalid rows are silently skipped (defensive against schema drift or manual edits).
 */
export function getAllQueueItems(): SyncQueueRecord[] {
  const rows = getAllRows(sheetName());
  const items: SyncQueueRecord[] = [];
  for (const row of rows) {
    const record = toSyncQueueRecord(row);
    if (record) items.push(record);
  }
  return items;
}

/**
 * Context returned by loadPendingItemsWithContext().
 * Contains the pending item list plus everything the drain loop needs to
 * perform batched sheet writes without additional getAllRows() calls.
 */
export interface SyncQueueDrainContext {
  /** Items ready to process (pending + reset-stuck). At most SYNC_DRAIN_BATCH_SIZE. */
  items:     SyncQueueRecord[];
  /** queueId → { 1-based rowIndex, current record } for the entire sheet. */
  rowMap:    Map<string, { rowIndex: number; record: SyncQueueRecord }>;
  /** Raw sheet rows (0-based, no header) as loaded by this call. */
  allRows:   unknown[][];
  /** Sheet tab name (for passing to batchUpdateRows). */
  sheetName: string;
}

/**
 * Loads pending queue items and returns them alongside the full row map and
 * raw rows — all from a single getAllRows() call.
 *
 * Prefer this over loadPendingItems() when the drain loop will perform batched
 * sheet writes, since it eliminates a second sheet read.
 *
 * Stuck in_progress items are reset to pending with individual updateRow()
 * calls before returning (these are rare and not worth batching).
 */
export function loadPendingItemsWithContext(): SyncQueueDrainContext {
  const name = sheetName();
  const allRows = getAllRows(name);
  const now = new Date();
  const stuckThresholdMs = SYNC_STUCK_THRESHOLD_MINUTES * 60 * 1000;

  const pending: SyncQueueRecord[] = [];
  const rowMap = new Map<string, { rowIndex: number; record: SyncQueueRecord }>();

  for (let i = 0; i < allRows.length; i++) {
    const record = toSyncQueueRecord(allRows[i]);
    if (!record) continue;

    const rowIndex = i + 2; // +1 for 0→1-base, +1 for skipped header

    if (record.status === SyncQueueStatus.PENDING) {
      pending.push(record);
      rowMap.set(record.queueId, { rowIndex, record });
    } else if (record.status === SyncQueueStatus.IN_PROGRESS) {
      let effectiveRecord = record;
      if (record.lastAttemptAt) {
        const ageMs = now.getTime() - new Date(record.lastAttemptAt).getTime();
        if (ageMs > stuckThresholdMs) {
          Logger.log(
            `[SyncQueueService.loadPendingItemsWithContext] Stuck item: ${record.queueId} ` +
            `(${Math.round(ageMs / 60000)} min) — resetting to pending`
          );
          effectiveRecord = { ...record, status: SyncQueueStatus.PENDING };
          updateRow(name, rowIndex, fromSyncQueueRecord(effectiveRecord));
          pending.push(effectiveRecord);
        }
      }
      rowMap.set(record.queueId, { rowIndex, record: effectiveRecord });
    } else {
      // done / failed — include in rowMap so Phase A can find them if needed
      rowMap.set(record.queueId, { rowIndex, record });
    }

    if (pending.length >= SYNC_DRAIN_BATCH_SIZE) break;
  }

  return { items: pending, rowMap, allRows, sheetName: name };
}

/**
 * Returns queue items suitable for the next drain run:
 *   1. All rows with status = 'pending'
 *   2. Rows with status = 'in_progress' stuck for > SYNC_STUCK_THRESHOLD_MINUTES.
 *
 * Returns at most SYNC_DRAIN_BATCH_SIZE items, oldest-first (FIFO).
 * Stuck items are reset to pending (single updateRow per item — rare).
 *
 * Delegates to loadPendingItemsWithContext(). Prefer that function when the
 * caller also needs the row map for batched sheet writes.
 */
export function loadPendingItems(): SyncQueueRecord[] {
  return loadPendingItemsWithContext().items;
}

/**
 * Builds a queueId → { 1-based rowIndex, record } lookup from pre-loaded rows.
 * Exported for testing and for callers that already have allRows in memory.
 */
export function buildQueueRowMap(
  allRows: unknown[][]
): Map<string, { rowIndex: number; record: SyncQueueRecord }> {
  const map = new Map<string, { rowIndex: number; record: SyncQueueRecord }>();
  for (let i = 0; i < allRows.length; i++) {
    const record = toSyncQueueRecord(allRows[i]);
    if (record) {
      map.set(record.queueId, { rowIndex: i + 2, record });
    }
  }
  return map;
}

/**
 * Pure function — returns the in-progress version of a record.
 * Does not touch the sheet; persist with batchUpdateRows.
 */
export function computeInProgressUpdate(
  record: SyncQueueRecord,
  now = new Date()
): SyncQueueRecord {
  return {
    ...record,
    status:        SyncQueueStatus.IN_PROGRESS,
    attempts:      record.attempts + 1,
    lastAttemptAt: now.toISOString(),
  };
}

/**
 * Pure function — returns the done version of a record.
 */
export function computeDoneUpdate(
  record: SyncQueueRecord,
  now = new Date()
): SyncQueueRecord {
  return {
    ...record,
    status:      SyncQueueStatus.DONE,
    completedAt: now.toISOString(),
    errorMsg:    '',
  };
}

/**
 * Pure function — returns the failed or re-queued version of a record after a
 * failed sync attempt. Marks permanently FAILED if record.attempts ≥
 * MAX_SYNC_ATTEMPTS (pass the record returned by computeInProgressUpdate so
 * the incremented attempts count is reflected). Otherwise resets to PENDING.
 */
export function computeFailedUpdate(
  record: SyncQueueRecord,
  errorMsg: string
): SyncQueueRecord {
  const exhausted = record.attempts >= MAX_SYNC_ATTEMPTS;
  if (exhausted) {
    Logger.log(
      `[SyncQueueService.computeFailedUpdate] queueId ${record.queueId} exhausted ` +
      `${MAX_SYNC_ATTEMPTS} attempts — marking FAILED`
    );
  }
  return {
    ...record,
    status:   exhausted ? SyncQueueStatus.FAILED : SyncQueueStatus.PENDING,
    errorMsg: errorMsg.substring(0, 500),
  };
}

/**
 * Marks a queue item as 'in_progress'.
 * Called at the start of processing each item in the drain loop.
 * Increments attempts and records lastAttemptAt.
 *
 * Returns the updated record, or null if the item's row cannot be found
 * (e.g., if the sheet was manually edited between loadPendingItems and this call).
 */
export function markInProgress(queueId: string): SyncQueueRecord | null {
  const name = sheetName();
  const col = COLUMNS.SYNC_QUEUE;
  const rowIndex = findRowIndex(name, col.QUEUE_ID, queueId);
  if (rowIndex < 0) {
    Logger.log(`[SyncQueueService.markInProgress] queueId ${queueId} not found in sheet`);
    return null;
  }

  const rows = getAllRows(name);
  const existing = toSyncQueueRecord(rows[rowIndex - 2]); // convert 1-based back to 0-based data index
  if (!existing) return null;

  const updated: SyncQueueRecord = {
    ...existing,
    status:        SyncQueueStatus.IN_PROGRESS,
    attempts:      existing.attempts + 1,
    lastAttemptAt: new Date().toISOString(),
  };
  updateRow(name, rowIndex, fromSyncQueueRecord(updated));
  return updated;
}

/**
 * Marks a queue item as 'done' after a successful sync.
 */
export function markDone(queueId: string): void {
  const name = sheetName();
  const col = COLUMNS.SYNC_QUEUE;
  const rowIndex = findRowIndex(name, col.QUEUE_ID, queueId);
  if (rowIndex < 0) return;

  const rows = getAllRows(name);
  const existing = toSyncQueueRecord(rows[rowIndex - 2]);
  if (!existing) return;

  const updated: SyncQueueRecord = {
    ...existing,
    status:      SyncQueueStatus.DONE,
    completedAt: new Date().toISOString(),
    errorMsg:    '',
  };
  updateRow(name, rowIndex, fromSyncQueueRecord(updated));
}

/**
 * Records a failed sync attempt.
 *
 * If `existing.attempts` has reached MAX_SYNC_ATTEMPTS, permanently marks
 * the item 'failed' so the drain loop stops retrying it.
 * Otherwise resets to 'pending' so the next drain run will retry.
 */
export function markAttemptFailed(queueId: string, errorMsg: string): void {
  const name = sheetName();
  const col = COLUMNS.SYNC_QUEUE;
  const rowIndex = findRowIndex(name, col.QUEUE_ID, queueId);
  if (rowIndex < 0) return;

  const rows = getAllRows(name);
  const existing = toSyncQueueRecord(rows[rowIndex - 2]);
  if (!existing) return;

  const exhausted = existing.attempts >= MAX_SYNC_ATTEMPTS;
  const updated: SyncQueueRecord = {
    ...existing,
    status:   exhausted ? SyncQueueStatus.FAILED : SyncQueueStatus.PENDING,
    errorMsg: errorMsg.substring(0, 500), // Truncate to avoid Sheets cell limit
  };

  if (exhausted) {
    Logger.log(`[SyncQueueService.markAttemptFailed] queueId ${queueId} exhausted ${MAX_SYNC_ATTEMPTS} attempts — marking FAILED`);
  }

  updateRow(name, rowIndex, fromSyncQueueRecord(updated));
}

/**
 * Returns a lightweight status summary for the admin UI.
 * Called by serverGetSyncQueueStatus — must be fast (no Photos API calls).
 */
export function getQueueStatus(): {
  pending:    number;
  inProgress: number;
  done:       number;
  failed:     number;
  total:      number;
  oldestPendingAt: string; // ISO 8601 of oldest pending item; empty if none
} {
  const items = getAllQueueItems();
  let pending = 0, inProgress = 0, done = 0, failed = 0;
  let oldestPendingAt = '';

  for (const item of items) {
    switch (item.status) {
      case SyncQueueStatus.PENDING:
        pending++;
        if (!oldestPendingAt || item.enqueuedAt < oldestPendingAt) {
          oldestPendingAt = item.enqueuedAt;
        }
        break;
      case SyncQueueStatus.IN_PROGRESS: inProgress++; break;
      case SyncQueueStatus.DONE:        done++;        break;
      case SyncQueueStatus.FAILED:      failed++;      break;
    }
  }

  return { pending, inProgress, done, failed, total: items.length, oldestPendingAt };
}
