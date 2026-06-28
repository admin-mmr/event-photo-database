/**
 * publicFolderIndexService.ts — materialise the public folder index into a
 * SEPARATE, world-readable Google Sheet (env.PUBLIC_FOLDER_INDEX_SHEET_ID).
 * Cloud-webapp port of the gas-app publicSpreadsheetService.
 *
 * The master Sheet holds private data and must NOT be shared; this writes a
 * redacted, read-only mirror of just the public-browse folder list to a
 * different file the admin shares "Anyone with the link can view". Three kinds
 * of tab, column order preserved from gas-app so existing public bookmarks keep
 * working:
 *   - "Photo Folders" — one row per Photos_NNN bucket (event-level).
 *   - "Video Folders" — one row per (event, club, tag) Videos folder.
 *   - one tab PER CLUB — one row per (event, tag) Album folder for that club.
 *
 * Each tab is rewritten wholesale (folder churn is small). Hot-path callers use
 * tryRebuildPublicFolderIndex so a Sheets hiccup never fails an upload.
 */

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { firestore } from '../lib/firestore.js';
import {
  getSheetsToken,
  ensureSheetTab,
  clearSheetValues,
  updateSheetValues,
} from './sheetsService.js';
import { listClubs, type Club } from './clubStore.js';
import { UserStatus } from '../lib/roles.js';
import { listAllSpecialFolders, type SpecialFolderRecord } from './specialFoldersStore.js';

const PHOTO_FOLDERS_TAB = 'Photo Folders';
const VIDEO_FOLDERS_TAB = 'Video Folders';

const PHOTO_FOLDERS_HEADERS = ['Event Date', 'Event Name', 'Folder Name', 'Folder Index', 'File Count', 'Folder Link', 'Last Refreshed'];
const VIDEO_FOLDERS_HEADERS = ['Event Date', 'Event Name', 'Club', 'Tag', 'Folder Name', 'File Count', 'Folder Link', 'Last Refreshed'];
export const CLUB_ALBUM_HEADERS = ['Event Date', 'Event Name', 'Tag', 'Folder Name', 'File Count', 'Folder Link', 'Last Refreshed'];

/** Minimal event facts needed to render the tabs. */
export interface EventInfo {
  eventId: string;
  eventDate: string;
  eventName: string;
}

// ─── Pure row builders (exported for unit tests) ─────────────────────────────

export function buildPhotoFolderRows(records: ReadonlyArray<SpecialFolderRecord>, events: ReadonlyArray<EventInfo>): unknown[][] {
  const byId = new Map(events.map((e) => [e.eventId, e]));
  const enriched = records
    .filter((r) => r.scope === 'photos')
    .map((r) => ({ ev: byId.get(r.eventId), r }))
    .filter((x): x is { ev: EventInfo; r: SpecialFolderRecord } => Boolean(x.ev));

  enriched.sort((a, b) => {
    if (a.ev.eventDate !== b.ev.eventDate) return b.ev.eventDate.localeCompare(a.ev.eventDate);
    if (a.ev.eventId !== b.ev.eventId) return a.ev.eventId.localeCompare(b.ev.eventId);
    return a.r.folderIndex - b.r.folderIndex;
  });

  return enriched.map(({ ev, r }) => [ev.eventDate, ev.eventName, r.folderName, r.folderIndex, r.fileCount, r.folderUrl, r.lastRefreshedAt]);
}

export function buildVideoFolderRows(
  records: ReadonlyArray<SpecialFolderRecord>,
  events: ReadonlyArray<EventInfo>,
  clubs: ReadonlyArray<Club>,
): unknown[][] {
  const byId = new Map(events.map((e) => [e.eventId, e]));
  const displayByNorm = new Map(clubs.map((c) => [c.normalizedName, c.displayName]));
  const enriched = records
    .filter((r) => r.scope === 'videos')
    .map((r) => ({ ev: byId.get(r.eventId), r, clubLabel: displayByNorm.get(r.clubName) ?? r.clubName }))
    .filter((x): x is { ev: EventInfo; r: SpecialFolderRecord; clubLabel: string } => Boolean(x.ev));

  enriched.sort((a, b) => {
    if (a.ev.eventDate !== b.ev.eventDate) return b.ev.eventDate.localeCompare(a.ev.eventDate);
    if (a.ev.eventId !== b.ev.eventId) return a.ev.eventId.localeCompare(b.ev.eventId);
    const c = a.clubLabel.localeCompare(b.clubLabel);
    return c !== 0 ? c : a.r.tag.localeCompare(b.r.tag);
  });

  return enriched.map(({ ev, r, clubLabel }) => [ev.eventDate, ev.eventName, clubLabel, r.tag, r.folderName, r.fileCount, r.folderUrl, r.lastRefreshedAt]);
}

export interface ClubAlbumTab {
  tabName: string;
  rows: unknown[][];
}

/** Sheets forbids []:*?/\ in tab names; cap 100; non-empty. */
export function sanitizeTabName(name: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 100);
  return cleaned || 'Club';
}

export function buildClubAlbumTabs(
  records: ReadonlyArray<SpecialFolderRecord>,
  events: ReadonlyArray<EventInfo>,
  clubs: ReadonlyArray<Club>,
): ClubAlbumTab[] {
  const byId = new Map(events.map((e) => [e.eventId, e]));
  const displayByNorm = new Map(clubs.map((c) => [c.normalizedName, c.displayName]));

  const byClub = new Map<string, Array<{ ev: EventInfo; r: SpecialFolderRecord }>>();
  for (const r of records) {
    if (r.scope !== 'albums') continue;
    const ev = byId.get(r.eventId);
    if (!ev) continue;
    const list = byClub.get(r.clubName) ?? [];
    list.push({ ev, r });
    byClub.set(r.clubName, list);
  }

  const tabs: ClubAlbumTab[] = [];
  const used = new Set<string>();
  const clubKeys = Array.from(byClub.keys()).sort((a, b) =>
    (displayByNorm.get(a) ?? a).localeCompare(displayByNorm.get(b) ?? b),
  );

  for (const norm of clubKeys) {
    const list = byClub.get(norm)!;
    list.sort((a, b) => {
      if (a.ev.eventDate !== b.ev.eventDate) return b.ev.eventDate.localeCompare(a.ev.eventDate);
      if (a.ev.eventId !== b.ev.eventId) return a.ev.eventId.localeCompare(b.ev.eventId);
      return a.r.tag.localeCompare(b.r.tag);
    });
    let tabName = sanitizeTabName(displayByNorm.get(norm) ?? norm);
    if (used.has(tabName)) tabName = sanitizeTabName(`${tabName} ${norm}`);
    used.add(tabName);
    tabs.push({ tabName, rows: list.map(({ ev, r }) => [ev.eventDate, ev.eventName, r.tag, r.folderName, r.fileCount, r.folderUrl, r.lastRefreshedAt]) });
  }
  return tabs;
}

// ─── Writer ───────────────────────────────────────────────────────────────────

async function loadEventInfos(): Promise<EventInfo[]> {
  const snap = await firestore().collection('events').get();
  return snap.docs.map((d) => {
    const data = d.data();
    return { eventId: d.id, eventDate: String(data?.date ?? ''), eventName: String(data?.name ?? data?.folderName ?? d.id) };
  });
}

async function writeTab(
  spreadsheetId: string,
  tabName: string,
  headers: ReadonlyArray<string>,
  rows: unknown[][],
  token: string,
  refreshedAt: string,
): Promise<void> {
  await ensureSheetTab(spreadsheetId, tabName, { token });
  await clearSheetValues(spreadsheetId, `${tabName}!A:Z`, { token });
  // Header row + a "Last refreshed" marker one column past the headers (mirrors
  // gas-app writeTab), then the data rows.
  const headerRow = [...headers, `Last refreshed: ${refreshedAt}`];
  await updateSheetValues(spreadsheetId, `${tabName}!A1`, [headerRow, ...rows], { token });
}

/**
 * Rebuild the public folder index. Reads Special_Folders (master Sheet) + events
 * (Firestore) + clubs (master Sheet) and rewrites the Photo/Video/per-club tabs.
 * No-op (returns 0) when PUBLIC_FOLDER_INDEX_SHEET_ID is unset. Throws on Sheets
 * errors so manual admin runs see the failure; hot paths use the try-wrapper.
 */
export async function rebuildPublicFolderIndex(): Promise<number> {
  const fileId = env.PUBLIC_FOLDER_INDEX_SHEET_ID;
  if (!fileId) {
    logger.info('PUBLIC_FOLDER_INDEX_SHEET_ID unset — public folder index disabled');
    return 0;
  }
  const masterSheet = env.MASTER_SPREADSHEET_ID;
  if (!masterSheet) return 0;

  const token = await getSheetsToken();
  const [records, events, clubs] = await Promise.all([
    listAllSpecialFolders(masterSheet),
    loadEventInfos(),
    // Active clubs only, mirroring gas-app listActiveClubs — the display-name map
    // for the Video/Album tabs; rows for an inactive club fall back to its raw
    // normalizedName, same as the original.
    listClubs(masterSheet, { status: UserStatus.ACTIVE }),
  ]);

  const photoRows = buildPhotoFolderRows(records, events);
  const videoRows = buildVideoFolderRows(records, events, clubs);
  const clubTabs = buildClubAlbumTabs(records, events, clubs);

  const refreshedAt = new Date().toISOString();
  await writeTab(fileId, PHOTO_FOLDERS_TAB, PHOTO_FOLDERS_HEADERS, photoRows, token, refreshedAt);
  await writeTab(fileId, VIDEO_FOLDERS_TAB, VIDEO_FOLDERS_HEADERS, videoRows, token, refreshedAt);
  let clubRows = 0;
  for (const tab of clubTabs) {
    await writeTab(fileId, tab.tabName, CLUB_ALBUM_HEADERS, tab.rows, token, refreshedAt);
    clubRows += tab.rows.length;
  }

  const total = photoRows.length + videoRows.length + clubRows;
  logger.info({ photoRows: photoRows.length, videoRows: videoRows.length, clubTabs: clubTabs.length, clubRows }, 'public folder index rewritten');
  return total;
}

/** Best-effort wrapper for hot paths. Swallows + logs. */
export async function tryRebuildPublicFolderIndex(): Promise<void> {
  try {
    await rebuildPublicFolderIndex();
  } catch (err) {
    logger.warn({ err }, 'public folder index rebuild failed (non-fatal)');
  }
}
