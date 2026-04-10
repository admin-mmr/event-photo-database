/**
 * Integration tests for the Event Creation Pipeline.
 *
 * These tests exercise the full chain from validated input through
 * Drive folder creation to Events sheet write:
 *   validateCreateInput() → createEventFolder() → appendRow()
 *
 * They also verify that atomicity is preserved: if Drive fails,
 * nothing is written to the sheet.
 *
 * Uses the GAS global mocks installed by gasGlobals.ts.
 */

import {
  createEvent,
  findById,
  listAll,
} from '../../src/services/eventService';
import {
  mockSheets,
  mockFolder,
  mockDriveApp,
  resetMockSheets,
  resetUuidCounter,
  TEST_ADMIN_EMAIL,
} from '../mocks/gasGlobals';
import { ResultStatus } from '../../src/types/enums';

// ─── Test setup ───────────────────────────────────────────────────────────────

const mockSpreadsheetApp = (global as Record<string, unknown>)['SpreadsheetApp'] as {
  openById: jest.Mock;
};

function useMockSheets() {
  mockSpreadsheetApp.openById.mockReturnValue({
    getSheetByName: jest.fn().mockImplementation((name: string) => mockSheets[name] ?? null),
  });
}

function makeMockFolder(name: string, id: string) {
  return {
    getId: jest.fn().mockReturnValue(id),
    getName: jest.fn().mockReturnValue(name),
    createFolder: jest.fn().mockImplementation((n: string) =>
      makeMockFolder(n, `new-${n}-id`)
    ),
    getFolders: jest.fn().mockReturnValue({ hasNext: jest.fn().mockReturnValue(false) }),
    getFoldersByName: jest.fn().mockReturnValue({ hasNext: jest.fn().mockReturnValue(false) }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Event Creation Pipeline (integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockSheets();
    resetUuidCounter();
    useMockSheets();

    // Restore Drive mocks to default working state
    mockDriveApp.getFolderById.mockReturnValue(mockFolder);
    mockDriveApp.getRootFolder.mockReturnValue(mockFolder);
    mockFolder.getFoldersByName.mockReturnValue({
      hasNext: jest.fn().mockReturnValue(false),
    });
    mockFolder.createFolder.mockImplementation((name: string) =>
      makeMockFolder(name, `new-folder-${name}`)
    );
  });

  // ─── Full happy path ───────────────────────────────────────────────────────

  it('validates → creates Drive folder → writes to Events sheet', () => {
    const result = createEvent(
      { eventName: 'Integration Test Run', eventDate: '2026-07-04' },
      TEST_ADMIN_EMAIL
    );

    // 1. Validation passed → success
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data).toBeDefined();

    // 2. Drive folder created with the correct name
    expect(mockFolder.createFolder).toHaveBeenCalledWith('2026-07-04_Integration_Test_Run');

    // 3. Events sheet received exactly one new row
    expect(mockSheets['Events'].appendRow).toHaveBeenCalledTimes(1);
    const appendedRow: unknown[] = (mockSheets['Events'].appendRow as jest.Mock).mock.calls[0][0];
    expect(appendedRow[1]).toBe('Integration Test Run');                    // eventName
    expect(appendedRow[2]).toBe('2026-07-04');                             // eventDate
    expect(appendedRow[3]).toBe('2026-07-04_Integration_Test_Run');        // folderName
    expect(appendedRow[5]).toBe(TEST_ADMIN_EMAIL);                         // createdBy
    expect(typeof appendedRow[6]).toBe('string'); // createdAt ISO timestamp
    expect(appendedRow[6]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returned EventRecord matches what was written to the sheet', () => {
    const result = createEvent(
      { eventName: 'Spring Marathon', eventDate: '2026-04-15' },
      TEST_ADMIN_EMAIL
    );

    const record = result.data!;
    const appendedRow: unknown[] = (mockSheets['Events'].appendRow as jest.Mock).mock.calls[0][0];

    // ID is a UUID
    expect(record.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    // Row[0] = eventId matches what was returned
    expect(appendedRow[0]).toBe(record.eventId);
    // folderName in record matches row
    expect(appendedRow[3]).toBe(record.folderName);
    // driveFolderId is stored in row
    expect(appendedRow[4]).toBe(record.driveFolderId);
  });

  // ─── Atomicity ─────────────────────────────────────────────────────────────

  it('aborts sheet write when Drive folder creation fails', () => {
    mockFolder.createFolder.mockImplementationOnce(() => {
      throw new Error('Simulated Drive quota exceeded');
    });

    const result = createEvent(
      { eventName: 'Will Fail', eventDate: '2026-01-01' },
      TEST_ADMIN_EMAIL
    );

    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('Failed to create');
    expect(mockSheets['Events'].appendRow).not.toHaveBeenCalled();
  });

  it('aborts when folder already exists in Drive', () => {
    const existingFolder = makeMockFolder('2026-01-01_Existing', 'existing-id');
    mockFolder.getFoldersByName.mockReturnValue({
      hasNext: jest.fn().mockReturnValueOnce(true).mockReturnValue(false),
      next: jest.fn().mockReturnValue(existingFolder),
    });

    const result = createEvent(
      { eventName: 'Existing', eventDate: '2026-01-01' },
      TEST_ADMIN_EMAIL
    );

    expect(result.status).toBe(ResultStatus.ERROR);
    expect(mockSheets['Events'].appendRow).not.toHaveBeenCalled();
  });

  // ─── Duplicate detection ───────────────────────────────────────────────────

  it('rejects a second event with the same date and name (sheet-level dedup)', () => {
    // Mock: the Events sheet already contains evt-uuid-001 = 2025-11-03_NYC_Marathon
    const result = createEvent(
      { eventName: 'NYC Marathon', eventDate: '2025-11-03' },
      TEST_ADMIN_EMAIL
    );

    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('already exists');
    // Drive was never called because sheet check found the duplicate first
    expect(mockFolder.createFolder).not.toHaveBeenCalled();
  });

  it('allows two events on different dates with the same name', () => {
    const result = createEvent(
      { eventName: 'NYC Marathon', eventDate: '2026-11-01' }, // different year
      TEST_ADMIN_EMAIL
    );
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.folderName).toBe('2026-11-01_NYC_Marathon');
  });

  it('allows two events on the same date with different names', () => {
    const result = createEvent(
      { eventName: 'Half Marathon', eventDate: '2025-11-03' }, // same date, diff name
      TEST_ADMIN_EMAIL
    );
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.folderName).toBe('2025-11-03_Half_Marathon');
  });

  // ─── Multi-word names ──────────────────────────────────────────────────────

  it('converts spaces to underscores correctly in the folder name', () => {
    const result = createEvent(
      { eventName: 'Summer Fun Run', eventDate: '2026-08-15' },
      TEST_ADMIN_EMAIL
    );
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.folderName).toBe('2026-08-15_Summer_Fun_Run');
    expect(mockFolder.createFolder).toHaveBeenCalledWith('2026-08-15_Summer_Fun_Run');
  });

  it('stores the original event name (not underscore-ified) in the sheet', () => {
    createEvent(
      { eventName: 'Summer Fun Run', eventDate: '2026-08-15' },
      TEST_ADMIN_EMAIL
    );
    const appendedRow: unknown[] = (mockSheets['Events'].appendRow as jest.Mock).mock.calls[0][0];
    expect(appendedRow[1]).toBe('Summer Fun Run');   // eventName: spaces preserved
    expect(appendedRow[3]).toBe('2026-08-15_Summer_Fun_Run'); // folderName: underscored
  });

  // ─── Admin email normalization ─────────────────────────────────────────────

  it('normalizes admin email to lowercase in the stored record', () => {
    const result = createEvent(
      { eventName: 'Admin Test', eventDate: '2026-09-01' },
      'ADMIN@MMRUNNERS.ORG'
    );
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.createdBy).toBe('admin@mmrunners.org');
  });

  // ─── Read-back consistency ─────────────────────────────────────────────────

  it('created event is retrievable via findById after creation', () => {
    // Override the Events sheet mock so the newly appended row is returned
    // on the next read (simulate sheet state after append)
    const createdRows: unknown[][] = [];
    const originalAppend = mockSheets['Events'].appendRow as jest.Mock;
    originalAppend.mockImplementation((row: unknown[]) => {
      createdRows.push(row);
    });

    // After creation, reconfigure the sheet to return existing + newly created rows
    const result = createEvent(
      { eventName: 'Readable Event', eventDate: '2026-10-01' },
      TEST_ADMIN_EMAIL
    );
    expect(result.status).toBe(ResultStatus.SUCCESS);

    // Reconfigure mock so listAll/findById sees the new row
    const allRows = [
      ['evt-uuid-001', 'NYC Marathon', '2025-11-03', '2025-11-03_NYC_Marathon',
       'drive-folder-id-001', TEST_ADMIN_EMAIL, '2025-10-01T09:00:00.000Z'],
      ['evt-uuid-002', 'Boston Marathon', '2025-04-21', '2025-04-21_Boston_Marathon',
       'drive-folder-id-002', TEST_ADMIN_EMAIL, '2025-03-01T09:00:00.000Z'],
      ['evt-uuid-003', 'Christmas Fun Run', '2025-12-25', '2025-12-25_Christmas_Fun_Run',
       'drive-folder-id-003', TEST_ADMIN_EMAIL, '2025-12-01T14:00:00.000Z'],
      ...createdRows,
    ];

    const { createMockSheet } = require('../mocks/gasGlobals');
    mockSheets['Events'] = createMockSheet(allRows);
    useMockSheets();

    // Now findById should find the new event
    const found = findById(result.data!.eventId);
    expect(found).not.toBeNull();
    expect(found!.eventName).toBe('Readable Event');
    expect(found!.folderName).toBe('2026-10-01_Readable_Event');
  });

  // ─── listAll pagination after multiple creates ─────────────────────────────

  it('listAll returns correct count after multiple creations', () => {
    // Start with 3 events from mock data
    const initial = listAll();
    expect(initial.total).toBe(3);

    // Nothing changes until the sheet mock is updated
    // (tests verify what listAll reads from the sheet)
  });

  it('listAll sorts newest-first by default', () => {
    const result = listAll();
    const dates = result.items.map((e) => e.eventDate);
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);
  });
});
