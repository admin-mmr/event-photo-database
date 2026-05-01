/**
 * syncQueueService.test.ts — Unit tests for the Sheet-backed sync queue.
 *
 * Coverage:
 *   enqueueBatchSync()    — writes pending row, returns record
 *   getAllQueueItems()    — parses rows, drops malformed
 *   loadPendingItems()    — returns pending; resets stuck in_progress; caps at batch size
 *   markInProgress()      — increments attempts, sets status + lastAttemptAt
 *   markDone()            — sets done status + completedAt
 *   markAttemptFailed()   — resets to pending or marks failed at max attempts; truncates msg
 *   getQueueStatus()      — counts per status; oldestPendingAt logic
 */

import {
  enqueueBatchSync,
  getAllQueueItems,
  loadPendingItems,
  loadPendingItemsWithContext,
  buildQueueRowMap,
  computeInProgressUpdate,
  computeDoneUpdate,
  computeFailedUpdate,
  markInProgress,
  markDone,
  markAttemptFailed,
  getQueueStatus,
} from '../../src/services/syncQueueService';
import { SyncQueueStatus } from '../../src/types/enums';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../../src/services/sheetService', () => ({
  getAllRows:    jest.fn(),
  appendRow:    jest.fn(),
  updateRow:    jest.fn(),
  findRowIndex: jest.fn(),
  ensureHeaders: jest.fn(),
}));

jest.mock('../../src/config/constants', () => ({
  getConfig: jest.fn(() => ({
    SHEET_NAMES: { SYNC_QUEUE: 'Sync_Queue' },
  })),
  COLUMNS: {
    SYNC_QUEUE: {
      QUEUE_ID:          0,
      EVENT_ID:          1,
      CLUB_NAME:         2,
      TAG:               3,
      BATCH_FOLDER_ID:   4,
      BATCH_FOLDER_NAME: 5,
      ENQUEUED_AT:       6,
      STATUS:            7,
      ATTEMPTS:          8,
      LAST_ATTEMPT_AT:   9,
      ERROR_MSG:         10,
      COMPLETED_AT:      11,
    },
  },
  SYNC_QUEUE_HEADERS: [
    'Queue_ID','Event_ID','Club_Name','Tag','Batch_Folder_ID','Batch_Folder_Name',
    'Enqueued_At','Status','Attempts','Last_Attempt_At','Error_Msg','Completed_At',
  ],
  MAX_SYNC_ATTEMPTS:           3,
  SYNC_STUCK_THRESHOLD_MINUTES: 10,
  SYNC_DRAIN_BATCH_SIZE:        5,
}));

// ─── GAS globals ──────────────────────────────────────────────────────────────

let uuidCounter = 0;
(global as unknown as Record<string, unknown>).Utilities = {
  getUuid: jest.fn(() => `test-uuid-${++uuidCounter}`),
};
(global as unknown as Record<string, unknown>).Logger = { log: jest.fn() };

// ─── Import mocked sheetService helpers ──────────────────────────────────────

import {
  getAllRows,
  appendRow,
  updateRow,
  findRowIndex,
} from '../../src/services/sheetService';

const mockGetAllRows    = getAllRows    as jest.Mock;
const mockAppendRow     = appendRow    as jest.Mock;
const mockUpdateRow     = updateRow    as jest.Mock;
const mockFindRowIndex  = findRowIndex as jest.Mock;

// ─── Fixture builder ──────────────────────────────────────────────────────────

/**
 * Builds a valid Sync_Queue sheet row (11 columns).
 * Column order matches COLUMNS.SYNC_QUEUE exactly.
 */
function makeQueueRow(
  queueId:         string,
  eventId          = 'evt-001',
  clubName         = 'New_Bee',
  batchFolderId    = 'batch-folder-id',
  batchFolderName  = '20260419-100000_alice',
  enqueuedAt       = '2026-04-19T10:00:00.000Z',
  status:          SyncQueueStatus = SyncQueueStatus.PENDING,
  attempts         = 0,
  lastAttemptAt    = '',
  errorMsg         = '',
  completedAt      = '',
  tag              = 'finish_line',
): unknown[] {
  return [
    queueId, eventId, clubName, tag, batchFolderId, batchFolderName,
    enqueuedAt, status, attempts, lastAttemptAt, errorMsg, completedAt,
  ];
}

// ─── enqueueBatchSync() ───────────────────────────────────────────────────────

describe('enqueueBatchSync()', () => {
  beforeEach(() => { jest.clearAllMocks(); uuidCounter = 0; });

  it('returns a record with status pending and attempts 0', () => {
    const record = enqueueBatchSync({
      eventId: 'evt-001', clubName: 'New_Bee', tag: 'finish_line',
      batchFolderId: 'folder-id', batchFolderName: 'batch-name',
    });
    expect(record.status).toBe(SyncQueueStatus.PENDING);
    expect(record.attempts).toBe(0);
    expect(record.errorMsg).toBe('');
    expect(record.completedAt).toBe('');
  });

  it('returns a record with the provided fields', () => {
    const record = enqueueBatchSync({
      eventId: 'evt-xyz', clubName: 'Speed_Demon', tag: 'finish_line',
      batchFolderId: 'f-123', batchFolderName: 'batch-xyz',
    });
    expect(record.eventId).toBe('evt-xyz');
    expect(record.clubName).toBe('Speed_Demon');
    expect(record.tag).toBe('finish_line');
    expect(record.batchFolderId).toBe('f-123');
    expect(record.batchFolderName).toBe('batch-xyz');
  });

  it('assigns a unique queueId via Utilities.getUuid', () => {
    const r1 = enqueueBatchSync({ eventId: 'e', clubName: 'c', tag: 't', batchFolderId: 'f1', batchFolderName: 'b1' });
    const r2 = enqueueBatchSync({ eventId: 'e', clubName: 'c', tag: 't', batchFolderId: 'f2', batchFolderName: 'b2' });
    expect(r1.queueId).not.toBe(r2.queueId);
  });

  it('appends one row to the Sync_Queue sheet', () => {
    enqueueBatchSync({ eventId: 'evt-001', clubName: 'New_Bee', tag: 't', batchFolderId: 'f', batchFolderName: 'b' });
    expect(mockAppendRow).toHaveBeenCalledTimes(1);
    expect(mockAppendRow).toHaveBeenCalledWith('Sync_Queue', expect.any(Array));
  });

  it('sets enqueuedAt to a non-empty ISO timestamp', () => {
    const record = enqueueBatchSync({ eventId: 'e', clubName: 'c', tag: 't', batchFolderId: 'f', batchFolderName: 'b' });
    expect(record.enqueuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ─── getAllQueueItems() ───────────────────────────────────────────────────────

describe('getAllQueueItems()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns empty array when sheet is empty', () => {
    mockGetAllRows.mockReturnValue([]);
    expect(getAllQueueItems()).toEqual([]);
  });

  it('returns parsed records for valid rows', () => {
    mockGetAllRows.mockReturnValue([
      makeQueueRow('q-001'),
      makeQueueRow('q-002', 'evt-002', 'CHI'),
    ]);
    const items = getAllQueueItems();
    expect(items).toHaveLength(2);
    expect(items[0].queueId).toBe('q-001');
    expect(items[1].clubName).toBe('CHI');
  });

  it('silently skips malformed rows (too short)', () => {
    mockGetAllRows.mockReturnValue([
      [],                          // empty row
      ['only-one-col'],            // too short
      makeQueueRow('q-valid'),     // valid
    ]);
    const items = getAllQueueItems();
    expect(items).toHaveLength(1);
    expect(items[0].queueId).toBe('q-valid');
  });

  it('skips rows with an invalid status value', () => {
    const row = makeQueueRow('q-bad-status');
    row[7] = 'not_a_real_status';  // STATUS column (col index 7 after TAG insert)
    mockGetAllRows.mockReturnValue([row, makeQueueRow('q-good')]);
    const items = getAllQueueItems();
    expect(items).toHaveLength(1);
    expect(items[0].queueId).toBe('q-good');
  });
});

// ─── loadPendingItems() ───────────────────────────────────────────────────────

describe('loadPendingItems()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns empty array when sheet is empty', () => {
    mockGetAllRows.mockReturnValue([]);
    expect(loadPendingItems()).toEqual([]);
  });

  it('returns only PENDING items', () => {
    mockGetAllRows.mockReturnValue([
      makeQueueRow('q-pending', 'evt', 'club', 'f', 'b', '2026-04-19T10:00:00.000Z', SyncQueueStatus.PENDING),
      makeQueueRow('q-done',    'evt', 'club', 'f', 'b', '2026-04-19T10:00:00.000Z', SyncQueueStatus.DONE),
      makeQueueRow('q-failed',  'evt', 'club', 'f', 'b', '2026-04-19T10:00:00.000Z', SyncQueueStatus.FAILED),
    ]);
    const items = loadPendingItems();
    expect(items).toHaveLength(1);
    expect(items[0].queueId).toBe('q-pending');
  });

  it('does not return IN_PROGRESS items that are within the stuck threshold', () => {
    // lastAttemptAt is only 1 minute ago — not stuck (threshold is 10 min)
    const recentAttempt = new Date(Date.now() - 60_000).toISOString();
    mockGetAllRows.mockReturnValue([
      makeQueueRow('q-recent', 'evt', 'club', 'f', 'b', '2026-04-19T10:00:00.000Z',
        SyncQueueStatus.IN_PROGRESS, 1, recentAttempt),
    ]);
    expect(loadPendingItems()).toHaveLength(0);
    expect(mockUpdateRow).not.toHaveBeenCalled();
  });

  it('resets stuck IN_PROGRESS items (age > threshold) to PENDING and returns them', () => {
    // lastAttemptAt is 20 minutes ago — stuck
    const stuckAttempt = new Date(Date.now() - 20 * 60_000).toISOString();
    mockGetAllRows.mockReturnValue([
      makeQueueRow('q-stuck', 'evt', 'club', 'f', 'b', '2026-04-19T10:00:00.000Z',
        SyncQueueStatus.IN_PROGRESS, 1, stuckAttempt),
    ]);
    const items = loadPendingItems();
    expect(items).toHaveLength(1);
    expect(items[0].queueId).toBe('q-stuck');
    expect(items[0].status).toBe(SyncQueueStatus.PENDING);
    // Should have written the reset to the sheet
    expect(mockUpdateRow).toHaveBeenCalledTimes(1);
  });

  it('does not reset IN_PROGRESS items with no lastAttemptAt', () => {
    mockGetAllRows.mockReturnValue([
      makeQueueRow('q-no-attempt', 'evt', 'club', 'f', 'b', '2026-04-19T10:00:00.000Z',
        SyncQueueStatus.IN_PROGRESS, 1, ''), // lastAttemptAt empty
    ]);
    expect(loadPendingItems()).toHaveLength(0);
    expect(mockUpdateRow).not.toHaveBeenCalled();
  });

  it('caps result at SYNC_DRAIN_BATCH_SIZE (5)', () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      makeQueueRow(`q-${i}`, 'evt', 'club', `f-${i}`, `b-${i}`)
    );
    mockGetAllRows.mockReturnValue(rows);
    expect(loadPendingItems()).toHaveLength(5);
  });

  it('returns pending items in sheet order (FIFO)', () => {
    mockGetAllRows.mockReturnValue([
      makeQueueRow('q-first',  'evt', 'c', 'f1', 'b', '2026-04-19T09:00:00.000Z'),
      makeQueueRow('q-second', 'evt', 'c', 'f2', 'b', '2026-04-19T10:00:00.000Z'),
    ]);
    const items = loadPendingItems();
    expect(items[0].queueId).toBe('q-first');
    expect(items[1].queueId).toBe('q-second');
  });
});

// ─── markInProgress() ────────────────────────────────────────────────────────

describe('markInProgress()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns null when queueId is not found in the sheet', () => {
    mockFindRowIndex.mockReturnValue(-1);
    expect(markInProgress('ghost-id')).toBeNull();
    expect(mockUpdateRow).not.toHaveBeenCalled();
  });

  it('increments attempts by 1 and sets status to IN_PROGRESS', () => {
    mockFindRowIndex.mockReturnValue(2); // row 2 (1-based)
    mockGetAllRows.mockReturnValue([
      makeQueueRow('q-001', 'evt', 'c', 'f', 'b', '2026-04-19T10:00:00.000Z',
        SyncQueueStatus.PENDING, 0),
    ]);

    const result = markInProgress('q-001');
    expect(result).not.toBeNull();
    expect(result!.status).toBe(SyncQueueStatus.IN_PROGRESS);
    expect(result!.attempts).toBe(1);
    expect(result!.lastAttemptAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('writes the updated row to the sheet', () => {
    mockFindRowIndex.mockReturnValue(2);
    mockGetAllRows.mockReturnValue([
      makeQueueRow('q-001', 'evt', 'c', 'f', 'b', '2026-04-19T10:00:00.000Z',
        SyncQueueStatus.PENDING, 1),
    ]);

    markInProgress('q-001');
    expect(mockUpdateRow).toHaveBeenCalledWith('Sync_Queue', 2, expect.any(Array));
  });

  it('returns null when the row exists but cannot be parsed', () => {
    mockFindRowIndex.mockReturnValue(2);
    mockGetAllRows.mockReturnValue([
      [], // malformed row at data index 0 (rowIndex 2 → data index 0)
    ]);
    expect(markInProgress('q-bad')).toBeNull();
  });
});

// ─── markDone() ──────────────────────────────────────────────────────────────

describe('markDone()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does nothing when queueId is not found', () => {
    mockFindRowIndex.mockReturnValue(-1);
    markDone('ghost');
    expect(mockUpdateRow).not.toHaveBeenCalled();
  });

  it('sets status to DONE and clears errorMsg', () => {
    mockFindRowIndex.mockReturnValue(2);
    mockGetAllRows.mockReturnValue([
      makeQueueRow('q-001', 'evt', 'c', 'f', 'b', '2026-04-19T10:00:00.000Z',
        SyncQueueStatus.IN_PROGRESS, 1, '2026-04-19T10:05:00.000Z', 'old error'),
    ]);

    markDone('q-001');

    const writtenRow = mockUpdateRow.mock.calls[0][2] as unknown[];
    // col 7 = status (after TAG insert at col 3)
    expect(writtenRow[7]).toBe(SyncQueueStatus.DONE);
    // col 10 = errorMsg
    expect(writtenRow[10]).toBe('');
    // col 11 = completedAt — should be set
    expect(String(writtenRow[11])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ─── markAttemptFailed() ─────────────────────────────────────────────────────

describe('markAttemptFailed()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does nothing when queueId is not found', () => {
    mockFindRowIndex.mockReturnValue(-1);
    markAttemptFailed('ghost', 'some error');
    expect(mockUpdateRow).not.toHaveBeenCalled();
  });

  it('resets status to PENDING when attempts < MAX_SYNC_ATTEMPTS (3)', () => {
    mockFindRowIndex.mockReturnValue(2);
    mockGetAllRows.mockReturnValue([
      makeQueueRow('q-001', 'evt', 'c', 'f', 'b', '2026-04-19T10:00:00.000Z',
        SyncQueueStatus.IN_PROGRESS, 2), // 2 attempts, max is 3
    ]);

    markAttemptFailed('q-001', 'Transient error');
    const writtenRow = mockUpdateRow.mock.calls[0][2] as unknown[];
    expect(writtenRow[7]).toBe(SyncQueueStatus.PENDING);
    expect(writtenRow[10]).toBe('Transient error');
  });

  it('marks FAILED when attempts >= MAX_SYNC_ATTEMPTS (3)', () => {
    mockFindRowIndex.mockReturnValue(2);
    mockGetAllRows.mockReturnValue([
      makeQueueRow('q-001', 'evt', 'c', 'f', 'b', '2026-04-19T10:00:00.000Z',
        SyncQueueStatus.IN_PROGRESS, 3), // exactly at max
    ]);

    markAttemptFailed('q-001', 'Permanent failure');
    const writtenRow = mockUpdateRow.mock.calls[0][2] as unknown[];
    expect(writtenRow[7]).toBe(SyncQueueStatus.FAILED);
  });

  it('truncates errorMsg to 500 characters', () => {
    mockFindRowIndex.mockReturnValue(2);
    mockGetAllRows.mockReturnValue([
      makeQueueRow('q-001', 'evt', 'c', 'f', 'b', '2026-04-19T10:00:00.000Z',
        SyncQueueStatus.IN_PROGRESS, 1),
    ]);

    const longMsg = 'x'.repeat(600);
    markAttemptFailed('q-001', longMsg);

    const writtenRow = mockUpdateRow.mock.calls[0][2] as unknown[];
    expect(String(writtenRow[10]).length).toBe(500);
  });

  it('writes one row update to the sheet', () => {
    mockFindRowIndex.mockReturnValue(2);
    mockGetAllRows.mockReturnValue([
      makeQueueRow('q-001', 'evt', 'c', 'f', 'b', '2026-04-19T10:00:00.000Z',
        SyncQueueStatus.IN_PROGRESS, 1),
    ]);
    markAttemptFailed('q-001', 'err');
    expect(mockUpdateRow).toHaveBeenCalledTimes(1);
    expect(mockUpdateRow).toHaveBeenCalledWith('Sync_Queue', 2, expect.any(Array));
  });
});

// ─── getQueueStatus() ────────────────────────────────────────────────────────

describe('getQueueStatus()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns all zeros for an empty queue', () => {
    mockGetAllRows.mockReturnValue([]);
    const status = getQueueStatus();
    expect(status.pending).toBe(0);
    expect(status.inProgress).toBe(0);
    expect(status.done).toBe(0);
    expect(status.failed).toBe(0);
    expect(status.total).toBe(0);
    expect(status.oldestPendingAt).toBe('');
  });

  it('counts each status correctly', () => {
    mockGetAllRows.mockReturnValue([
      makeQueueRow('q1', 'e', 'c', 'f1', 'b', '2026-04-19T08:00:00.000Z', SyncQueueStatus.PENDING),
      makeQueueRow('q2', 'e', 'c', 'f2', 'b', '2026-04-19T09:00:00.000Z', SyncQueueStatus.PENDING),
      makeQueueRow('q3', 'e', 'c', 'f3', 'b', '2026-04-19T09:00:00.000Z', SyncQueueStatus.IN_PROGRESS),
      makeQueueRow('q4', 'e', 'c', 'f4', 'b', '2026-04-19T09:00:00.000Z', SyncQueueStatus.DONE),
      makeQueueRow('q5', 'e', 'c', 'f5', 'b', '2026-04-19T09:00:00.000Z', SyncQueueStatus.FAILED),
    ]);
    const status = getQueueStatus();
    expect(status.pending).toBe(2);
    expect(status.inProgress).toBe(1);
    expect(status.done).toBe(1);
    expect(status.failed).toBe(1);
    expect(status.total).toBe(5);
  });

  it('sets oldestPendingAt to the earliest enqueuedAt among pending items', () => {
    mockGetAllRows.mockReturnValue([
      makeQueueRow('q1', 'e', 'c', 'f1', 'b', '2026-04-19T10:00:00.000Z', SyncQueueStatus.PENDING),
      makeQueueRow('q2', 'e', 'c', 'f2', 'b', '2026-04-19T08:00:00.000Z', SyncQueueStatus.PENDING), // oldest
      makeQueueRow('q3', 'e', 'c', 'f3', 'b', '2026-04-19T09:00:00.000Z', SyncQueueStatus.PENDING),
    ]);
    const status = getQueueStatus();
    expect(status.oldestPendingAt).toBe('2026-04-19T08:00:00.000Z');
  });

  it('oldestPendingAt is empty string when there are no pending items', () => {
    mockGetAllRows.mockReturnValue([
      makeQueueRow('q1', 'e', 'c', 'f1', 'b', '2026-04-19T09:00:00.000Z', SyncQueueStatus.DONE),
    ]);
    expect(getQueueStatus().oldestPendingAt).toBe('');
  });
});

// ─── loadPendingItemsWithContext() ────────────────────────────────────────────

describe('loadPendingItemsWithContext()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns empty items, empty rowMap, and allRows when sheet is empty', () => {
    mockGetAllRows.mockReturnValue([]);
    const ctx = loadPendingItemsWithContext();
    expect(ctx.items).toHaveLength(0);
    expect(ctx.rowMap.size).toBe(0);
    expect(ctx.allRows).toEqual([]);
    expect(ctx.sheetName).toBe('Sync_Queue');
  });

  it('returns the same pending items as loadPendingItems()', () => {
    const rows = [
      makeQueueRow('q-p1', 'evt', 'c', 'f1', 'b', '2026-04-19T08:00:00.000Z', SyncQueueStatus.PENDING),
      makeQueueRow('q-p2', 'evt', 'c', 'f2', 'b', '2026-04-19T09:00:00.000Z', SyncQueueStatus.PENDING),
      makeQueueRow('q-d1', 'evt', 'c', 'f3', 'b', '2026-04-19T09:00:00.000Z', SyncQueueStatus.DONE),
    ];
    mockGetAllRows.mockReturnValue(rows);
    const ctx = loadPendingItemsWithContext();
    expect(ctx.items).toHaveLength(2);
    expect(ctx.items[0].queueId).toBe('q-p1');
    expect(ctx.items[1].queueId).toBe('q-p2');
  });

  it('builds a rowMap containing all parseable records (pending + done + failed)', () => {
    const rows = [
      makeQueueRow('q-p', 'evt', 'c', 'f1', 'b', '2026-04-19T08:00:00.000Z', SyncQueueStatus.PENDING),
      makeQueueRow('q-d', 'evt', 'c', 'f2', 'b', '2026-04-19T08:00:00.000Z', SyncQueueStatus.DONE),
      makeQueueRow('q-f', 'evt', 'c', 'f3', 'b', '2026-04-19T08:00:00.000Z', SyncQueueStatus.FAILED),
    ];
    mockGetAllRows.mockReturnValue(rows);
    const { rowMap } = loadPendingItemsWithContext();
    expect(rowMap.size).toBe(3);
    expect(rowMap.get('q-p')?.rowIndex).toBe(2); // row 2 = data index 0
    expect(rowMap.get('q-d')?.rowIndex).toBe(3);
    expect(rowMap.get('q-f')?.rowIndex).toBe(4);
  });

  it('resets stuck IN_PROGRESS items in the sheet and includes them as pending', () => {
    const stuckAttempt = new Date(Date.now() - 20 * 60_000).toISOString();
    mockGetAllRows.mockReturnValue([
      makeQueueRow('q-stuck', 'evt', 'c', 'f', 'b', '2026-04-19T08:00:00.000Z',
        SyncQueueStatus.IN_PROGRESS, 1, stuckAttempt),
    ]);
    const ctx = loadPendingItemsWithContext();
    expect(ctx.items).toHaveLength(1);
    expect(ctx.items[0].status).toBe(SyncQueueStatus.PENDING);
    expect(mockUpdateRow).toHaveBeenCalledTimes(1);
  });

  it('returns allRows as the raw rows from getAllRows', () => {
    const rows = [makeQueueRow('q-1')];
    mockGetAllRows.mockReturnValue(rows);
    const ctx = loadPendingItemsWithContext();
    expect(ctx.allRows).toBe(rows); // same reference
  });

  it('calls getAllRows exactly once', () => {
    mockGetAllRows.mockReturnValue([makeQueueRow('q-1')]);
    loadPendingItemsWithContext();
    expect(mockGetAllRows).toHaveBeenCalledTimes(1);
  });
});

// ─── buildQueueRowMap() ───────────────────────────────────────────────────────

describe('buildQueueRowMap()', () => {
  it('returns an empty map for empty input', () => {
    expect(buildQueueRowMap([])).toEqual(new Map());
  });

  it('maps queueId → correct 1-based rowIndex', () => {
    const rows = [
      makeQueueRow('q-001'), // data index 0 → sheet row 2
      makeQueueRow('q-002'), // data index 1 → sheet row 3
      makeQueueRow('q-003'), // data index 2 → sheet row 4
    ];
    const map = buildQueueRowMap(rows);
    expect(map.get('q-001')?.rowIndex).toBe(2);
    expect(map.get('q-002')?.rowIndex).toBe(3);
    expect(map.get('q-003')?.rowIndex).toBe(4);
  });

  it('silently omits malformed rows', () => {
    const rows = [[], makeQueueRow('q-good'), ['bad']];
    const map = buildQueueRowMap(rows);
    expect(map.size).toBe(1);
    expect(map.has('q-good')).toBe(true);
  });

  it('stores the parsed record in the map entry', () => {
    const rows = [makeQueueRow('q-001', 'evt-42', 'Speed_Demon')];
    const entry = buildQueueRowMap(rows).get('q-001');
    expect(entry?.record.eventId).toBe('evt-42');
    expect(entry?.record.clubName).toBe('Speed_Demon');
  });
});

// ─── computeInProgressUpdate() ───────────────────────────────────────────────

describe('computeInProgressUpdate()', () => {
  const baseRecord = {
    queueId: 'q-001', eventId: 'evt', clubName: 'c', tag: 'finish_line',
    batchFolderId: 'f', batchFolderName: 'b',
    enqueuedAt: '2026-04-19T10:00:00.000Z',
    status: SyncQueueStatus.PENDING,
    attempts: 0, lastAttemptAt: '', errorMsg: '', completedAt: '',
  };

  it('sets status to IN_PROGRESS', () => {
    expect(computeInProgressUpdate(baseRecord).status).toBe(SyncQueueStatus.IN_PROGRESS);
  });

  it('increments attempts by 1', () => {
    expect(computeInProgressUpdate(baseRecord).attempts).toBe(1);
    expect(computeInProgressUpdate({ ...baseRecord, attempts: 2 }).attempts).toBe(3);
  });

  it('sets lastAttemptAt to an ISO timestamp close to the provided now', () => {
    const now = new Date('2026-04-23T12:00:00.000Z');
    expect(computeInProgressUpdate(baseRecord, now).lastAttemptAt).toBe('2026-04-23T12:00:00.000Z');
  });

  it('does not mutate the input record', () => {
    const copy = { ...baseRecord };
    computeInProgressUpdate(baseRecord);
    expect(baseRecord).toEqual(copy);
  });
});

// ─── computeDoneUpdate() ─────────────────────────────────────────────────────

describe('computeDoneUpdate()', () => {
  const baseRecord = {
    queueId: 'q-001', eventId: 'evt', clubName: 'c', tag: 'finish_line',
    batchFolderId: 'f', batchFolderName: 'b',
    enqueuedAt: '2026-04-19T10:00:00.000Z',
    status: SyncQueueStatus.IN_PROGRESS,
    attempts: 1, lastAttemptAt: '2026-04-19T10:05:00.000Z',
    errorMsg: 'old error', completedAt: '',
  };

  it('sets status to DONE', () => {
    expect(computeDoneUpdate(baseRecord).status).toBe(SyncQueueStatus.DONE);
  });

  it('clears errorMsg', () => {
    expect(computeDoneUpdate(baseRecord).errorMsg).toBe('');
  });

  it('sets completedAt to the provided now', () => {
    const now = new Date('2026-04-23T15:00:00.000Z');
    expect(computeDoneUpdate(baseRecord, now).completedAt).toBe('2026-04-23T15:00:00.000Z');
  });

  it('does not mutate the input record', () => {
    const copy = { ...baseRecord };
    computeDoneUpdate(baseRecord);
    expect(baseRecord).toEqual(copy);
  });
});

// ─── computeFailedUpdate() ───────────────────────────────────────────────────

describe('computeFailedUpdate()', () => {
  const baseRecord = {
    queueId: 'q-001', eventId: 'evt', clubName: 'c', tag: 'finish_line',
    batchFolderId: 'f', batchFolderName: 'b',
    enqueuedAt: '2026-04-19T10:00:00.000Z',
    status: SyncQueueStatus.IN_PROGRESS,
    attempts: 1, lastAttemptAt: '2026-04-19T10:05:00.000Z',
    errorMsg: '', completedAt: '',
  };

  it('resets to PENDING when attempts < MAX_SYNC_ATTEMPTS (3)', () => {
    expect(computeFailedUpdate({ ...baseRecord, attempts: 1 }, 'err').status)
      .toBe(SyncQueueStatus.PENDING);
    expect(computeFailedUpdate({ ...baseRecord, attempts: 2 }, 'err').status)
      .toBe(SyncQueueStatus.PENDING);
  });

  it('marks FAILED when attempts >= MAX_SYNC_ATTEMPTS (3)', () => {
    expect(computeFailedUpdate({ ...baseRecord, attempts: 3 }, 'err').status)
      .toBe(SyncQueueStatus.FAILED);
    expect(computeFailedUpdate({ ...baseRecord, attempts: 4 }, 'err').status)
      .toBe(SyncQueueStatus.FAILED);
  });

  it('stores the error message', () => {
    expect(computeFailedUpdate(baseRecord, 'Photos API down').errorMsg).toBe('Photos API down');
  });

  it('truncates errorMsg to 500 characters', () => {
    const long = 'x'.repeat(600);
    expect(computeFailedUpdate(baseRecord, long).errorMsg.length).toBe(500);
  });

  it('does not mutate the input record', () => {
    const copy = { ...baseRecord };
    computeFailedUpdate(baseRecord, 'err');
    expect(baseRecord).toEqual(copy);
  });
});
