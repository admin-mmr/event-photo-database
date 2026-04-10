import {
  findById,
  findByFolderName,
  listAll,
  createEvent,
  updateEvent,
  validateCreateInput,
} from '../../src/services/eventService';
import {
  mockSheets,
  mockFolder,
  resetMockSheets,
  createMockSheet,
  TEST_ADMIN_EMAIL,
  resetUuidCounter,
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

describe('eventService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockSheets();
    resetUuidCounter();
    useMockSheets();
  });

  // ─── findById ──────────────────────────────────────────────────────────────

  describe('findById()', () => {
    it('returns the event record for a known UUID', () => {
      const event = findById('evt-uuid-001');
      expect(event).not.toBeNull();
      expect(event!.eventName).toBe('NYC Marathon');
    });

    it('returns the correct event when multiple exist', () => {
      const event = findById('evt-uuid-002');
      expect(event).not.toBeNull();
      expect(event!.eventName).toBe('Boston Marathon');
    });

    it('returns null for an unknown UUID', () => {
      expect(findById('evt-uuid-999')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(findById('')).toBeNull();
    });
  });

  // ─── findByFolderName ──────────────────────────────────────────────────────

  describe('findByFolderName()', () => {
    it('returns the event for a known folder name', () => {
      const event = findByFolderName('2025-11-03_NYC_Marathon');
      expect(event).not.toBeNull();
      expect(event!.eventId).toBe('evt-uuid-001');
    });

    it('returns null for a non-existent folder name', () => {
      expect(findByFolderName('2025-01-01_No_Such_Event')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(findByFolderName('')).toBeNull();
    });

    it('is case-sensitive (folder names use exact casing)', () => {
      // Folder names are case-sensitive in Drive
      expect(findByFolderName('2025-11-03_nyc_marathon')).toBeNull();
    });
  });

  // ─── listAll ───────────────────────────────────────────────────────────────

  describe('listAll()', () => {
    it('returns all events sorted by date descending (default)', () => {
      const result = listAll();
      expect(result.total).toBe(3);
      // 2025-12-25 is newest
      expect(result.items[0].eventDate).toBe('2025-12-25');
      // 2025-04-21 is oldest
      expect(result.items[2].eventDate).toBe('2025-04-21');
    });

    it('sorts ascending when requested', () => {
      const result = listAll(1, 20, 'asc');
      expect(result.items[0].eventDate).toBe('2025-04-21');
      expect(result.items[2].eventDate).toBe('2025-12-25');
    });

    it('returns correct pagination metadata', () => {
      const result = listAll(1, 2);
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(3);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(2);
    });

    it('returns second page correctly', () => {
      const result = listAll(2, 2);
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(3);
    });

    it('returns empty items for an out-of-range page', () => {
      const result = listAll(99, 20);
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(3);
    });

    it('returns empty result when Events sheet is empty', () => {
      mockSheets['Events'] = createMockSheet([]);
      const result = listAll();
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
    });
  });

  // ─── createEvent ───────────────────────────────────────────────────────────

  describe('createEvent()', () => {
    it('creates an event with valid inputs', () => {
      const result = createEvent(
        { eventName: 'Spring Relay', eventDate: '2026-03-15' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toBeDefined();
      expect(result.data!.folderName).toBe('2026-03-15_Spring_Relay');
      expect(result.data!.eventName).toBe('Spring Relay');
      expect(result.data!.eventDate).toBe('2026-03-15');
    });

    it('assigns a UUID-shaped eventId', () => {
      const result = createEvent(
        { eventName: 'Spring Relay', eventDate: '2026-03-15' },
        TEST_ADMIN_EMAIL
      );
      // UUID v4 pattern
      expect(result.data!.eventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('converts spaces to underscores in folder name', () => {
      const result = createEvent(
        { eventName: 'NYC Half Marathon', eventDate: '2026-03-15' },
        TEST_ADMIN_EMAIL
      );
      expect(result.data!.folderName).toBe('2026-03-15_NYC_Half_Marathon');
    });

    it('collapses multiple spaces into single underscore in folder name', () => {
      const result = createEvent(
        { eventName: 'NYC  Half   Marathon', eventDate: '2026-03-15' },
        TEST_ADMIN_EMAIL
      );
      // Multiple spaces are collapsed, producing a valid Layer 1 folder name
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.folderName).toBe('2026-03-15_NYC_Half_Marathon');
    });

    it('normalizes adminEmail to lowercase', () => {
      const result = createEvent(
        { eventName: 'Test Run', eventDate: '2026-06-01' },
        'Admin@MMRUNNERS.ORG'
      );
      expect(result.data!.createdBy).toBe('admin@mmrunners.org');
    });

    it('trims leading/trailing whitespace from eventName', () => {
      const result = createEvent(
        { eventName: '  Spring Relay  ', eventDate: '2026-03-15' },
        TEST_ADMIN_EMAIL
      );
      expect(result.data!.eventName).toBe('Spring Relay');
    });

    it('writes exactly one row to the Events sheet on success', () => {
      createEvent(
        { eventName: 'Test Event', eventDate: '2026-06-01' },
        TEST_ADMIN_EMAIL
      );
      expect(mockSheets['Events'].appendRow).toHaveBeenCalledTimes(1);
    });

    it('writes the correct row data to the Events sheet', () => {
      createEvent(
        { eventName: 'Test Event', eventDate: '2026-06-01' },
        TEST_ADMIN_EMAIL
      );
      const appendedRow: unknown[] = (mockSheets['Events'].appendRow as jest.Mock).mock.calls[0][0];
      expect(appendedRow[1]).toBe('Test Event');           // eventName
      expect(appendedRow[2]).toBe('2026-06-01');           // eventDate
      expect(appendedRow[3]).toBe('2026-06-01_Test_Event'); // folderName
      expect(appendedRow[5]).toBe(TEST_ADMIN_EMAIL);       // createdBy
    });

    it('calls Drive to create the event folder', () => {
      createEvent(
        { eventName: 'Drive Test', eventDate: '2026-07-04' },
        TEST_ADMIN_EMAIL
      );
      expect(mockFolder.createFolder).toHaveBeenCalledWith('2026-07-04_Drive_Test');
    });

    // Validation failures

    it('rejects empty event name', () => {
      const result = createEvent(
        { eventName: '', eventDate: '2026-03-15' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors).toBeDefined();
      expect(result.errors![0].field).toBe('eventName');
    });

    it('rejects whitespace-only event name', () => {
      const result = createEvent(
        { eventName: '   ', eventDate: '2026-03-15' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors![0].field).toBe('eventName');
    });

    it('rejects empty event date', () => {
      const result = createEvent(
        { eventName: 'Test', eventDate: '' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors![0].field).toBe('eventDate');
    });

    it('rejects invalid date format (wrong order)', () => {
      const result = createEvent(
        { eventName: 'Test', eventDate: '15-03-2026' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('rejects impossible calendar date (Feb 30)', () => {
      const result = createEvent(
        { eventName: 'Test', eventDate: '2026-02-30' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.message.includes('valid calendar date'))).toBe(true);
    });

    it('rejects impossible calendar date (April 31)', () => {
      const result = createEvent(
        { eventName: 'Test', eventDate: '2026-04-31' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('rejects special characters in event name', () => {
      const result = createEvent(
        { eventName: 'NYC Marathon!', eventDate: '2026-03-15' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors![0].field).toBe('eventName');
    });

    it('rejects event name with hyphen', () => {
      const result = createEvent(
        { eventName: 'Half-Marathon', eventDate: '2026-03-15' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('rejects event name over 100 characters', () => {
      const longName = 'A'.repeat(101);
      const result = createEvent(
        { eventName: longName, eventDate: '2026-03-15' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('accepts event name exactly 100 characters', () => {
      const name = 'A'.repeat(97) + 'Run'; // 100 chars, letters only
      const result = createEvent(
        { eventName: name, eventDate: '2026-03-15' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
    });

    it('accepts event name with embedded numbers (alphanumeric segment)', () => {
      // 'Run4Fun' produces segment '_Run4Fun' — starts with uppercase, valid Layer 1
      const result = createEvent(
        { eventName: 'Run4Fun', eventDate: '2026-06-01' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.folderName).toBe('2026-06-01_Run4Fun');
    });

    it('rejects duplicate folder name', () => {
      const result = createEvent(
        { eventName: 'NYC Marathon', eventDate: '2025-11-03' }, // matches evt-uuid-001
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('already exists');
    });

    it('does NOT write to sheet if Drive folder creation fails', () => {
      mockFolder.createFolder.mockImplementationOnce(() => {
        throw new Error('Drive quota exceeded');
      });
      const result = createEvent(
        { eventName: 'Fail Test', eventDate: '2026-06-01' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(mockSheets['Events'].appendRow).not.toHaveBeenCalled();
    });

    it('returns both field errors when both name and date are missing', () => {
      const result = createEvent(
        { eventName: '', eventDate: '' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors).toHaveLength(2);
      expect(result.errors!.map((e) => e.field)).toContain('eventName');
      expect(result.errors!.map((e) => e.field)).toContain('eventDate');
    });
  });

  // ─── updateEvent ───────────────────────────────────────────────────────────

  describe('updateEvent()', () => {
    it('updates event name for an existing event', () => {
      // Mock findRowIndex to return a valid row index
      jest.spyOn(
        require('../../src/services/sheetService'),
        'findRowIndex'
      ).mockReturnValue(2);

      const result = updateEvent(
        { eventId: 'evt-uuid-001', eventName: 'NYC Marathon 2025' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.eventName).toBe('NYC Marathon 2025');
    });

    it('preserves immutable fields (folderName, driveFolderId)', () => {
      jest.spyOn(
        require('../../src/services/sheetService'),
        'findRowIndex'
      ).mockReturnValue(2);

      const result = updateEvent(
        { eventId: 'evt-uuid-001', eventName: 'Updated Name' },
        TEST_ADMIN_EMAIL
      );
      expect(result.data!.folderName).toBe('2025-11-03_NYC_Marathon');    // Unchanged
      expect(result.data!.driveFolderId).toBe('drive-folder-id-001');     // Unchanged
    });

    it('preserves existing eventDate when not provided', () => {
      jest.spyOn(
        require('../../src/services/sheetService'),
        'findRowIndex'
      ).mockReturnValue(2);

      const result = updateEvent(
        { eventId: 'evt-uuid-001', eventName: 'Updated Name' },
        TEST_ADMIN_EMAIL
      );
      expect(result.data!.eventDate).toBe('2025-11-03');  // Preserved
    });

    it('preserves existing eventName when only date is updated', () => {
      jest.spyOn(
        require('../../src/services/sheetService'),
        'findRowIndex'
      ).mockReturnValue(2);

      const result = updateEvent(
        { eventId: 'evt-uuid-001', eventDate: '2025-11-10' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.eventName).toBe('NYC Marathon');  // Preserved
      expect(result.data!.eventDate).toBe('2025-11-10');    // Updated
    });

    it('trims whitespace from updated eventName', () => {
      jest.spyOn(
        require('../../src/services/sheetService'),
        'findRowIndex'
      ).mockReturnValue(2);

      const result = updateEvent(
        { eventId: 'evt-uuid-001', eventName: '  Trimmed Name  ' },
        TEST_ADMIN_EMAIL
      );
      expect(result.data!.eventName).toBe('Trimmed Name');
    });

    it('returns ERROR for non-existent event', () => {
      const result = updateEvent(
        { eventId: 'evt-uuid-999', eventName: 'Nope' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('not found');
    });

    it('rejects invalid date on update', () => {
      const result = updateEvent(
        { eventId: 'evt-uuid-001', eventDate: 'not-a-date' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors![0].field).toBe('eventDate');
    });

    it('rejects impossible calendar date on update (Feb 30)', () => {
      const result = updateEvent(
        { eventId: 'evt-uuid-001', eventDate: '2026-02-30' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('rejects empty eventName on update', () => {
      const result = updateEvent(
        { eventId: 'evt-uuid-001', eventName: '' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors![0].field).toBe('eventName');
    });

    it('rejects eventName over 100 characters on update', () => {
      const result = updateEvent(
        { eventId: 'evt-uuid-001', eventName: 'A'.repeat(101) },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('returns ERROR if row not found in sheet (findRowIndex returns -1)', () => {
      jest.spyOn(
        require('../../src/services/sheetService'),
        'findRowIndex'
      ).mockReturnValue(-1);

      const result = updateEvent(
        { eventId: 'evt-uuid-001', eventName: 'Unreachable Row' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('Could not locate row');
    });

    it('calls updateRow on the Events sheet when successful', () => {
      const mockUpdateRow = jest.spyOn(
        require('../../src/services/sheetService'),
        'updateRow'
      );
      jest.spyOn(
        require('../../src/services/sheetService'),
        'findRowIndex'
      ).mockReturnValue(2);

      updateEvent(
        { eventId: 'evt-uuid-001', eventName: 'Updated' },
        TEST_ADMIN_EMAIL
      );
      expect(mockUpdateRow).toHaveBeenCalledTimes(1);
    });
  });

  // ─── validateCreateInput ───────────────────────────────────────────────────

  describe('validateCreateInput()', () => {
    it('returns empty errors for valid input', () => {
      const errors = validateCreateInput({
        eventName: 'Good Name',
        eventDate: '2026-03-15',
      });
      expect(errors).toHaveLength(0);
    });

    it('returns error for missing event name', () => {
      const errors = validateCreateInput({ eventName: '', eventDate: '2026-03-15' });
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('eventName');
    });

    it('returns error for missing event date', () => {
      const errors = validateCreateInput({ eventName: 'Test', eventDate: '' });
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('eventDate');
    });

    it('returns multiple errors when both fields are empty', () => {
      const errors = validateCreateInput({ eventName: '', eventDate: '' });
      expect(errors).toHaveLength(2);
      expect(errors.map((e) => e.field)).toContain('eventName');
      expect(errors.map((e) => e.field)).toContain('eventDate');
    });

    it('accepts single-word event name', () => {
      expect(validateCreateInput({ eventName: 'Christmas', eventDate: '2026-12-25' })).toHaveLength(0);
    });

    it('accepts event name with numbers', () => {
      expect(validateCreateInput({ eventName: 'Run4Fun 2026', eventDate: '2026-06-01' })).toHaveLength(0);
    });

    it('accepts multi-word event name with spaces', () => {
      expect(validateCreateInput({ eventName: 'NYC Half Marathon', eventDate: '2026-04-01' })).toHaveLength(0);
    });

    it('rejects event name with special characters', () => {
      const errors = validateCreateInput({ eventName: 'Test!', eventDate: '2026-01-01' });
      expect(errors.some((e) => e.field === 'eventName')).toBe(true);
    });

    it('rejects event name with hyphen', () => {
      const errors = validateCreateInput({ eventName: 'Half-Marathon', eventDate: '2026-01-01' });
      expect(errors.some((e) => e.field === 'eventName')).toBe(true);
    });

    it('rejects event name exceeding 100 characters', () => {
      const errors = validateCreateInput({ eventName: 'A'.repeat(101), eventDate: '2026-01-01' });
      expect(errors.some((e) => e.field === 'eventName')).toBe(true);
    });

    it('accepts event name of exactly 100 characters (letters only)', () => {
      const errors = validateCreateInput({ eventName: 'A'.repeat(100), eventDate: '2026-01-01' });
      expect(errors).toHaveLength(0);
    });

    it('rejects invalid date format (wrong separator)', () => {
      const errors = validateCreateInput({ eventName: 'Test', eventDate: '2026/03/15' });
      expect(errors.some((e) => e.field === 'eventDate')).toBe(true);
    });

    it('rejects invalid month (00)', () => {
      const errors = validateCreateInput({ eventName: 'Test', eventDate: '2026-00-15' });
      expect(errors.some((e) => e.field === 'eventDate')).toBe(true);
    });

    it('rejects invalid month (13)', () => {
      const errors = validateCreateInput({ eventName: 'Test', eventDate: '2026-13-01' });
      expect(errors.some((e) => e.field === 'eventDate')).toBe(true);
    });

    it('rejects Feb 30 (impossible date)', () => {
      const errors = validateCreateInput({ eventName: 'Test', eventDate: '2026-02-30' });
      expect(errors.some((e) => e.message.includes('valid calendar date'))).toBe(true);
    });

    it('accepts a valid leap year date (Feb 29, 2028)', () => {
      const errors = validateCreateInput({ eventName: 'Leap Day Run', eventDate: '2028-02-29' });
      expect(errors).toHaveLength(0);
    });

    it('rejects Feb 29 on a non-leap year', () => {
      const errors = validateCreateInput({ eventName: 'Test', eventDate: '2026-02-29' });
      expect(errors.some((e) => e.field === 'eventDate')).toBe(true);
    });
  });
});
