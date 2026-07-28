/**
 * eventStore.ts — control-plane Events writes, Google Sheet as SSOT (dev plan
 * G3.1). Appends to the `Events` tab; the Drive folder + Firestore cache upsert
 * are orchestrated by the adminEvents route (folder creation needs driveService;
 * the reconciler also keeps the Firestore `events` cache in sync). Column layout
 * mirrors gas-app COLUMNS.EVENTS.
 *
 * `deleteEventRow` is the one destructive write here — see its doc comment for
 * why an event deletion has to start with the Sheet.
 */

import { randomUUID } from 'node:crypto';

import { appendSheetValues, clearSheetValues, getSheetValues, updateSheetValues } from './sheetsService.js';
import { cell, isHeaderRow, readTab, withTabLock } from './sheetTable.js';

const TAB = 'Events';
const LAST_COL = 'G';
const COL = {
  EVENT_ID: 0,
  EVENT_NAME: 1,
  EVENT_DATE: 2,
  FOLDER_NAME: 3,
  DRIVE_FOLDER_ID: 4,
  CREATED_BY: 5,
  CREATED_AT: 6,
} as const;
const WIDTH = 7; // A..G

export interface EventRow {
  eventId: string;
  name: string;
  date: string;
  folderName: string;
  driveFolderId: string;
  createdBy: string;
  createdAt: string;
}

export class EventStoreError extends Error {
  constructor(
    public code: 'invalid' | 'duplicate',
    message: string,
  ) {
    super(message);
    this.name = 'EventStoreError';
  }
}

/**
 * Layer-1 folder name `YYYY-MM-DD_Event_Name` (gas-app eventService): the date,
 * then the event name with runs of non-alphanumerics collapsed to single
 * underscores and trimmed. Unicode letters/digits are preserved.
 */
export function folderNameFor(date: string, name: string): string {
  const normalized = name
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return `${date}_${normalized}`;
}

function rowToEvent(cells: string[]): EventRow {
  return {
    eventId: cell(cells, COL.EVENT_ID),
    name: cell(cells, COL.EVENT_NAME),
    date: cell(cells, COL.EVENT_DATE),
    folderName: cell(cells, COL.FOLDER_NAME),
    driveFolderId: cell(cells, COL.DRIVE_FOLDER_ID),
    createdBy: cell(cells, COL.CREATED_BY),
    createdAt: cell(cells, COL.CREATED_AT),
  };
}

/** True if an event row already uses this folderName (dup guard). */
export async function findByFolderName(spreadsheetId: string, folderName: string): Promise<EventRow | null> {
  const rows = await readTab(spreadsheetId, TAB, LAST_COL, COL.EVENT_ID, 'eventid');
  const hit = rows.find((r) => cell(r.cells, COL.FOLDER_NAME) === folderName);
  return hit ? rowToEvent(hit.cells) : null;
}

/** The event's row in the Sheet (the SSOT record), or null. */
export async function findById(spreadsheetId: string, eventId: string): Promise<EventRow | null> {
  const rows = await readTab(spreadsheetId, TAB, LAST_COL, COL.EVENT_ID, 'eventid');
  const hit = rows.find((r) => cell(r.cells, COL.EVENT_ID) === eventId);
  return hit ? rowToEvent(hit.cells) : null;
}

/**
 * Remove an event's row from the Events tab. Returns how many rows went (0 when
 * the event wasn't there — deleting twice is a no-op, not an error).
 *
 * WHY THE SHEET GOES FIRST when deleting an event: the Sheet is SSOT and
 * `reconcileService` is additive — it upserts every Sheet row into Firestore and
 * only *reports* Firestore docs with no Sheet row (`orphans`), never deletes
 * them. Drop the Firestore doc while the row survives and the next
 * `findme-drive-sync` tick recreates the event.
 *
 * Deletion is a clear-then-rewrite of the data range under the tab lock (the
 * same shape `deleteSpecialFolderRowsByFolderId` uses), so surviving rows keep
 * their order and row numbers stay contiguous. The data range starts below the
 * header when there is one — anchoring it at row 1 on a header-less tab would
 * leave the first row uncleared and then duplicate it.
 */
export async function deleteEventRow(spreadsheetId: string, eventId: string): Promise<number> {
  if (!eventId.trim()) throw new EventStoreError('invalid', 'eventId is required');
  return withTabLock(TAB, async () => {
    const values = await getSheetValues(spreadsheetId, `${TAB}!A1:${LAST_COL}`);
    const headerRows = isHeaderRow(values[0], COL.EVENT_ID, 'eventid') ? 1 : 0;
    const dataRows = values.slice(headerRows);
    const survivors = dataRows.filter((cells) => cell(cells, COL.EVENT_ID) !== eventId);
    const removed = dataRows.length - survivors.length;
    if (removed === 0) return 0;

    const firstDataRow = headerRows + 1;
    await clearSheetValues(spreadsheetId, `${TAB}!A${firstDataRow}:${LAST_COL}`);
    if (survivors.length > 0) {
      const padded = survivors.map((cells) => {
        const row = new Array<unknown>(WIDTH).fill('');
        for (let i = 0; i < WIDTH; i++) row[i] = cells[i] ?? '';
        return row;
      });
      const lastRow = firstDataRow + survivors.length - 1;
      await updateSheetValues(spreadsheetId, `${TAB}!A${firstDataRow}:${LAST_COL}${lastRow}`, padded);
    }
    return removed;
  });
}

/**
 * Append a new event row. `driveFolderId` is supplied by the caller after it has
 * provisioned the Drive folder. Throws on a duplicate folderName. The
 * (event,date,name)→folderName mapping must already be computed by the caller.
 */
export async function createEvent(
  spreadsheetId: string,
  input: { name: string; date: string; folderName: string; driveFolderId: string },
  actorEmail: string,
): Promise<EventRow> {
  if (!input.name.trim() || !input.date.trim()) {
    throw new EventStoreError('invalid', 'name and date are required');
  }
  return withTabLock(TAB, async () => {
    if (await findByFolderName(spreadsheetId, input.folderName)) {
      throw new EventStoreError('duplicate', `An event already exists for "${input.folderName}"`);
    }
    const row: EventRow = {
      eventId: randomUUID(),
      name: input.name.trim(),
      date: input.date.trim(),
      folderName: input.folderName,
      driveFolderId: input.driveFolderId,
      createdBy: actorEmail.trim().toLowerCase(),
      createdAt: new Date().toISOString(),
    };
    const cells = new Array(WIDTH).fill('');
    cells[COL.EVENT_ID] = row.eventId;
    cells[COL.EVENT_NAME] = row.name;
    cells[COL.EVENT_DATE] = row.date;
    cells[COL.FOLDER_NAME] = row.folderName;
    cells[COL.DRIVE_FOLDER_ID] = row.driveFolderId;
    cells[COL.CREATED_BY] = row.createdBy;
    cells[COL.CREATED_AT] = row.createdAt;
    await appendSheetValues(spreadsheetId, `${TAB}!A1`, [cells]);
    return row;
  });
}
