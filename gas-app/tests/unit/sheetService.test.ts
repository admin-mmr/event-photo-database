import { getAllRows, appendRow, findRowIndex, updateRow, getRowCount, ensureHeaders } from '../../src/services/sheetService';
import { mockSheets, resetMockSheets, createMockSheet } from '../mocks/gasGlobals';

// We need to re-import SpreadsheetApp mock to override getSheetByName per test
const mockSpreadsheetApp = (global as Record<string, unknown>)['SpreadsheetApp'] as {
  openById: jest.Mock;
};

describe('sheetService', () => {
  beforeEach(() => {
    resetMockSheets();
    // Restore default mock that looks up sheets by name
    mockSpreadsheetApp.openById.mockReturnValue({
      getSheetByName: jest.fn().mockImplementation((name: string) => mockSheets[name] ?? null),
    });
  });

  // ─── getAllRows ─────────────────────────────────────────────────────────────

  describe('getAllRows()', () => {
    it('returns all data rows (excluding header)', () => {
      const rows = getAllRows('Users');
      // Default mock has 3 data rows
      expect(rows).toHaveLength(3);
    });

    it('returns empty array when sheet has only header row', () => {
      const emptySheet = createMockSheet([]);
      emptySheet.getLastRow.mockReturnValue(1); // only header
      mockSpreadsheetApp.openById.mockReturnValue({
        getSheetByName: jest.fn().mockReturnValue(emptySheet),
      });
      const rows = getAllRows('Users');
      expect(rows).toHaveLength(0);
    });

    it('returns empty array when sheet is completely empty', () => {
      const emptySheet = createMockSheet([]);
      emptySheet.getLastRow.mockReturnValue(0);
      emptySheet.getLastColumn.mockReturnValue(0);
      mockSpreadsheetApp.openById.mockReturnValue({
        getSheetByName: jest.fn().mockReturnValue(emptySheet),
      });
      const rows = getAllRows('Users');
      expect(rows).toHaveLength(0);
    });

    it('throws a descriptive error when sheet does not exist', () => {
      mockSpreadsheetApp.openById.mockReturnValue({
        getSheetByName: jest.fn().mockReturnValue(null),
      });
      expect(() => getAllRows('NonExistentSheet')).toThrow(
        'Sheet "NonExistentSheet" not found'
      );
    });
  });

  // ─── appendRow ─────────────────────────────────────────────────────────────

  describe('appendRow()', () => {
    it('calls sheet.appendRow with the provided row', () => {
      const row = ['test@example.com', 'New_Bee', 'user', 'active', '2025-01-01', 'admin'];
      appendRow('Users', row);
      expect(mockSheets['Users'].appendRow).toHaveBeenCalledWith(row);
    });

    it('throws when sheet does not exist', () => {
      mockSpreadsheetApp.openById.mockReturnValue({
        getSheetByName: jest.fn().mockReturnValue(null),
      });
      expect(() => appendRow('Missing', ['data'])).toThrow('Sheet "Missing" not found');
    });
  });

  // ─── findRowIndex ───────────────────────────────────────────────────────────

  describe('findRowIndex()', () => {
    it('finds the row index for a matching value in column 0', () => {
      // Default mock: Users has admin@mmrunners.org at row index 0 (data row 1, sheet row 2)
      const idx = findRowIndex('Users', 0, 'admin@mmrunners.org');
      expect(idx).toBe(2); // 1-based sheet row (header=1, first data=2)
    });

    it('finds a row further down the sheet', () => {
      const idx = findRowIndex('Users', 0, 'inactive@example.com');
      expect(idx).toBe(4); // third data row = sheet row 4
    });

    it('returns -1 when value is not found', () => {
      const idx = findRowIndex('Users', 0, 'nobody@example.com');
      expect(idx).toBe(-1);
    });

    it('is case-sensitive', () => {
      // Emails are stored lowercase — searching uppercase should not match
      const idx = findRowIndex('Users', 0, 'Admin@mmrunners.org');
      expect(idx).toBe(-1);
    });

    it('returns -1 for an empty sheet', () => {
      const emptySheet = createMockSheet([]);
      emptySheet.getLastRow.mockReturnValue(0);
      emptySheet.getLastColumn.mockReturnValue(0);
      mockSpreadsheetApp.openById.mockReturnValue({
        getSheetByName: jest.fn().mockReturnValue(emptySheet),
      });
      expect(findRowIndex('Users', 0, 'test@example.com')).toBe(-1);
    });
  });

  // ─── updateRow ─────────────────────────────────────────────────────────────

  describe('updateRow()', () => {
    it('calls getRange and setValues with the new row', () => {
      const newRow = ['admin@mmrunners.org', 'Admin', 'admin', 'inactive', '2025-01-01', 'system'];
      updateRow('Users', 2, newRow);
      expect(mockSheets['Users'].getRange).toHaveBeenCalledWith(2, 1, 1, newRow.length);
    });

    it('throws when rowIndex is 1 (header row)', () => {
      expect(() => updateRow('Users', 1, ['data'])).toThrow(
        'Cannot update row 1: row 1 is the header.'
      );
    });

    it('throws when rowIndex is 0', () => {
      expect(() => updateRow('Users', 0, ['data'])).toThrow();
    });
  });

  // ─── getRowCount ────────────────────────────────────────────────────────────

  describe('getRowCount()', () => {
    it('returns the number of data rows', () => {
      // Default Users mock has lastRow = 4 (header + 3 data rows)
      const count = getRowCount('Users');
      expect(count).toBe(3);
    });

    it('returns 0 for a sheet with only a header row', () => {
      const emptySheet = createMockSheet([]);
      emptySheet.getLastRow.mockReturnValue(1);
      mockSpreadsheetApp.openById.mockReturnValue({
        getSheetByName: jest.fn().mockReturnValue(emptySheet),
      });
      expect(getRowCount('Users')).toBe(0);
    });
  });

  // ─── ensureHeaders ──────────────────────────────────────────────────────────

  describe('ensureHeaders()', () => {
    const EXPECTED = ['email', 'running_club', 'role', 'status', 'added_date', 'added_by'];

    it('writes headers to a completely empty sheet', () => {
      const emptySheet = createMockSheet([]);
      emptySheet.getLastRow.mockReturnValue(0);
      mockSpreadsheetApp.openById.mockReturnValue({
        getSheetByName: jest.fn().mockReturnValue(emptySheet),
      });
      ensureHeaders('Users', EXPECTED);
      expect(emptySheet.appendRow).toHaveBeenCalledWith(EXPECTED);
    });

    it('passes silently when headers match exactly', () => {
      const sheet = createMockSheet([]);
      sheet.getLastRow.mockReturnValue(2);
      // getRange(1, 1, 1, N).getValues() returns the header row
      sheet.getRange.mockImplementation(() => ({
        getValues: jest.fn().mockReturnValue([EXPECTED]),
        setValues: jest.fn(),
      }));
      mockSpreadsheetApp.openById.mockReturnValue({
        getSheetByName: jest.fn().mockReturnValue(sheet),
      });
      expect(() => ensureHeaders('Users', EXPECTED)).not.toThrow();
    });

    it('throws a schema drift error when headers do not match', () => {
      const sheet = createMockSheet([]);
      sheet.getLastRow.mockReturnValue(2);
      const WRONG_HEADERS = ['Email', 'Club', 'Role', 'Status', 'Date', 'By'];
      sheet.getRange.mockImplementation(() => ({
        getValues: jest.fn().mockReturnValue([WRONG_HEADERS]),
        setValues: jest.fn(),
      }));
      mockSpreadsheetApp.openById.mockReturnValue({
        getSheetByName: jest.fn().mockReturnValue(sheet),
      });
      expect(() => ensureHeaders('Users', EXPECTED)).toThrow('Schema drift detected');
    });
  });
});
