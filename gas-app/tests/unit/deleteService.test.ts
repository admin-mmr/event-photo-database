/**
 * deleteService.test.ts — unit tests for Phase 7 soft-delete system.
 *
 * Covers: softDeleteFile, restoreFile, listDeleted, purgeDeletedFiles.
 *
 * All Google APIs (DriveApp, SpreadsheetApp) are mocked via gasGlobals.
 * sheetService reads/writes go through the in-memory mockSheets.
 */

import {
  softDeleteFile,
  restoreFile,
  listDeleted,
  purgeDeletedFiles,
  SoftDeleteInput,
} from '../../src/services/deleteService';
import {
  resetMockSheets,
  mockSheets,
  createMockSheet,
  mockDriveFile,
  TEST_ADMIN_EMAIL,
} from '../mocks/gasGlobals';
import { ResultStatus, DeletedFileStatus } from '../../src/types/enums';
import { DeletedFileRecord } from '../../src/types/models';
import { fromDeletedFileRecord } from '../../src/utils/sheetMapper';

// ─── Sheet factory ────────────────────────────────────────────────────────────

/**
 * The 14 header strings for Deleted_Files — must match DELETED_FILES_HEADERS
 * in constants.ts exactly.
 */
const DF_HEADERS = [
  'DELETE_ID', 'DRIVE_FILE_ID', 'FILE_NAME', 'EVENT_ID', 'CLUB_NAME',
  'BATCH_FOLDER_NAME', 'UPLOADED_BY', 'DELETED_AT', 'DELETED_BY',
  'DELETED_REASON', 'RESTORED_AT', 'RESTORED_BY', 'PURGED_AT', 'STATUS',
];

/**
 * Creates a mock Deleted_Files sheet that correctly dispatches:
 *   getRange(1, 1, 1, n)      → header row  (for ensureHeaders)
 *   getRange(2, 1, n, m)      → data rows   (for getAllRows)
 *   getRange(rowN, 1, 1, m)   → single row  (for updateRow)
 */
interface DeletedFilesSheetMock extends ReturnType<typeof createMockSheet> {
  /** The single setValues spy shared across all range objects from this sheet. */
  _setValuesMock: jest.Mock;
}

function createDeletedFilesSheet(dataRows: unknown[][] = []): DeletedFilesSheetMock {
  const mockSetValues = jest.fn();
  const sheet = {
    getLastRow:    jest.fn().mockReturnValue(dataRows.length + 1),
    getLastColumn: jest.fn().mockReturnValue(DF_HEADERS.length),
    getRange: jest.fn().mockImplementation(
      (rowStart: number, _colStart: number, numRows?: number, numCols?: number) => {
        if (rowStart === 1 && numRows === 1) {
          // ensureHeaders reads the header row
          return {
            getValues:  jest.fn().mockReturnValue([DF_HEADERS.slice(0, numCols ?? DF_HEADERS.length)]),
            setValues:  mockSetValues,
          };
        }
        // getAllRows reads from row 2; updateRow reads a single data row
        const dataIndex = rowStart - 2; // convert 1-based sheet row to 0-based data index
        const slice = numRows
          ? dataRows.slice(dataIndex, dataIndex + numRows)
          : dataRows.slice(dataIndex);
        return {
          getValues:  jest.fn().mockReturnValue(slice),
          setValues:  mockSetValues,
        };
      }
    ),
    appendRow: jest.fn(),
    _setValuesMock: mockSetValues,
  };
  return sheet as unknown as DeletedFilesSheetMock;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<SoftDeleteInput> = {}): SoftDeleteInput {
  return {
    driveFileId:     'drive-file-id-001',
    fileName:        'IMG_0042.jpg',
    eventId:         'evt-uuid-001',
    clubName:        'New_Bee',
    batchFolderName: '20251103-093500_volunteer',
    uploadedBy:      'volunteer@example.com',
    actorEmail:      TEST_ADMIN_EMAIL,
    ...overrides,
  };
}

/** Builds a raw Sheets row for a DeletedFileRecord with the given status and deletedAt. */
function makeDeletedRow(overrides: Partial<DeletedFileRecord> = {}): unknown[] {
  const record: DeletedFileRecord = {
    deleteId:        'del-uuid-001',
    driveFileId:     'drive-file-id-001',
    fileName:        'IMG_0042.jpg',
    eventId:         'evt-uuid-001',
    clubName:        'New_Bee',
    batchFolderName: '20251103-093500_volunteer',
    uploadedBy:      'volunteer@example.com',
    deletedAt:       '2026-01-01T10:00:00.000Z',
    deletedBy:       TEST_ADMIN_EMAIL,
    deletedReason:   '',
    restoredAt:      '',
    restoredBy:      '',
    purgedAt:        '',
    status:          DeletedFileStatus.DELETED,
    ...overrides,
  };
  return fromDeletedFileRecord(record);
}

function wireMockSpreadsheetApp() {
  const sApp = (global as Record<string, unknown>)['SpreadsheetApp'] as {
    openById: jest.Mock;
  };
  sApp.openById.mockReturnValue({
    getSheetByName: jest.fn().mockImplementation((name: string) => mockSheets[name] ?? null),
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  resetMockSheets();
  // Replace the generic empty Deleted_Files sheet with our header-aware factory
  mockSheets['Deleted_Files'] = createDeletedFilesSheet() as ReturnType<typeof createMockSheet>;
  wireMockSpreadsheetApp();
  mockDriveFile.setTrashed.mockReset();
});

// ─── softDeleteFile ───────────────────────────────────────────────────────────

describe('softDeleteFile()', () => {
  it('returns SUCCESS and a deleteId', () => {
    const result = softDeleteFile(makeInput());
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.deleteId).toBeTruthy();
  });

  it('calls DriveApp.getFileById and setTrashed(true)', () => {
    const mockDriveApp = (global as Record<string, unknown>)['DriveApp'] as {
      getFileById: jest.Mock;
    };
    softDeleteFile(makeInput());
    expect(mockDriveApp.getFileById).toHaveBeenCalledWith('drive-file-id-001');
    expect(mockDriveFile.setTrashed).toHaveBeenCalledWith(true);
  });

  it('appends a row to Deleted_Files sheet', () => {
    const sheet = mockSheets['Deleted_Files'];
    softDeleteFile(makeInput());
    expect(sheet.appendRow).toHaveBeenCalledTimes(1);
    const row = sheet.appendRow.mock.calls[0][0] as unknown[];
    // STATUS column (index 13) should be 'deleted'
    expect(row[13]).toBe(DeletedFileStatus.DELETED);
    // DRIVE_FILE_ID column (index 1) should match
    expect(row[1]).toBe('drive-file-id-001');
  });

  it('stores the optional reason', () => {
    const sheet = mockSheets['Deleted_Files'];
    softDeleteFile(makeInput({ reason: 'inappropriate content' }));
    const row = sheet.appendRow.mock.calls[0][0] as unknown[];
    expect(row[9]).toBe('inappropriate content'); // DELETED_REASON column
  });

  it('returns ERROR if DriveApp throws', () => {
    const mockDriveApp = (global as Record<string, unknown>)['DriveApp'] as {
      getFileById: jest.Mock;
    };
    mockDriveApp.getFileById.mockImplementationOnce(() => {
      throw new Error('File not found');
    });
    const result = softDeleteFile(makeInput());
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('File not found');
  });
});

// ─── restoreFile ──────────────────────────────────────────────────────────────

describe('restoreFile()', () => {
  beforeEach(() => {
    mockSheets['Deleted_Files'] = createDeletedFilesSheet([makeDeletedRow()]) as ReturnType<typeof createMockSheet>;
    wireMockSpreadsheetApp();
  });

  it('returns SUCCESS and untrashes the Drive file', () => {
    const result = restoreFile({ deleteId: 'del-uuid-001', actorEmail: TEST_ADMIN_EMAIL });
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(mockDriveFile.setTrashed).toHaveBeenCalledWith(false);
  });

  it('updates the row status to restored', () => {
    restoreFile({ deleteId: 'del-uuid-001', actorEmail: TEST_ADMIN_EMAIL });
    const sheet = mockSheets['Deleted_Files'] as unknown as DeletedFilesSheetMock;
    // updateRow calls getRange(rowIndex, 1, 1, row.length).setValues([row])
    expect(sheet._setValuesMock).toHaveBeenCalledTimes(1);
    // The first argument to setValues is [[...14 cols]], so [0][0][13] = STATUS
    const writtenMatrix = sheet._setValuesMock.mock.calls[0][0] as unknown[][];
    expect(writtenMatrix[0][13]).toBe(DeletedFileStatus.RESTORED);
  });

  it('returns ERROR for unknown deleteId', () => {
    const result = restoreFile({ deleteId: 'nonexistent-id', actorEmail: TEST_ADMIN_EMAIL });
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('not found');
  });

  it('returns ERROR if file is already restored', () => {
    mockSheets['Deleted_Files'] = createDeletedFilesSheet([
      makeDeletedRow({ status: DeletedFileStatus.RESTORED }),
    ]) as ReturnType<typeof createMockSheet>;
    wireMockSpreadsheetApp();
    const result = restoreFile({ deleteId: 'del-uuid-001', actorEmail: TEST_ADMIN_EMAIL });
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('restored');
  });

  it('returns ERROR if file is already purged', () => {
    mockSheets['Deleted_Files'] = createDeletedFilesSheet([
      makeDeletedRow({ status: DeletedFileStatus.PURGED, purgedAt: '2026-02-01T00:00:00.000Z' }),
    ]) as ReturnType<typeof createMockSheet>;
    wireMockSpreadsheetApp();
    const result = restoreFile({ deleteId: 'del-uuid-001', actorEmail: TEST_ADMIN_EMAIL });
    expect(result.status).toBe(ResultStatus.ERROR);
  });
});

// ─── listDeleted ──────────────────────────────────────────────────────────────

describe('listDeleted()', () => {
  beforeEach(() => {
    mockSheets['Deleted_Files'] = createDeletedFilesSheet([
      makeDeletedRow({ deleteId: 'del-001', clubName: 'New_Bee',  eventId: 'evt-uuid-001', status: DeletedFileStatus.DELETED  }),
      makeDeletedRow({ deleteId: 'del-002', clubName: 'Nankai',   eventId: 'evt-uuid-001', status: DeletedFileStatus.DELETED  }),
      makeDeletedRow({ deleteId: 'del-003', clubName: 'New_Bee',  eventId: 'evt-uuid-002', status: DeletedFileStatus.RESTORED }),
    ]) as ReturnType<typeof createMockSheet>;
    wireMockSpreadsheetApp();
  });

  it('returns all records when no filter is applied', () => {
    const result = listDeleted();
    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(3);
  });

  it('filters by clubName', () => {
    const result = listDeleted({ clubName: 'New_Bee' });
    expect(result.total).toBe(2);
    expect(result.items.every(r => r.clubName === 'New_Bee')).toBe(true);
  });

  it('filters by eventId', () => {
    const result = listDeleted({ eventId: 'evt-uuid-001' });
    expect(result.total).toBe(2);
  });

  it('filters by status', () => {
    const result = listDeleted({ status: DeletedFileStatus.RESTORED });
    expect(result.total).toBe(1);
    expect(result.items[0].deleteId).toBe('del-003');
  });

  it('paginates correctly', () => {
    const page1 = listDeleted({ page: 1, pageSize: 2 });
    const page2 = listDeleted({ page: 2, pageSize: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(1);
    expect(page1.items[0].deleteId).not.toBe(page2.items[0].deleteId);
  });

  it('returns empty result when sheet is empty', () => {
    mockSheets['Deleted_Files'] = createDeletedFilesSheet([]) as ReturnType<typeof createMockSheet>;
    wireMockSpreadsheetApp();
    const result = listDeleted();
    expect(result.total).toBe(0);
    expect(result.items).toHaveLength(0);
  });
});

// ─── purgeDeletedFiles ────────────────────────────────────────────────────────

describe('purgeDeletedFiles()', () => {
  /** Builds a row whose deletedAt is 31 days ago (beyond the 30-day window). */
  function expiredRow(deleteId = 'del-exp-001'): unknown[] {
    const d = new Date();
    d.setDate(d.getDate() - 31);
    return makeDeletedRow({ deleteId, deletedAt: d.toISOString() });
  }

  /** Builds a row whose deletedAt is 10 days ago (still within the window). */
  function freshRow(deleteId = 'del-fresh-001'): unknown[] {
    const d = new Date();
    d.setDate(d.getDate() - 10);
    return makeDeletedRow({ deleteId, deletedAt: d.toISOString() });
  }

  it('returns { purged: 0, errors: 0 } when no files have expired', () => {
    mockSheets['Deleted_Files'] = createDeletedFilesSheet([freshRow()]) as ReturnType<typeof createMockSheet>;
    wireMockSpreadsheetApp();
    const result = purgeDeletedFiles();
    expect(result.purged).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('purges an expired file and marks it as purged', () => {
    mockSheets['Deleted_Files'] = createDeletedFilesSheet([expiredRow()]) as ReturnType<typeof createMockSheet>;
    wireMockSpreadsheetApp();
    const result = purgeDeletedFiles();
    expect(result.purged).toBe(1);
    expect(result.errors).toBe(0);
    expect(mockDriveFile.setTrashed).toHaveBeenCalledWith(true);
  });

  it('skips files that are already restored or purged', () => {
    const d = new Date();
    d.setDate(d.getDate() - 40);
    const alreadyPurged   = makeDeletedRow({ deleteId: 'p1', status: DeletedFileStatus.PURGED,   deletedAt: d.toISOString(), purgedAt: d.toISOString() });
    const alreadyRestored = makeDeletedRow({ deleteId: 'p2', status: DeletedFileStatus.RESTORED, deletedAt: d.toISOString() });
    const shouldPurge     = expiredRow('p3');
    mockSheets['Deleted_Files'] = createDeletedFilesSheet([alreadyPurged, alreadyRestored, shouldPurge]) as ReturnType<typeof createMockSheet>;
    wireMockSpreadsheetApp();
    const result = purgeDeletedFiles();
    expect(result.purged).toBe(1);
  });

  it('counts errors for files where DriveApp throws', () => {
    const mockDriveApp = (global as Record<string, unknown>)['DriveApp'] as {
      getFileById: jest.Mock;
    };
    mockDriveApp.getFileById.mockImplementationOnce(() => {
      throw new Error('Drive quota exceeded');
    });
    mockSheets['Deleted_Files'] = createDeletedFilesSheet([expiredRow()]) as ReturnType<typeof createMockSheet>;
    wireMockSpreadsheetApp();
    const result = purgeDeletedFiles();
    expect(result.errors).toBe(1);
    expect(result.purged).toBe(0);
  });

  it('continues processing remaining files after one error', () => {
    const mockDriveApp = (global as Record<string, unknown>)['DriveApp'] as {
      getFileById: jest.Mock;
    };
    // First call throws, second succeeds.
    mockDriveApp.getFileById
      .mockImplementationOnce(() => { throw new Error('quota'); })
      .mockReturnValue(mockDriveFile);
    mockSheets['Deleted_Files'] = createDeletedFilesSheet([expiredRow('fail'), expiredRow('ok')]) as ReturnType<typeof createMockSheet>;
    wireMockSpreadsheetApp();
    const result = purgeDeletedFiles();
    expect(result.purged).toBe(1);
    expect(result.errors).toBe(1);
  });
});
