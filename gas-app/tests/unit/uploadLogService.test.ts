import {
  appendUploadLog,
  getLogsForEvent,
  getAllUploadLogs,
  CreateUploadLogInput,
} from '../../src/services/uploadLogService';
import {
  resetMockSheets,
  mockSheets,
  createMockSheet,
} from '../mocks/gasGlobals';
import { ResultStatus, UploadSource } from '../../src/types/enums';
import { UploadLogRecord } from '../../src/types/models';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<CreateUploadLogInput> = {}): CreateUploadLogInput {
  return {
    eventId:           'evt-uuid-001',
    clubName:          'New_Bee',
    uploadedBy:        'user1@example.com',
    batchFolderName:   '20251103-093500_user1',
    batchFolderId:     'batch-folder-id-001',
    fileCount:         5,
    totalSizeMb:       12.5,
    skippedDuplicates: 1,
    skippedNonPhoto:   0,
    source:            UploadSource.WEB_APP,
    ...overrides,
  };
}

/** Minimal valid Upload_Log row array */
function makeLogRow(overrides: Partial<UploadLogRecord> = {}): unknown[] {
  const record: UploadLogRecord = {
    logId:             'log-uuid-001',
    eventId:           'evt-uuid-001',
    clubName:          'New_Bee',
    uploadedBy:        'user1@example.com',
    batchFolderName:   '20251103-093500_user1',
    batchFolderId:     'batch-folder-id-001',
    fileCount:         5,
    totalSizeMb:       12.5,
    skippedDuplicates: 1,
    skippedNonPhoto:   0,
    uploadTimestamp:   '2025-11-03T09:35:00.000Z',
    source:            UploadSource.WEB_APP,
    ...overrides,
  };
  return [
    record.logId, record.eventId, record.clubName, record.uploadedBy,
    record.batchFolderName, record.batchFolderId,
    record.fileCount, record.totalSizeMb, record.skippedDuplicates,
    record.skippedNonPhoto, record.uploadTimestamp, record.source,
  ];
}

// ─── appendUploadLog ──────────────────────────────────────────────────────────

describe('appendUploadLog()', () => {
  beforeEach(() => {
    resetMockSheets();
  });

  it('returns SUCCESS and a valid UploadLogRecord', () => {
    const result = appendUploadLog(makeInput());

    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data).toBeDefined();
    expect(result.data!.eventId).toBe('evt-uuid-001');
    expect(result.data!.clubName).toBe('New_Bee');
    expect(result.data!.fileCount).toBe(5);
    expect(result.data!.source).toBe(UploadSource.WEB_APP);
  });

  it('generates a non-empty logId', () => {
    const result = appendUploadLog(makeInput());
    expect(result.data!.logId).toBeTruthy();
    expect(result.data!.logId.length).toBeGreaterThan(0);
  });

  it('generates an uploadTimestamp in ISO 8601 format', () => {
    const result = appendUploadLog(makeInput());
    const ts = result.data!.uploadTimestamp;
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('normalises uploadedBy to lowercase', () => {
    const result = appendUploadLog(makeInput({ uploadedBy: 'User@Example.COM' }));
    expect(result.data!.uploadedBy).toBe('user@example.com');
  });

  it('rounds totalSizeMb to 2 decimal places', () => {
    const result = appendUploadLog(makeInput({ totalSizeMb: 12.34567 }));
    expect(result.data!.totalSizeMb).toBe(12.35);
  });

  it('appends exactly one row to the Upload_Log sheet', () => {
    appendUploadLog(makeInput());
    expect(mockSheets.Upload_Log.appendRow).toHaveBeenCalledTimes(1);
  });

  it('the appended row has 12 columns (matching sheet schema)', () => {
    appendUploadLog(makeInput());
    const row = mockSheets.Upload_Log.appendRow.mock.calls[0][0] as unknown[];
    expect(row).toHaveLength(12);
  });

  it('returns ERROR when the sheet cannot be opened', () => {
    // Make Upload_Log sheet return null to trigger getSheet() throw
    const mockSpreadsheet = (global as Record<string, unknown>)['SpreadsheetApp'] as {
      openById: jest.Mock;
    };
    const originalOpen = mockSpreadsheet.openById.getMockImplementation();
    mockSpreadsheet.openById.mockReturnValueOnce({
      getSheetByName: jest.fn().mockReturnValue(null),
    });

    const result = appendUploadLog(makeInput());
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('Failed to write upload log');

    if (originalOpen) mockSpreadsheet.openById.mockImplementation(originalOpen);
  });
});

// ─── getLogsForEvent ──────────────────────────────────────────────────────────

describe('getLogsForEvent()', () => {
  beforeEach(() => {
    resetMockSheets();
  });

  it('returns empty array when Upload_Log has no rows', () => {
    const result = getLogsForEvent('evt-uuid-001');
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data).toEqual([]);
  });

  it('returns only records matching the given eventId', () => {
    const row1 = makeLogRow({ eventId: 'evt-uuid-001', logId: 'log-001' });
    const row2 = makeLogRow({ eventId: 'evt-uuid-002', logId: 'log-002' });
    const row3 = makeLogRow({ eventId: 'evt-uuid-001', logId: 'log-003' });
    mockSheets.Upload_Log = createMockSheet([row1, row2, row3]);
    // Reassign to ensure the mock spreadsheet picks it up
    const mockSpreadsheet = (global as Record<string, unknown>)['SpreadsheetApp'] as {
      openById: jest.Mock;
    };
    mockSpreadsheet.openById.mockReturnValueOnce({
      getSheetByName: jest.fn().mockImplementation((name: string) =>
        name === 'Upload_Log' ? mockSheets.Upload_Log : null
      ),
    });

    const result = getLogsForEvent('evt-uuid-001');

    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data).toHaveLength(2);
    expect(result.data!.every((r) => r.eventId === 'evt-uuid-001')).toBe(true);
  });

  it('returns ERROR when the sheet cannot be accessed', () => {
    const mockSpreadsheet = (global as Record<string, unknown>)['SpreadsheetApp'] as {
      openById: jest.Mock;
    };
    mockSpreadsheet.openById.mockReturnValueOnce({
      getSheetByName: jest.fn().mockReturnValue(null),
    });

    const result = getLogsForEvent('evt-uuid-001');
    expect(result.status).toBe(ResultStatus.ERROR);
  });
});

// ─── getAllUploadLogs ─────────────────────────────────────────────────────────

describe('getAllUploadLogs()', () => {
  beforeEach(() => {
    resetMockSheets();
  });

  it('returns an empty array when the log is empty', () => {
    const result = getAllUploadLogs();
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data).toEqual([]);
  });

  it('returns all records sorted newest-first by uploadTimestamp', () => {
    const older = makeLogRow({ logId: 'old', uploadTimestamp: '2025-11-01T09:00:00.000Z' });
    const newer = makeLogRow({ logId: 'new', uploadTimestamp: '2025-11-03T09:00:00.000Z' });
    mockSheets.Upload_Log = createMockSheet([older, newer]);

    const mockSpreadsheet = (global as Record<string, unknown>)['SpreadsheetApp'] as {
      openById: jest.Mock;
    };
    mockSpreadsheet.openById.mockReturnValueOnce({
      getSheetByName: jest.fn().mockImplementation((name: string) =>
        name === 'Upload_Log' ? mockSheets.Upload_Log : null
      ),
    });

    const result = getAllUploadLogs();

    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data).toHaveLength(2);
    expect(result.data![0].uploadTimestamp).toBe('2025-11-03T09:00:00.000Z');
    expect(result.data![1].uploadTimestamp).toBe('2025-11-01T09:00:00.000Z');
  });
});
