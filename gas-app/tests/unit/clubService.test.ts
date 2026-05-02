/**
 * clubService.test.ts — Unit tests for ClubService CRUD operations.
 *
 * ClubService manages the Clubs sheet: the authoritative list of approved
 * running clubs. normalizedName is the Drive folder name and is immutable.
 *
 * Uses the GAS global mocks installed by gasGlobals.ts, extended here with
 * a mock Clubs sheet.
 */

import {
  listAll,
  listActive,
  findByNormalizedName,
  createClub,
  updateClub,
  deactivateClub,
  reactivateClub,
} from '../../src/services/clubService';
import {
  mockSheets,
  resetMockSheets,
  createMockSheet,
  TEST_ADMIN_EMAIL,
} from '../mocks/gasGlobals';
import { ResultStatus } from '../../src/types/enums';

// ─── Test data ────────────────────────────────────────────────────────────────

/**
 * Sample Clubs sheet rows matching the actual sheet schema:
 * display_name | normalized_name | status | added_date | added_by
 */
const DEFAULT_CLUBS_ROWS: unknown[][] = [
  ['新蜂',   'New_Bee',        'active',   '2025-01-01', 'system'],
  ['岚山',   'Misty_Mountain', 'active',   '2025-01-01', 'system'],
  ['南开',   'Nankai',         'active',   '2025-01-01', 'system'],
  ['驰跑团', 'CHI',            'inactive', '2025-01-01', 'system'],
];

// ─── Setup helpers ────────────────────────────────────────────────────────────

const mockSpreadsheetApp = (global as Record<string, unknown>)['SpreadsheetApp'] as {
  openById: jest.Mock;
};

/**
 * Creates a mock sheet that properly simulates the header+data layout that
 * ClubService expects. Specifically:
 *   - getLastRow() = dataRows.length + 1  (header counts as row 1)
 *   - getRange(1, 1, 1, n) → header row (for ensureHeaders)
 *   - getRange(2, 1, n, m) → data rows (for getAllRows)
 */
// Must match the actual Clubs sheet header row (5 columns).
const CLUB_HEADERS = [
  'DISPLAY_NAME', 'NORMALIZED_NAME',
  'STATUS', 'ADDED_DATE', 'ADDED_BY',
];

function createClubSheet(dataRows: unknown[][] = DEFAULT_CLUBS_ROWS) {
  const mockSetValues = jest.fn();
  return {
    getLastRow: jest.fn().mockReturnValue(dataRows.length + 1),
    getLastColumn: jest.fn().mockReturnValue(CLUB_HEADERS.length),
    getRange: jest.fn().mockImplementation(
      (rowStart: number, _colStart: number, numRows?: number, numCols?: number) => {
        // Row 1 = header row (ensureHeaders reads it)
        if (rowStart === 1 && numRows === 1) {
          return {
            getValues: jest.fn().mockReturnValue([CLUB_HEADERS.slice(0, numCols ?? CLUB_HEADERS.length)]),
            setValues: mockSetValues,
          };
        }
        // Row 2+ = data rows (getAllRows reads from row 2)
        const sliceStart = rowStart - 2; // convert 1-based to 0-based data index
        const slice = dataRows.slice(sliceStart, numRows ? sliceStart + numRows : undefined);
        return {
          getValues: jest.fn().mockReturnValue(slice),
          setValues: mockSetValues,
        };
      }
    ),
    appendRow: jest.fn(),
  };
}

/**
 * Rebuilds the mockSheets registry with a fresh Clubs sheet, then re-wires
 * SpreadsheetApp so every openById call returns the updated sheets.
 */
function useMockSheets(clubRows: unknown[][] = DEFAULT_CLUBS_ROWS) {
  mockSheets['Clubs'] = createClubSheet(clubRows) as ReturnType<typeof createMockSheet>;
  mockSpreadsheetApp.openById.mockReturnValue({
    getSheetByName: jest.fn().mockImplementation((name: string) => mockSheets[name] ?? null),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('clubService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockSheets();
    useMockSheets();
  });

  // ── listAll ───────────────────────────────────────────────────────────────

  describe('listAll()', () => {
    it('returns all clubs including inactive ones', () => {
      const result = listAll(1, 50);
      expect(result.total).toBe(4);
      expect(result.items).toHaveLength(4);
    });

    it('returns correct pagination metadata', () => {
      const result = listAll(1, 2);
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(4);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(2);
    });

    it('returns the second page correctly', () => {
      const result = listAll(2, 2);
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(4);
    });

    it('returns empty items for an out-of-range page', () => {
      const result = listAll(99, 50);
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(4);
    });

    it('returns empty list when Clubs sheet is completely empty (no crash)', () => {
      // Simulate a truly empty sheet: getLastRow() = 0 → ensureHeaders writes headers,
      // then getAllRows returns [] → listAll returns empty result.
      const emptySheet = {
        getLastRow: jest.fn().mockReturnValue(0),
        getLastColumn: jest.fn().mockReturnValue(0),
        getRange: jest.fn().mockReturnValue({
          getValues: jest.fn().mockReturnValue([]),
          setValues: jest.fn(),
        }),
        appendRow: jest.fn(),
      };
      mockSheets['Clubs'] = emptySheet as ReturnType<typeof createMockSheet>;
      mockSpreadsheetApp.openById.mockReturnValue({
        getSheetByName: jest.fn().mockImplementation((name: string) => mockSheets[name] ?? null),
      });

      // Should not throw; appendRow called once (for header row write)
      expect(() => listAll(1, 50)).not.toThrow();
      expect(emptySheet.appendRow).toHaveBeenCalledTimes(1);
      const result = listAll(1, 50);
      expect(result.total).toBe(0);
    });
  });

  // ── listActive ────────────────────────────────────────────────────────────

  describe('listActive()', () => {
    it('returns only active clubs', () => {
      const clubs = listActive();
      expect(clubs.every((c) => c.status === 'active')).toBe(true);
    });

    it('excludes inactive clubs', () => {
      const clubs = listActive();
      expect(clubs.find((c) => c.normalizedName === 'CHI')).toBeUndefined();
    });

    it('returns 3 active clubs from the default dataset', () => {
      const clubs = listActive();
      expect(clubs).toHaveLength(3);
    });

    it('returns empty array when all clubs are inactive', () => {
      useMockSheets([
        ['驰跑团', 'CHI', 'inactive', '2025-01-01', 'system'],
      ]);
      const clubs = listActive();
      expect(clubs).toHaveLength(0);
    });
  });

  // ── findByNormalizedName ──────────────────────────────────────────────────

  describe('findByNormalizedName()', () => {
    it('returns the club record for a known normalizedName', () => {
      const club = findByNormalizedName('New_Bee');
      expect(club).not.toBeNull();
      expect(club!.displayName).toBe('新蜂');
      expect(club!.normalizedName).toBe('New_Bee');
    });

    it('returns null for an unknown normalizedName', () => {
      expect(findByNormalizedName('Unknown_Club')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(findByNormalizedName('')).toBeNull();
    });

    it('is case-sensitive (Drive folder names are case-sensitive)', () => {
      expect(findByNormalizedName('new_bee')).toBeNull();
      expect(findByNormalizedName('NEW_BEE')).toBeNull();
    });

    it('can find an inactive club', () => {
      const club = findByNormalizedName('CHI');
      expect(club).not.toBeNull();
      expect(club!.status).toBe('inactive');
    });
  });

  // ── createClub ────────────────────────────────────────────────────────────

  describe('createClub()', () => {
    it('creates a new club with valid inputs', () => {
      const result = createClub(
        { displayName: '爱跑', normalizedName: 'Love_to_Run' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toBeDefined();
      expect(result.data!.displayName).toBe('爱跑');
      expect(result.data!.normalizedName).toBe('Love_to_Run');
      expect(result.data!.status).toBe('active');
    });

    it('sets status to active on creation', () => {
      const result = createClub(
        { displayName: 'Test Club', normalizedName: 'Test_Club' },
        TEST_ADMIN_EMAIL
      );
      expect(result.data!.status).toBe('active');
    });

    it('records addedBy as the admin email (lowercased)', () => {
      const result = createClub(
        { displayName: 'Test Club', normalizedName: 'Test_Club' },
        'ADMIN@MMRUNNERS.ORG'
      );
      expect(result.data!.addedBy).toBe('admin@mmrunners.org');
    });

    it('writes one row to the Clubs sheet', () => {
      createClub(
        { displayName: 'Test', normalizedName: 'Test_X' },
        TEST_ADMIN_EMAIL
      );
      expect(mockSheets['Clubs'].appendRow).toHaveBeenCalledTimes(1);
    });

    it('trims whitespace from displayName and normalizedName', () => {
      const result = createClub(
        { displayName: '  SpacedName  ', normalizedName: '  Spaced_Name  ' },
        TEST_ADMIN_EMAIL
      );
      expect(result.data!.displayName).toBe('SpacedName');
      expect(result.data!.normalizedName).toBe('Spaced_Name');
    });

    it('returns ERROR when displayName is empty', () => {
      const result = createClub(
        { displayName: '', normalizedName: 'Test_Club' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'displayName')).toBe(true);
    });

    it('returns ERROR when normalizedName is empty', () => {
      const result = createClub(
        { displayName: 'Test', normalizedName: '' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'normalizedName')).toBe(true);
    });

    it('returns ERROR when normalizedName contains spaces', () => {
      const result = createClub(
        { displayName: 'Test Club', normalizedName: 'Test Club' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'normalizedName')).toBe(true);
    });

    it('returns ERROR when normalizedName contains special characters', () => {
      const result = createClub(
        { displayName: 'Test', normalizedName: 'Test-Club!' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'normalizedName')).toBe(true);
    });

    it('accepts normalizedName with underscores and numbers', () => {
      const result = createClub(
        { displayName: 'Run4Fun', normalizedName: 'Run4Fun_2026' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
    });

    it('returns ERROR when normalizedName already exists', () => {
      const result = createClub(
        { displayName: 'Another Bee', normalizedName: 'New_Bee' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('already exists');
    });

    it('does NOT write to sheet on validation failure', () => {
      createClub({ displayName: '', normalizedName: '' }, TEST_ADMIN_EMAIL);
      expect(mockSheets['Clubs'].appendRow).not.toHaveBeenCalled();
    });

    it('returns both field errors when both name fields are empty', () => {
      const result = createClub({ displayName: '', normalizedName: '' }, TEST_ADMIN_EMAIL);
      expect(result.errors!.length).toBeGreaterThanOrEqual(2);
      const fields = result.errors!.map((e) => e.field);
      expect(fields).toContain('displayName');
      expect(fields).toContain('normalizedName');
    });
  });

  // ── updateClub ────────────────────────────────────────────────────────────

  describe('updateClub()', () => {
    beforeEach(() => {
      // Already handled by createClubSheet mock in useMockSheets()
    });

    it('updates displayName of an existing club', () => {
      const result = updateClub(
        { normalizedName: 'New_Bee', displayName: '新蜂 Updated' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.displayName).toBe('新蜂 Updated');
    });

    it('keeps normalizedName immutable', () => {
      const result = updateClub(
        { normalizedName: 'New_Bee', displayName: 'New Display' },
        TEST_ADMIN_EMAIL
      );
      expect(result.data!.normalizedName).toBe('New_Bee');
    });

    it('preserves status on update', () => {
      const result = updateClub(
        { normalizedName: 'New_Bee', displayName: 'New Display' },
        TEST_ADMIN_EMAIL
      );
      expect(result.data!.status).toBe('active');
    });

    it('trims whitespace from displayName', () => {
      const result = updateClub(
        { normalizedName: 'New_Bee', displayName: '  Trimmed  ' },
        TEST_ADMIN_EMAIL
      );
      expect(result.data!.displayName).toBe('Trimmed');
    });

    it('returns ERROR for a non-existent normalizedName', () => {
      const result = updateClub(
        { normalizedName: 'No_Such_Club', displayName: 'x' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('not found');
    });

    it('returns ERROR when displayName is empty string', () => {
      const result = updateClub(
        { normalizedName: 'New_Bee', displayName: '' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'displayName')).toBe(true);
    });

    it('calls updateRow on the Clubs sheet on success', () => {
      const mockUpdateRow = jest.spyOn(
        require('../../src/services/sheetService'),
        'updateRow'
      );
      jest.spyOn(
        require('../../src/services/sheetService'),
        'findRowIndex'
      ).mockReturnValue(2);

      updateClub({ normalizedName: 'New_Bee', displayName: 'New Bee Updated' }, TEST_ADMIN_EMAIL);
      expect(mockUpdateRow).toHaveBeenCalledTimes(1);
    });

    it('returns ERROR when row not found in sheet (findRowIndex returns -1)', () => {
      jest.spyOn(
        require('../../src/services/sheetService'),
        'findRowIndex'
      ).mockReturnValue(-1);

      const result = updateClub(
        { normalizedName: 'New_Bee', displayName: 'Whatever' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('Could not locate row');
    });
  });

  // ── deactivateClub ────────────────────────────────────────────────────────

  describe('deactivateClub()', () => {
    beforeEach(() => {
      jest.spyOn(
        require('../../src/services/sheetService'),
        'findRowIndex'
      ).mockReturnValue(2);
    });

    it('deactivates an active club', () => {
      const result = deactivateClub('New_Bee');
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.status).toBe('inactive');
    });

    it('returns ERROR for a non-existent club', () => {
      const result = deactivateClub('No_Such_Club');
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('not found');
    });

    it('returns ERROR when club is already inactive', () => {
      const result = deactivateClub('CHI'); // CHI is already inactive in test data
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('already inactive');
    });

    it('writes the updated status to the Clubs sheet', () => {
      const mockUpdateRow = jest.spyOn(
        require('../../src/services/sheetService'),
        'updateRow'
      );
      deactivateClub('New_Bee');
      expect(mockUpdateRow).toHaveBeenCalledTimes(1);
      const updatedRow: unknown[] = mockUpdateRow.mock.calls[0][2] as unknown[];
      // Status column is index 2: display(0) normalized(1) status(2)
      expect(updatedRow[2]).toBe('inactive');
    });
  });

  // ── reactivateClub ────────────────────────────────────────────────────────

  describe('reactivateClub()', () => {
    beforeEach(() => {
      jest.spyOn(
        require('../../src/services/sheetService'),
        'findRowIndex'
      ).mockReturnValue(4); // CHI is row 4 (1-based with header)
    });

    it('reactivates an inactive club', () => {
      const result = reactivateClub('CHI');
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.status).toBe('active');
      expect(result.data!.normalizedName).toBe('CHI');
    });

    it('returns ERROR for a non-existent club', () => {
      const result = reactivateClub('No_Such_Club');
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('not found');
    });

    it('returns ERROR when club is already active', () => {
      const result = reactivateClub('New_Bee'); // active in test data
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('already active');
    });

    it('writes the updated status (active) to the Clubs sheet', () => {
      const mockUpdateRow = jest.spyOn(
        require('../../src/services/sheetService'),
        'updateRow'
      );
      reactivateClub('CHI');
      expect(mockUpdateRow).toHaveBeenCalledTimes(1);
      const updatedRow: unknown[] = mockUpdateRow.mock.calls[0][2] as unknown[];
      // Status column is index 2: display(0) normalized(1) status(2)
      expect(updatedRow[2]).toBe('active');
    });
  });

  // ── deactivate → reactivate roundtrip ─────────────────────────────────────

  describe('deactivate → reactivate lifecycle', () => {
    it('a club can be deactivated then reactivated', () => {
      jest.spyOn(
        require('../../src/services/sheetService'),
        'findRowIndex'
      ).mockReturnValue(2);

      const deactivateResult = deactivateClub('New_Bee');
      expect(deactivateResult.status).toBe(ResultStatus.SUCCESS);
      expect(deactivateResult.data!.status).toBe('inactive');

      // Simulate the sheet now showing New_Bee as inactive
      const updatedRows = [
        ['新蜂',   'New_Bee',        'inactive', '2025-01-01', 'system'],
        ['岚山',   'Misty_Mountain', 'active',   '2025-01-01', 'system'],
        ['南开',   'Nankai',         'active',   '2025-01-01', 'system'],
        ['驰跑团', 'CHI',            'inactive', '2025-01-01', 'system'],
      ];
      useMockSheets(updatedRows);

      const reactivateResult = reactivateClub('New_Bee');
      expect(reactivateResult.status).toBe(ResultStatus.SUCCESS);
      expect(reactivateResult.data!.status).toBe('active');
    });
  });
});
