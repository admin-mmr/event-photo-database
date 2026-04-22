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
  eventId:        string;
  clubName:       string;
  batchFolderId:  string;
  batchFolderName: string;
}): SyncQueueRecord {
  const name = sheetName();
  ensureHeaders(name, [...SYNC_QUEUE_HEADERS]);

  const record: SyncQueueRecord = {
    queueId:        newUuid(),
    eventId:        params.eventId,
    clubName:       params.clubName,
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
  Logger.log(`[SyncQueueService.enqueueBatchSync] Queued ${record.queueId} — event=${params.eventId} club=${params.clubName} batch=${params.batchFolderName}`);
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
 * Returns queue items suitable for the next drain run:
 *   1. All rows with status = 'pending'
 *   2. Rows with status = 'in_progress' that have been stuck for more than
 *      SYNC_STUCK_THRESHOLD_MINUTES (rescheduled as pending by this call).
 *
 * Returns at most SYNC_DRAIN_BATCH_SIZE items, oldest-first, so the queue
 * drains in FIFO order.
 *
 * Side effect: stuck in_progress rows are reset to pending in the sheet
 * before this function returns, so that each row is only returned once even
 * if this function is called multiple times within a single script execution.
 */
export function loadPendingItems(): SyncQueueRecord[] {
  const name = sheetName();
  const allRows = getAllRows(name);
  const now = new Date();
  const stuckThresholdMs = SYNC_STUCK_THRESHOLD_MINUTES * 60 * 1000;

  const pending: SyncQueueRecord[] = [];

  for (let i = 0; i < allRows.length; i++) {
    const record = toSyncQueueRecord(allRows[i]);
    if (!record) continue;

    if (record.status === SyncQueueStatus.PENDING) {
      pending.push(record);
    } else if (record.status === SyncQueueStatus.IN_PROGRESS) {
      // Check if stuck
      if (record.lastAttemptAt) {
        const lastAttempt = new Date(record.lastAttemptAt);
        const ageMs = now.getTime() - lastAttempt.getTime();
        if (ageMs > stuckThresholdMs) {
          Logger.log(`[SyncQueueService.loadPendingItems] Stuck item detected: ${record.queueId} (${Math.round(ageMs / 60000)} min old) — resetting to pending`);
          // Reset to pending so it gets retried
          const rowIndex = i + 2; // +1 for 0→1 base, +1 for header
          const updated: SyncQueueRecord = {
            ...record,
            status: SyncQueueStatus.PENDING,
          };
          updateRow(name, rowIndex, fromSyncQueueRecord(updated));
          pending.push(updated);
        }
      }
    }

    if (pending.length >= SYNC_DRAIN_BATCH_SIZE) break;
  }

  return pending;
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
