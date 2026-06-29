/**
 * specialFoldersStore.ts — authoritative state for the managed "special
 * folders" (Photos_NNN buckets, per-(event,club,tag) Videos/Album folders),
 * stored on the master Google Sheet's Special_Folders tab (SSOT, dev plan D2)
 * with a best-effort Firestore read cache. Cloud-webapp port of the gas-app
 * Special_Folders sheet model.
 *
 * Column layout mirrors gas-app SPECIAL_FOLDERS_HEADERS exactly (A..J):
 *   FOLDER_ID EVENT_ID SCOPE CLUB_NAME TAG FOLDER_NAME FOLDER_INDEX FOLDER_URL
 *   FILE_COUNT LAST_REFRESHED_AT
 *
 * `folderId` (col A) is the upsert key. Writes serialise through withTabLock so
 * two concurrent rebuilds can't append on top of each other (no Sheets txns).
 * The Sheet holds only folder IDs / counts — never secrets — so it satisfies the
 * "Sheet is world-viewable" rule in CLAUDE.md.
 */

import { appendSheetValues, clearSheetValues, ensureSheetTab, updateSheetValues } from './sheetsService.js';
import { cell, readTab, rowRange, withTabLock, type SheetRow } from './sheetTable.js';
import { firestore } from '../lib/firestore.js';
import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';

export type SpecialFolderScope = 'photos' | 'videos' | 'albums';

export interface SpecialFolderRecord {
  folderId: string;
  eventId: string;
  scope: SpecialFolderScope;
  clubName: string;
  tag: string;
  folderName: string;
  folderIndex: number;
  folderUrl: string;
  fileCount: number;
  lastRefreshedAt: string;
}

export const SPECIAL_FOLDERS_HEADERS: ReadonlyArray<string> = [
  'FOLDER_ID',
  'EVENT_ID',
  'SCOPE',
  'CLUB_NAME',
  'TAG',
  'FOLDER_NAME',
  'FOLDER_INDEX',
  'FOLDER_URL',
  'FILE_COUNT',
  'LAST_REFRESHED_AT',
];

const COL = {
  FOLDER_ID: 0,
  EVENT_ID: 1,
  SCOPE: 2,
  CLUB_NAME: 3,
  TAG: 4,
  FOLDER_NAME: 5,
  FOLDER_INDEX: 6,
  FOLDER_URL: 7,
  FILE_COUNT: 8,
  LAST_REFRESHED_AT: 9,
} as const;
const FIRST_COL = 'A';
const LAST_COL = 'J';
const WIDTH = 10;

const tab = (): string => env.SPECIAL_FOLDERS_SHEET_NAME;

function isScope(s: string): s is SpecialFolderScope {
  return s === 'photos' || s === 'videos' || s === 'albums';
}

function toRecord(cells: string[]): SpecialFolderRecord | null {
  const folderId = cell(cells, COL.FOLDER_ID);
  const scope = cell(cells, COL.SCOPE);
  if (!folderId || !isScope(scope)) return null;
  const idx = Number(cell(cells, COL.FOLDER_INDEX));
  const count = Number(cell(cells, COL.FILE_COUNT));
  return {
    folderId,
    eventId: cell(cells, COL.EVENT_ID),
    scope,
    clubName: cell(cells, COL.CLUB_NAME),
    tag: cell(cells, COL.TAG),
    folderName: cell(cells, COL.FOLDER_NAME),
    folderIndex: Number.isFinite(idx) ? idx : 0,
    folderUrl: cell(cells, COL.FOLDER_URL),
    fileCount: Number.isFinite(count) ? count : 0,
    lastRefreshedAt: cell(cells, COL.LAST_REFRESHED_AT),
  };
}

function toCells(r: SpecialFolderRecord): unknown[] {
  const cells = new Array<unknown>(WIDTH).fill('');
  cells[COL.FOLDER_ID] = r.folderId;
  cells[COL.EVENT_ID] = r.eventId;
  cells[COL.SCOPE] = r.scope;
  cells[COL.CLUB_NAME] = r.clubName;
  cells[COL.TAG] = r.tag;
  cells[COL.FOLDER_NAME] = r.folderName;
  cells[COL.FOLDER_INDEX] = r.folderIndex;
  cells[COL.FOLDER_URL] = r.folderUrl;
  cells[COL.FILE_COUNT] = r.fileCount;
  cells[COL.LAST_REFRESHED_AT] = r.lastRefreshedAt;
  return cells;
}

/**
 * Ensure the Special_Folders tab exists and carries its header row. Idempotent;
 * call once before the first write of a rebuild. Creating the tab also writes
 * the header so readTab's header-detection works on subsequent reads.
 */
export async function ensureSpecialFoldersTab(spreadsheetId: string, opts?: { token?: string }): Promise<void> {
  const created = await ensureSheetTab(spreadsheetId, tab(), opts);
  if (created) {
    await updateSheetValues(spreadsheetId, `${tab()}!${FIRST_COL}1:${LAST_COL}1`, [[...SPECIAL_FOLDERS_HEADERS]], opts);
  }
}

/**
 * Read the raw addressable rows of the Special_Folders tab. The rebuild engine
 * loads this ONCE and passes it to each per-bucket upsert (preloadedRows) so a
 * multi-bucket rebuild does one Sheets read instead of one per row.
 */
export async function loadSpecialFolderRows(spreadsheetId: string, opts?: { token?: string }): Promise<SheetRow[]> {
  return readTab(spreadsheetId, tab(), LAST_COL, COL.FOLDER_ID, 'folderid', opts);
}

/** Read every Special_Folders record (header skipped, malformed rows dropped). */
export async function listAllSpecialFolders(
  spreadsheetId: string,
  opts?: { token?: string },
): Promise<SpecialFolderRecord[]> {
  const rows = await readTab(spreadsheetId, tab(), LAST_COL, COL.FOLDER_ID, 'folderid', opts);
  const out: SpecialFolderRecord[] = [];
  for (const r of rows) {
    const rec = toRecord(r.cells);
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * Most recent lastRefreshedAt across all rows (ISO string), or null when empty.
 * Used by the periodic "lazy" rebuild check: if every row is >= the latest
 * upload, the public index is already current and the rebuild can be skipped.
 */
export async function getLatestRefreshedAt(
  spreadsheetId: string,
  opts?: { token?: string },
): Promise<string | null> {
  const records = await listAllSpecialFolders(spreadsheetId, opts);
  let latest: string | null = null;
  for (const r of records) {
    if (r.lastRefreshedAt && (latest === null || r.lastRefreshedAt > latest)) latest = r.lastRefreshedAt;
  }
  return latest;
}

/** Best-effort Firestore cache mirror (specialFolders/{folderId}). Never throws. */
async function cacheUpsert(record: SpecialFolderRecord): Promise<void> {
  try {
    await firestore()
      .collection('specialFolders')
      .doc(record.folderId)
      .set({ ...record, updatedAt: new Date().toISOString() }, { merge: true });
  } catch (err) {
    logger.warn({ err, folderId: record.folderId }, 'specialFolders cache upsert failed (non-fatal)');
  }
}

/**
 * Upsert one row keyed by folderId — update in place when present, else append.
 * Serialised per-tab. Mirrors gas-app upsertSpecialFolderRow. Best-effort
 * Firestore cache write-through.
 */
export async function upsertSpecialFolderRow(
  spreadsheetId: string,
  record: SpecialFolderRecord,
  opts?: { token?: string; preloadedRows?: SheetRow[] },
): Promise<void> {
  await withTabLock(tab(), async () => {
    const rows = opts?.preloadedRows ?? (await readTab(spreadsheetId, tab(), LAST_COL, COL.FOLDER_ID, 'folderid', opts));
    const hit = rows.find((r) => cell(r.cells, COL.FOLDER_ID) === record.folderId);
    if (hit) {
      await updateSheetValues(spreadsheetId, rowRange(tab(), FIRST_COL, LAST_COL, hit.rowNumber), [toCells(record)], opts);
    } else {
      await appendSheetValues(spreadsheetId, `${tab()}!${FIRST_COL}1`, [toCells(record)], opts);
    }
  });
  await cacheUpsert(record);
}

/** Best-effort removal of a cache mirror doc (after its Drive folder is trashed). */
async function cacheDelete(folderId: string): Promise<void> {
  try {
    await firestore().collection('specialFolders').doc(folderId).delete();
  } catch (err) {
    logger.warn({ err, folderId }, 'specialFolders cache delete failed (non-fatal)');
  }
}

/**
 * Remove every Special_Folders row whose folderId is in `folderIds` (e.g. after
 * trashing duplicate managed folders). Rewrites the data range in one pass under
 * the tab lock — the same clear-then-rewrite the public index writer uses — so
 * the surviving rows keep their order. Returns how many rows were removed.
 */
export async function deleteSpecialFolderRowsByFolderId(
  spreadsheetId: string,
  folderIds: ReadonlySet<string>,
  opts?: { token?: string },
): Promise<number> {
  if (folderIds.size === 0) return 0;
  const removed = await withTabLock(tab(), async () => {
    const rows = await readTab(spreadsheetId, tab(), LAST_COL, COL.FOLDER_ID, 'folderid', opts);
    const survivors = rows.filter((r) => !folderIds.has(cell(r.cells, COL.FOLDER_ID)));
    const removedCount = rows.length - survivors.length;
    if (removedCount === 0) return 0;
    // Clear all data rows (keep the header), then re-append the survivors.
    await clearSheetValues(spreadsheetId, `${tab()}!${FIRST_COL}2:${LAST_COL}`, opts);
    if (survivors.length > 0) {
      const cells = survivors.map((r) => {
        const padded = new Array<unknown>(WIDTH).fill('');
        for (let i = 0; i < WIDTH; i++) padded[i] = r.cells[i] ?? '';
        return padded;
      });
      await appendSheetValues(spreadsheetId, `${tab()}!${FIRST_COL}1`, cells, opts);
    }
    return removedCount;
  });
  if (removed > 0) await Promise.all([...folderIds].map((id) => cacheDelete(id)));
  return removed;
}
