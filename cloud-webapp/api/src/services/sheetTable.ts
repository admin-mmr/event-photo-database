/**
 * sheetTable.ts — small helpers shared by the control-plane Sheet-write stores
 * (userStore, clubStore, auditStore, …). The Google Sheet is SSOT (dev plan D2);
 * these read a whole tab into addressable rows and build the A1 ranges the
 * `values.update` path needs for in-place edits.
 *
 * Concurrency: writes go through a per-tab serialized lock (`withTabLock`) so two
 * concurrent admin actions can't read the same last-row and append/overwrite on
 * top of each other — the Sheets API has no transactions (dev plan §3, R1/R2).
 */

import { getSheetValues } from './sheetsService.js';

/** A data row plus its 1-based sheet row number (A1 row), for `values.update`. */
export interface SheetRow {
  /** 1-based row number in the sheet (header row, if any, is row 1). */
  rowNumber: number;
  /** Raw cell strings, left-to-right; short rows are NOT right-padded by the API. */
  cells: string[];
}

const norm = (s: string): string => s.toLowerCase().replace(/[\s_]/g, '');

/**
 * True when `row`'s id-column cell matches `headerToken` (case/space/underscore-
 * insensitive) — gas-app writes such a header row. Mirrors reconcileService.
 */
export function isHeaderRow(row: string[] | undefined, idCol: number, headerToken: string): boolean {
  if (!row) return false;
  return norm((row[idCol] ?? '').trim()) === norm(headerToken);
}

/** Trimmed cell accessor; missing cells read as ''. */
export const cell = (row: string[], i: number): string => (row[i] ?? '').trim();

/**
 * Read a tab as addressable data rows (header skipped, blank id-column rows
 * dropped). `lastCol` is the rightmost column letter to fetch (e.g. 'K').
 * `idCol`/`headerToken` identify+skip the header and drop spacer rows.
 */
export async function readTab(
  spreadsheetId: string,
  tab: string,
  lastCol: string,
  idCol: number,
  headerToken: string,
  opts?: { token?: string },
): Promise<SheetRow[]> {
  const values = await getSheetValues(spreadsheetId, `${tab}!A1:${lastCol}`, opts);
  const out: SheetRow[] = [];
  values.forEach((cells, i) => {
    const rowNumber = i + 1; // A1 is row 1
    if (i === 0 && isHeaderRow(cells, idCol, headerToken)) return;
    if (cell(cells, idCol) === '') return; // blank/spacer row
    out.push({ rowNumber, cells });
  });
  return out;
}

/** Build the A1 range that exactly spans one row, e.g. ('Users','A','K',7) → 'Users!A7:K7'. */
export function rowRange(tab: string, firstCol: string, lastCol: string, rowNumber: number): string {
  return `${tab}!${firstCol}${rowNumber}:${lastCol}${rowNumber}`;
}

// ── Per-tab write serialization ────────────────────────────────────────────
// In-process promise chain per tab. A single Cloud Run instance serializes its
// own writes; combined with the G6 "freeze gas-app writes" cutover this gives a
// single writer per tab. (Cross-instance contention at our admin volume is
// negligible; revisit with a Firestore lock doc if that changes.)
const locks = new Map<string, Promise<unknown>>();

export async function withTabLock<T>(tab: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(tab) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  locks.set(tab, prev.then(() => gate));
  try {
    await prev.catch(() => undefined); // wait our turn; ignore prior errors
    return await fn();
  } finally {
    release();
  }
}
