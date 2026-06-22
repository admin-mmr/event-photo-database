/**
 * clubStore.ts — control-plane Clubs, Google Sheet as SSOT (dev plan D2/G1.1).
 * Writes go to the `Clubs` tab; a best-effort Firestore mirror (`clubs`) backs
 * the admin UI (G2). Column layout mirrors gas-app COLUMNS.CLUBS.
 *
 * `normalizedName` is the immutable club identifier (Drive club folders depend
 * on it): alphanumeric segments joined by single underscores, no leading/
 * trailing/consecutive underscores. `displayName` is human-facing and editable.
 */

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { UserStatus, type UserStatus as Status } from '../lib/roles.js';
import { appendSheetValues, updateSheetValues } from './sheetsService.js';
import { cell, readTab, rowRange, withTabLock } from './sheetTable.js';

const TAB = 'Clubs';
const LAST_COL = 'E';
const COL = {
  DISPLAY_NAME: 0,
  NORMALIZED_NAME: 1,
  STATUS: 2,
  ADDED_DATE: 3,
  ADDED_BY: 4,
} as const;
const WIDTH = 5; // A..E

/** Single underscore-joined alphanumeric segments; no edge/consecutive '_'. */
export const NORMALIZED_NAME_RE = /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$/;

export interface Club {
  displayName: string;
  normalizedName: string;
  status: Status;
  addedAt: string;
  addedBy: string;
}

export class ClubStoreError extends Error {
  constructor(public code: 'invalid' | 'duplicate' | 'not_found', message: string) {
    super(message);
    this.name = 'ClubStoreError';
  }
}

function rowToClub(cells: string[]): Club {
  const status = cell(cells, COL.STATUS);
  return {
    displayName: cell(cells, COL.DISPLAY_NAME),
    normalizedName: cell(cells, COL.NORMALIZED_NAME),
    status: (status === UserStatus.INACTIVE ? UserStatus.INACTIVE : UserStatus.ACTIVE) as Status,
    addedAt: cell(cells, COL.ADDED_DATE),
    addedBy: cell(cells, COL.ADDED_BY),
  };
}

async function mirror(club: Club): Promise<void> {
  try {
    await firestore()
      .collection('clubs')
      .doc(club.normalizedName)
      .set({ ...club, source: 'sheet-write', updatedAt: new Date().toISOString() }, { merge: true });
  } catch (err) {
    logger.warn({ err, club: club.normalizedName }, 'club cache mirror failed (non-fatal)');
  }
}

export async function listClubs(spreadsheetId: string, filter?: { status?: Status }): Promise<Club[]> {
  const rows = await readTab(spreadsheetId, TAB, LAST_COL, COL.NORMALIZED_NAME, 'normalizedname');
  let clubs = rows.map((r) => rowToClub(r.cells));
  if (filter?.status !== undefined) clubs = clubs.filter((c) => c.status === filter.status);
  return clubs;
}

export async function getClub(spreadsheetId: string, normalizedName: string): Promise<Club | null> {
  const rows = await readTab(spreadsheetId, TAB, LAST_COL, COL.NORMALIZED_NAME, 'normalizedname');
  const hit = rows.find((r) => cell(r.cells, COL.NORMALIZED_NAME) === normalizedName);
  return hit ? rowToClub(hit.cells) : null;
}

export async function createClub(
  spreadsheetId: string,
  input: { displayName: string; normalizedName: string },
  actorEmail: string,
): Promise<Club> {
  const displayName = input.displayName.trim();
  const normalizedName = input.normalizedName.trim();
  if (!displayName) throw new ClubStoreError('invalid', 'displayName is required');
  if (!NORMALIZED_NAME_RE.test(normalizedName)) {
    throw new ClubStoreError('invalid', `Invalid normalizedName: "${normalizedName}"`);
  }

  return withTabLock(TAB, async () => {
    if (await getClub(spreadsheetId, normalizedName)) {
      throw new ClubStoreError('duplicate', `Club already exists: ${normalizedName}`);
    }
    const now = new Date().toISOString();
    const club: Club = { displayName, normalizedName, status: UserStatus.ACTIVE, addedAt: now, addedBy: actorEmail };
    const row = new Array(WIDTH).fill('');
    row[COL.DISPLAY_NAME] = club.displayName;
    row[COL.NORMALIZED_NAME] = club.normalizedName;
    row[COL.STATUS] = club.status;
    row[COL.ADDED_DATE] = club.addedAt;
    row[COL.ADDED_BY] = club.addedBy;
    await appendSheetValues(spreadsheetId, `${TAB}!A1`, [row]);
    await mirror(club);
    return club;
  });
}

/** Update the editable field (displayName); normalizedName is immutable. */
export async function updateClub(
  spreadsheetId: string,
  normalizedName: string,
  patch: { displayName: string },
): Promise<Club> {
  const displayName = patch.displayName.trim();
  if (!displayName) throw new ClubStoreError('invalid', 'displayName is required');
  return withTabLock(TAB, async () => {
    const rows = await readTab(spreadsheetId, TAB, LAST_COL, COL.NORMALIZED_NAME, 'normalizedname');
    const hit = rows.find((r) => cell(r.cells, COL.NORMALIZED_NAME) === normalizedName);
    if (!hit) throw new ClubStoreError('not_found', `Club not found: ${normalizedName}`);
    const cells = [...hit.cells];
    while (cells.length < WIDTH) cells.push('');
    cells[COL.DISPLAY_NAME] = displayName;
    await updateSheetValues(spreadsheetId, rowRange(TAB, 'A', LAST_COL, hit.rowNumber), [cells.slice(0, WIDTH)]);
    const club = rowToClub(cells);
    await mirror(club);
    return club;
  });
}

export async function setClubStatus(
  spreadsheetId: string,
  normalizedName: string,
  status: Status,
): Promise<Club> {
  return withTabLock(TAB, async () => {
    const rows = await readTab(spreadsheetId, TAB, LAST_COL, COL.NORMALIZED_NAME, 'normalizedname');
    const hit = rows.find((r) => cell(r.cells, COL.NORMALIZED_NAME) === normalizedName);
    if (!hit) throw new ClubStoreError('not_found', `Club not found: ${normalizedName}`);
    const cells = [...hit.cells];
    while (cells.length < WIDTH) cells.push('');
    cells[COL.STATUS] = status;
    await updateSheetValues(spreadsheetId, rowRange(TAB, 'A', LAST_COL, hit.rowNumber), [cells.slice(0, WIDTH)]);
    const club = rowToClub(cells);
    await mirror(club);
    return club;
  });
}
