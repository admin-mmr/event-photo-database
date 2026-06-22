/**
 * eventStore.ts — control-plane Events writes, Google Sheet as SSOT (dev plan
 * G3.1). Appends to the `Events` tab; the Drive folder + Firestore cache upsert
 * are orchestrated by the adminEvents route (folder creation needs driveService;
 * the reconciler also keeps the Firestore `events` cache in sync). Column layout
 * mirrors gas-app COLUMNS.EVENTS.
 */

import { randomUUID } from 'node:crypto';

import { appendSheetValues } from './sheetsService.js';
import { cell, readTab, withTabLock } from './sheetTable.js';

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

/** True if an event row already uses this folderName (dup guard). */
export async function findByFolderName(spreadsheetId: string, folderName: string): Promise<EventRow | null> {
  const rows = await readTab(spreadsheetId, TAB, LAST_COL, COL.EVENT_ID, 'eventid');
  const hit = rows.find((r) => cell(r.cells, COL.FOLDER_NAME) === folderName);
  if (!hit) return null;
  return {
    eventId: cell(hit.cells, COL.EVENT_ID),
    name: cell(hit.cells, COL.EVENT_NAME),
    date: cell(hit.cells, COL.EVENT_DATE),
    folderName: cell(hit.cells, COL.FOLDER_NAME),
    driveFolderId: cell(hit.cells, COL.DRIVE_FOLDER_ID),
    createdBy: cell(hit.cells, COL.CREATED_BY),
    createdAt: cell(hit.cells, COL.CREATED_AT),
  };
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
