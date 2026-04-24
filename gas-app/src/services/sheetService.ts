import { getConfig } from '../config/constants';

/* global SpreadsheetApp */

/**
 * SheetService — generic read/write layer for all Google Sheets operations.
 *
 * All methods take a sheet name (from SHEET_NAMES constants) and operate on
 * the single Spreadsheet configured in Script Properties.
 *
 * Conventions:
 *   - Row indices returned/accepted are 1-based (matching Sheets API)
 *   - Row index 1 is the header row and is always skipped in data reads
 *   - Data rows start at index 2
 *   - Returns empty arrays instead of throwing when sheets have no data
 */

/**
 * Opens the configured spreadsheet. Called once per request to avoid
 * repeated API calls; cache at the caller level for batch operations.
 */
function openSpreadsheet(): GoogleAppsScript.Spreadsheet.Spreadsheet {
  const config = getConfig();
  return SpreadsheetApp.openById(config.SPREADSHEET_ID);
}

/**
 * Gets the named sheet, throws a descriptive error if it doesn't exist.
 */
function getSheet(sheetName: string): GoogleAppsScript.Spreadsheet.Sheet {
  const sheet = openSpreadsheet().getSheetByName(sheetName);
  if (!sheet) {
    throw new Error(
      `Sheet "${sheetName}" not found. ` +
      'Verify the sheet exists and the name matches SHEET_NAMES constants.'
    );
  }
  return sheet;
}

/**
 * Returns all data rows from a sheet as a 2D array of unknown values.
 * Row 1 (header) is excluded. Returns [] if the sheet has no data rows.
 *
 * @param sheetName  Name of the sheet tab
 */
export function getAllRows(sheetName: string): unknown[][] {
  const sheet = getSheet(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return []; // Only header row or empty

  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];

  // getRange(row, col, numRows, numCols) — 1-based, skip header row
  return sheet
    .getRange(2, 1, lastRow - 1, lastCol)
    .getValues() as unknown[][];
}

/**
 * Appends a single row to the end of the sheet.
 *
 * @param sheetName  Target sheet tab name
 * @param row        Array of values in column order
 */
export function appendRow(sheetName: string, row: unknown[]): void {
  const sheet = getSheet(sheetName);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sheet.appendRow(row as any[]);
  // Force the write to commit before this function returns. Without flush(),
  // subsequent reads (including from the next page request) may see the
  // pre-append state of the sheet — new rows appear to "disappear" until the
  // Sheets backend catches up. See sheetService docstring.
  SpreadsheetApp.flush();
}

/**
 * Searches a column for a matching value and returns the 1-based row index.
 * Searches only data rows (skips header). Returns -1 if not found.
 *
 * @param sheetName  Target sheet tab name
 * @param colIndex   0-based column index to search in
 * @param value      Value to match (case-sensitive string comparison)
 */
export function findRowIndex(
  sheetName: string,
  colIndex: number,
  value: string
): number {
  const rows = getAllRows(sheetName);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][colIndex] ?? '').trim() === value) {
      return i + 2; // +2 because: +1 for 0→1 base, +1 for skipped header
    }
  }
  return -1;
}

/**
 * Replaces all cells in an existing data row.
 * rowIndex must be 1-based (as returned by findRowIndex).
 *
 * @param sheetName  Target sheet tab name
 * @param rowIndex   1-based row number to update
 * @param row        New row values (must match column count)
 */
export function updateRow(
  sheetName: string,
  rowIndex: number,
  row: unknown[]
): void {
  if (rowIndex < 2) {
    throw new Error(`Cannot update row ${rowIndex}: row 1 is the header.`);
  }
  const sheet = getSheet(sheetName);
  sheet
    .getRange(rowIndex, 1, 1, row.length)
    .setValues([row]);
  // Force commit so subsequent reads (same or next execution) see the update.
  SpreadsheetApp.flush();
}

/**
 * Returns the raw cell values for a single data row (1-based rowIndex).
 * Returns [] if rowIndex is out of range.
 */
export function getRow(sheetName: string, rowIndex: number): unknown[] {
  if (rowIndex < 2) return [];
  const sheet = getSheet(sheetName);
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0] as unknown[];
}

/**
 * Writes multiple rows in a single range-write API call.
 *
 * All updates are merged into one setValues() covering the span from the
 * smallest to the largest rowIndex. Any intermediate rows that are not in
 * `updates` are filled from `preloadedRows` (0-based, no header row) when
 * provided, or fetched from the sheet with one getValues() call.
 *
 * Pass `preloadedRows` when you already have the sheet data in memory (e.g.
 * the return value of getAllRows) to avoid an extra API read.
 *
 * @param sheetName     Target sheet tab name
 * @param updates       Rows to write — rowIndex is 1-based (as returned by findRowIndex)
 * @param preloadedRows Optional pre-fetched data rows (index 0 = sheet data row 2)
 */
export function batchUpdateRows(
  sheetName: string,
  updates: Array<{ rowIndex: number; row: unknown[] }>,
  preloadedRows?: unknown[][]
): void {
  if (updates.length === 0) return;

  const sheet = getSheet(sheetName);
  const rowIndices = updates.map(u => u.rowIndex);
  const minRow = Math.min(...rowIndices);
  const maxRow = Math.max(...rowIndices);

  if (minRow < 2) {
    throw new Error(`Cannot update row ${minRow}: row 1 is the header.`);
  }

  const numCols = sheet.getLastColumn();
  if (numCols === 0) return;

  const numRows = maxRow - minRow + 1;

  // Build the values matrix for the range (min..max), filling non-updated rows
  // from the preloaded cache or a fresh sheet read.
  let baseValues: unknown[][];
  if (preloadedRows) {
    // preloadedRows[0] corresponds to sheet row 2 (0-based data, header excluded)
    baseValues = Array.from({ length: numRows }, (_, i) => {
      const dataIdx = (minRow - 2) + i; // 1-based sheet row → 0-based data index
      const existing = preloadedRows[dataIdx];
      if (existing) {
        const padded = [...existing];
        while (padded.length < numCols) padded.push('');
        return padded;
      }
      return Array<unknown>(numCols).fill('');
    });
  } else {
    baseValues = sheet
      .getRange(minRow, 1, numRows, numCols)
      .getValues() as unknown[][];
  }

  // Overlay the caller's updates onto the matrix
  for (const { rowIndex, row } of updates) {
    const i = rowIndex - minRow; // 0-based index within the range
    const padded = [...row];
    while (padded.length < numCols) padded.push('');
    baseValues[i] = padded;
  }

  // Single setValues call covering the entire span
  sheet.getRange(minRow, 1, numRows, numCols).setValues(baseValues);
  // Force commit so subsequent reads see the batch update.
  SpreadsheetApp.flush();
}

/**
 * Returns the number of data rows in a sheet (excluding header).
 */
export function getRowCount(sheetName: string): number {
  const sheet = getSheet(sheetName);
  return Math.max(0, sheet.getLastRow() - 1);
}

/**
 * Ensures a sheet has the correct header row.
 * If the sheet is empty, writes the headers. If headers exist, validates them.
 * Throws if expected headers don't match (schema drift detection).
 *
 * @param sheetName        Sheet tab name
 * @param expectedHeaders  Expected header values in column order
 */
export function ensureHeaders(
  sheetName: string,
  expectedHeaders: string[]
): void {
  const sheet = getSheet(sheetName);
  if (sheet.getLastRow() === 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sheet.appendRow(expectedHeaders as any[]);
    return;
  }
  const actual = sheet
    .getRange(1, 1, 1, expectedHeaders.length)
    .getValues()[0] as unknown[];
  const mismatched = expectedHeaders.filter(
    (h, i) => String(actual[i] ?? '').trim() !== h
  );
  if (mismatched.length > 0) {
    throw new Error(
      `Schema drift detected in sheet "${sheetName}". ` +
      `Mismatched headers: ${mismatched.join(', ')}. ` +
      'Check that COLUMNS constants match the actual sheet column order.'
    );
  }
}
