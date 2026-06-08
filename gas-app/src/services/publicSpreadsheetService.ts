/**
 * publicSpreadsheetService.ts — materializes the public folder index into a
 * SEPARATE Google Sheet that the admin shares "Anyone with the link can view"
 * (or publishes to the web).
 *
 * Why a separate spreadsheet?
 *   The main SPREADSHEET_ID holds all of the app's private data — Users,
 *   Upload_Log, Audit_Log, etc. — and must NOT be shared publicly. This
 *   service writes a redacted, read-only mirror of just the public-browse
 *   folder list to a different file whose ID is configured via the
 *   PUBLIC_ALBUM_INDEX_SHEET_ID Script Property (legacy name retained for
 *   backward compatibility; semantically this is the "public folder index
 *   sheet id"). Visitors hit that file directly (no Google login required
 *   if the file is shared "Anyone with the link") and see clickable tables
 *   of every event's Drive folders.
 *
 * What this service publishes
 *   Drive folders are shared programmatically with "Anyone with link → Viewer"
 *   (see drivePermissionsService.ts), so they are the public-browse surface.
 *   Each event ships with one or more "Photos_NNN" folders holding Drive
 *   shortcut files for every uploaded photo, and one "Videos" folder per
 *   (event, club, tag) for videos. Both are materialised by
 *   specialFoldersService.ts.
 *
 * Tabs written
 *   1. "Photo Folders" — one row per Photos_NNN bucket (event-level).
 *   2. "Video Folders" — one row per (event, club, tag) Videos folder.
 *   3. One tab PER CLUB (named with the club's display name, e.g. "岚山") —
 *      one row per (event, tag) Album folder belonging to that club. Album
 *      folders hold shortcuts to every uploaded file (photos AND videos) for
 *      the scope; see specialFoldersService.ts. Tabs are only created for
 *      clubs that have at least one Album folder.
 *
 * Update strategy
 *   Each tab is rewritten on every call. Folder churn is small (typically a
 *   few rows per event, a few hundred events at most), so a full rewrite is
 *   simpler and more reliable than a diff-and-patch update. Callers in hot
 *   paths should use tryRebuildPublicFoldersIndex() so a failure here never
 *   fails the upstream operation (batch sync, etc.).
 *
 * Configuration
 *   Script Property: PUBLIC_ALBUM_INDEX_SHEET_ID — Google Sheets file ID of
 *   the public-facing spreadsheet. If this property is unset, all functions
 *   in this module become no-ops (logs once and returns) so the feature can
 *   be left disabled without breaking the build or the upload pipeline.
 *
 *   The property name is kept for backward compatibility with deployments
 *   that set it under the legacy name; treat it as the "public folder index
 *   sheet id" property regardless of name.
 *
 * Setup checklist (one-time, performed by admin)
 *   1. Create a new, empty Google Sheets file in Drive.
 *   2. File → Share → "Anyone with the link" → Viewer.  (Optionally also
 *      File → Share → Publish to web for a cleaner URL.)
 *   3. Copy the file ID from the URL  /d/<FILE_ID>/edit  and paste it into
 *      Apps Script → Project Settings → Script Properties as
 *      PUBLIC_ALBUM_INDEX_SHEET_ID.
 *   4. From the GAS editor, run rebuildPublicFoldersIndex() once to populate
 *      the two tabs. Subsequent updates happen automatically whenever a
 *      batch finishes syncing.
 */

import { EventRecord, SpecialFolderRecord, ClubRecord } from '../types/models';
import { nowIsoTimestamp } from '../utils/dateFormatter';
import { listAllSpecialFolders } from './specialFoldersService';
import { listAll as listAllEvents } from './eventService';
import { listActive as listActiveClubs } from './clubService';

/* global PropertiesService, SpreadsheetApp, Logger */

/** Tab name for the per-event Photos_NNN folder index. */
const PUBLIC_PHOTO_FOLDERS_TAB = 'Photo Folders';

/** Tab name for the per-(event, club, tag) Videos folder index. */
const PUBLIC_VIDEO_FOLDERS_TAB = 'Video Folders';

/** Script Property key holding the public spreadsheet's file ID. */
const PROP_KEY = 'PUBLIC_ALBUM_INDEX_SHEET_ID';

/**
 * Header row written at the top of the Photo Folders tab.
 *
 * Column order is part of the public contract — anyone who has bookmarked
 * the published-to-web view will see this layout. Add new columns at the
 * end rather than reordering.
 *
 * One row per Photos_NNN bucket. Club + Tag are intentionally absent: photo
 * folders are event-level (they consolidate every photo across all clubs
 * and tags for the event).
 */
const PHOTO_FOLDERS_HEADERS: ReadonlyArray<string> = [
  'Event Date',     // YYYY-MM-DD
  'Event Name',
  'Folder Name',    // e.g. "Photos_001"
  'Folder Index',   // 1..N (lowest-index bucket first per event)
  'File Count',     // shortcut count at last refresh
  'Folder Link',    // https://drive.google.com/drive/folders/<id> — public-browse URL
  'Last Refreshed', // ISO timestamp of the most recent rebuild
];

/**
 * Header row written at the top of the Video Folders tab.
 *
 * One row per (event, club, tag) Videos folder. Club + Tag are populated.
 */
const VIDEO_FOLDERS_HEADERS: ReadonlyArray<string> = [
  'Event Date',     // YYYY-MM-DD
  'Event Name',
  'Club',
  'Tag',
  'Folder Name',    // always "Videos"
  'File Count',     // shortcut count at last refresh
  'Folder Link',    // https://drive.google.com/drive/folders/<id> — public-browse URL
  'Last Refreshed', // ISO timestamp of the most recent rebuild
];

/**
 * Header row written at the top of each per-club Album tab.
 *
 * One row per (event, tag) Album folder for the club. No Club column — the
 * tab itself IS the club (its name is the club's display name).
 */
export const CLUB_ALBUM_HEADERS: ReadonlyArray<string> = [
  'Event Date',     // YYYY-MM-DD
  'Event Name',
  'Tag',
  'Folder Name',    // always "Album"
  'File Count',     // shortcut count at last refresh
  'Folder Link',    // https://drive.google.com/drive/folders/<id> — public-browse URL
  'Last Refreshed', // ISO timestamp of the most recent rebuild
];

/**
 * Reads the configured public spreadsheet ID.
 * Returns null when the Script Property is unset — callers treat this as
 * "feature disabled" and skip silently.
 */
function getPublicSheetId(): string | null {
  const id = PropertiesService.getScriptProperties().getProperty(PROP_KEY);
  return id && id.trim() ? id.trim() : null;
}

/**
 * Public-facing URL for the folder-index spreadsheet, or empty string if the
 * feature is unconfigured.
 *
 * Used by the dashboard and login pages to decide whether to render the
 * "Browse all folders" banner card. We deliberately return '' (rather than
 * throwing) so unconfigured deployments simply hide the card.
 *
 * The URL points to the standard Sheets editor surface; "Anyone with the
 * link → Viewer" sharing on the file is required for unauthenticated visitors
 * to actually see the data, and that sharing has to be set on the file in
 * Drive (we cannot toggle it from a script under the GAS-only Drive scope).
 */
export function getPublicSpreadsheetUrl(): string {
  const id = getPublicSheetId();
  if (!id) return '';
  return `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`;
}

// ─── Photo Folders tab ───────────────────────────────────────────────────────

/**
 * Comparator for Photo Folders rows: newest event first, then ascending
 * bucket index so Photos_001 reads before Photos_002.
 */
function comparePhotoFolderRows(
  a: { eventDate: string; eventId: string; record: SpecialFolderRecord },
  b: { eventDate: string; eventId: string; record: SpecialFolderRecord }
): number {
  if (a.eventDate !== b.eventDate) return b.eventDate.localeCompare(a.eventDate);
  if (a.eventId !== b.eventId) return a.eventId.localeCompare(b.eventId);
  return a.record.folderIndex - b.record.folderIndex;
}

/**
 * Flattens Special_Folders records (scope=photos only) into the 2D row layout
 * used by the Photo Folders tab. Pure function — exported for unit testing.
 *
 * Rows whose eventId is unknown to the Events sheet are dropped (the event
 * was deleted or migrated away).
 */
export function buildPhotoFolderRows(
  records: ReadonlyArray<SpecialFolderRecord>,
  events: ReadonlyArray<EventRecord>
): unknown[][] {
  const eventById = new Map<string, EventRecord>();
  for (const ev of events) eventById.set(ev.eventId, ev);

  const enriched: Array<{
    eventDate: string;
    eventId: string;
    eventName: string;
    record: SpecialFolderRecord;
  }> = [];

  for (const r of records) {
    if (r.scope !== 'photos') continue;
    const ev = eventById.get(r.eventId);
    if (!ev) continue;
    enriched.push({
      eventDate: ev.eventDate,
      eventId: ev.eventId,
      eventName: ev.eventName,
      record: r,
    });
  }

  enriched.sort(comparePhotoFolderRows);

  return enriched.map((e) => [
    e.eventDate,
    e.eventName,
    e.record.folderName,
    e.record.folderIndex,
    e.record.fileCount,
    e.record.folderUrl,
    e.record.lastRefreshedAt,
  ]);
}

// ─── Video Folders tab ───────────────────────────────────────────────────────

/**
 * Comparator for Video Folders rows: newest event first, then by club display
 * name ascending, then by tag ascending. Stable sort keeps duplicate (club,
 * tag) rows in input order (there shouldn't be any in practice).
 */
function compareVideoFolderRows(
  a: { eventDate: string; eventId: string; clubLabel: string; record: SpecialFolderRecord },
  b: { eventDate: string; eventId: string; clubLabel: string; record: SpecialFolderRecord }
): number {
  if (a.eventDate !== b.eventDate) return b.eventDate.localeCompare(a.eventDate);
  if (a.eventId !== b.eventId) return a.eventId.localeCompare(b.eventId);
  const clubCmp = a.clubLabel.localeCompare(b.clubLabel);
  if (clubCmp !== 0) return clubCmp;
  return a.record.tag.localeCompare(b.record.tag);
}

/**
 * Flattens Special_Folders records (scope=videos only) into the 2D row layout
 * used by the Video Folders tab. Pure function — exported for unit testing.
 *
 * Rows whose eventId is unknown to the Events sheet are dropped (the event
 * was deleted or migrated away). Club display names are resolved from the
 * Clubs sheet; rows referencing an unknown club fall back to the raw
 * normalizedName so admins can see and clean them up.
 */
export function buildVideoFolderRows(
  records: ReadonlyArray<SpecialFolderRecord>,
  events: ReadonlyArray<EventRecord>,
  clubs: ReadonlyArray<ClubRecord>
): unknown[][] {
  const eventById = new Map<string, EventRecord>();
  for (const ev of events) eventById.set(ev.eventId, ev);

  const clubDisplayByNorm = new Map<string, string>();
  for (const c of clubs) clubDisplayByNorm.set(c.normalizedName, c.displayName);

  const enriched: Array<{
    eventDate: string;
    eventId: string;
    eventName: string;
    clubLabel: string;
    record: SpecialFolderRecord;
  }> = [];

  for (const r of records) {
    if (r.scope !== 'videos') continue;
    const ev = eventById.get(r.eventId);
    if (!ev) continue;
    const clubLabel = clubDisplayByNorm.get(r.clubName) ?? r.clubName;
    enriched.push({
      eventDate: ev.eventDate,
      eventId: ev.eventId,
      eventName: ev.eventName,
      clubLabel,
      record: r,
    });
  }

  enriched.sort(compareVideoFolderRows);

  return enriched.map((e) => [
    e.eventDate,
    e.eventName,
    e.clubLabel,
    e.record.tag,
    e.record.folderName,
    e.record.fileCount,
    e.record.folderUrl,
    e.record.lastRefreshedAt,
  ]);
}

// ─── Per-club Album tabs ─────────────────────────────────────────────────────

/** One per-club tab: the (sanitized) tab name plus its flattened data rows. */
export interface ClubAlbumTab {
  /** Sheet tab name — the club's display name, sanitized for Sheets. */
  readonly tabName: string;
  /** Rows in CLUB_ALBUM_HEADERS column order. */
  readonly rows: unknown[][];
}

/**
 * Sanitizes a club display name into a legal Sheets tab name.
 * Sheets forbids []:*?/\ in tab names, caps length at 100 chars, and
 * disallows empty names. Pure function — exported for unit testing.
 */
export function sanitizeTabName(name: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 100);
  return cleaned || 'Club';
}

/**
 * Comparator for per-club Album rows: newest event first, then by tag
 * ascending. Same ordering philosophy as the Video Folders tab.
 */
function compareClubAlbumRows(
  a: { eventDate: string; eventId: string; record: SpecialFolderRecord },
  b: { eventDate: string; eventId: string; record: SpecialFolderRecord }
): number {
  if (a.eventDate !== b.eventDate) return b.eventDate.localeCompare(a.eventDate);
  if (a.eventId !== b.eventId) return a.eventId.localeCompare(b.eventId);
  return a.record.tag.localeCompare(b.record.tag);
}

/**
 * Groups Special_Folders records (scope=albums only) into one tab per club.
 * Pure function — exported for unit testing.
 *
 * Tab name is the club's display name resolved from the Clubs sheet; rows
 * referencing an unknown club fall back to the raw normalizedName so admins
 * can see and clean them up. Only clubs that actually have at least one
 * Album folder get a tab. Rows whose eventId is unknown to the Events sheet
 * are dropped (the event was deleted or migrated away).
 *
 * Tab name collisions (two clubs whose display names sanitize identically)
 * are disambiguated by appending the normalizedName.
 */
export function buildClubAlbumTabs(
  records: ReadonlyArray<SpecialFolderRecord>,
  events: ReadonlyArray<EventRecord>,
  clubs: ReadonlyArray<ClubRecord>
): ClubAlbumTab[] {
  const eventById = new Map<string, EventRecord>();
  for (const ev of events) eventById.set(ev.eventId, ev);

  const clubDisplayByNorm = new Map<string, string>();
  for (const c of clubs) clubDisplayByNorm.set(c.normalizedName, c.displayName);

  // Group enriched album records by normalized club name.
  const byClub = new Map<
    string,
    Array<{ eventDate: string; eventId: string; eventName: string; record: SpecialFolderRecord }>
  >();

  for (const r of records) {
    if (r.scope !== 'albums') continue;
    const ev = eventById.get(r.eventId);
    if (!ev) continue;
    let bucket = byClub.get(r.clubName);
    if (!bucket) {
      bucket = [];
      byClub.set(r.clubName, bucket);
    }
    bucket.push({
      eventDate: ev.eventDate,
      eventId: ev.eventId,
      eventName: ev.eventName,
      record: r,
    });
  }

  const tabs: ClubAlbumTab[] = [];
  const usedTabNames = new Set<string>();

  // Deterministic tab order: sort clubs by display label.
  const clubKeys = Array.from(byClub.keys()).sort((a, b) => {
    const la = clubDisplayByNorm.get(a) ?? a;
    const lb = clubDisplayByNorm.get(b) ?? b;
    return la.localeCompare(lb);
  });

  for (const normName of clubKeys) {
    const enriched = byClub.get(normName)!;
    enriched.sort(compareClubAlbumRows);

    let tabName = sanitizeTabName(clubDisplayByNorm.get(normName) ?? normName);
    if (usedTabNames.has(tabName)) {
      tabName = sanitizeTabName(`${tabName} ${normName}`);
    }
    usedTabNames.add(tabName);

    tabs.push({
      tabName,
      rows: enriched.map((e) => [
        e.eventDate,
        e.eventName,
        e.record.tag,
        e.record.folderName,
        e.record.fileCount,
        e.record.folderUrl,
        e.record.lastRefreshedAt,
      ]),
    });
  }

  return tabs;
}

// ─── Tab writer ──────────────────────────────────────────────────────────────

/**
 * Writes the given headers + data rows to the named tab of the given
 * spreadsheet, replacing whatever was there. Stamps a "Last refreshed: …"
 * marker one column past the headers.
 *
 * Used by both rebuildPublicPhotoFolders and rebuildPublicVideoFolders to
 * keep the write logic in one place.
 */
function writeTab(
  ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
  tabName: string,
  headers: ReadonlyArray<string>,
  dataRows: unknown[][]
): void {
  let sheet = ss.getSheetByName(tabName);
  if (!sheet) sheet = ss.insertSheet(tabName);

  // clearContents() leaves formatting (frozen rows, column widths) intact,
  // which keeps any layout the admin set up by hand.
  sheet.clearContents();

  sheet
    .getRange(1, 1, 1, headers.length)
    .setValues([headers as unknown[]])
    .setFontWeight('bold');
  sheet.setFrozenRows(1);

  sheet
    .getRange(1, headers.length + 1)
    .setValue(`Last refreshed: ${nowIsoTimestamp()}`)
    .setFontStyle('italic');

  if (dataRows.length > 0) {
    sheet
      .getRange(2, 1, dataRows.length, headers.length)
      .setValues(dataRows);
  }
}

/**
 * Rebuilds both the Photo Folders and Video Folders tabs from scratch.
 *
 * Steps:
 *   1. Resolve the spreadsheet by file ID; create the two tabs if missing.
 *   2. Clear existing contents of each tab.
 *   3. Write headers + the flattened rows, plus a "last refreshed" stamp.
 *
 * Returns the total number of data rows written across both tabs (0 if the
 * Script Property is unset).
 *
 * Throws on Sheets API errors so manual admin runs see the failure. Hot-path
 * callers should use tryRebuildPublicFoldersIndex().
 */
export function rebuildPublicFoldersIndex(): number {
  const fileId = getPublicSheetId();
  if (!fileId) {
    Logger.log(
      `[publicSpreadsheetService] ${PROP_KEY} not set — public folders index is disabled`
    );
    return 0;
  }

  const ss = SpreadsheetApp.openById(fileId);

  // Pull the source data once. listAllEvents uses a generous pageSize so
  // tens of thousands of events fit; for systems past that, paginate.
  const records = listAllSpecialFolders();
  const events = listAllEvents(1, 10000, 'desc').items;
  const clubs = listActiveClubs();

  const photoRows = buildPhotoFolderRows(records, events);
  const videoRows = buildVideoFolderRows(records, events, clubs);
  const clubTabs  = buildClubAlbumTabs(records, events, clubs);

  writeTab(ss, PUBLIC_PHOTO_FOLDERS_TAB, PHOTO_FOLDERS_HEADERS, photoRows);
  writeTab(ss, PUBLIC_VIDEO_FOLDERS_TAB, VIDEO_FOLDERS_HEADERS, videoRows);

  // One tab per club that has at least one Album folder. Stale tabs for
  // clubs whose albums all disappeared are left in place (never deleted) so
  // we can't accidentally destroy a tab the admin created by hand.
  let clubRowCount = 0;
  for (const tab of clubTabs) {
    writeTab(ss, tab.tabName, CLUB_ALBUM_HEADERS, tab.rows);
    clubRowCount += tab.rows.length;
  }

  // Force the writes to commit so a viewer reloading the page right after
  // upload sees the new rows.
  SpreadsheetApp.flush();

  Logger.log(
    `[publicSpreadsheetService] Rewrote ${PUBLIC_PHOTO_FOLDERS_TAB} ` +
    `(${photoRows.length} row(s)), ${PUBLIC_VIDEO_FOLDERS_TAB} ` +
    `(${videoRows.length} row(s)) and ${clubTabs.length} club album tab(s) ` +
    `(${clubRowCount} row(s)) across ${records.length} folder(s)`
  );
  return photoRows.length + videoRows.length + clubRowCount;
}

/**
 * Best-effort wrapper for hot paths (post-batch-sync hook).
 * Swallows every error and logs it — the public sheet is a downstream
 * convenience, not a source of truth, so a transient Sheets API hiccup must
 * never fail an upload.
 */
export function tryRebuildPublicFoldersIndex(): void {
  try {
    rebuildPublicFoldersIndex();
  } catch (err) {
    Logger.log(
      `[publicSpreadsheetService] Non-fatal: failed to refresh public folders index: ${String(err)}`
    );
  }
}
