/**
 * publicSpreadsheetService.ts — materializes the public album index into a
 * SEPARATE Google Sheet that the admin shares "Anyone with the link can view"
 * (or publishes to the web).
 *
 * Why a separate spreadsheet?
 *   The main SPREADSHEET_ID holds all of the app's private data — Users,
 *   Upload_Log, Audit_Log, etc. — and must NOT be shared publicly. This
 *   service writes a redacted, read-only mirror of just the album list to a
 *   different file whose ID is configured via the PUBLIC_ALBUM_INDEX_SHEET_ID
 *   Script Property. Visitors hit that file directly (no Google login required
 *   if the file is shared "Anyone with the link") and see a flat clickable
 *   table of every event's albums.
 *
 *   This is the public-browsing counterpart to publicAlbumIndexService.ts,
 *   which renders the same data inside the (login-gated) GAS web app.
 *
 * Update strategy
 *   The whole "Albums" tab is rewritten on every call. Album churn is small
 *   (a few rows per event, hundreds of events at most), so a full rewrite is
 *   simpler and more reliable than a diff-and-patch update. Callers in hot
 *   paths should use tryRebuildPublicAlbumIndex() so a failure here never
 *   fails the upstream operation (album creation, batch sync, etc.).
 *
 * Configuration
 *   Script Property: PUBLIC_ALBUM_INDEX_SHEET_ID — Google Sheets file ID of
 *   the public-facing spreadsheet. If this property is unset, all functions
 *   in this module become no-ops (logs once and returns) so the feature can
 *   be left disabled without breaking the build or the upload pipeline.
 *
 * Setup checklist (one-time, performed by admin)
 *   1. Create a new, empty Google Sheets file in Drive.
 *   2. File → Share → "Anyone with the link" → Viewer.  (Optionally also
 *      File → Share → Publish to web for a cleaner URL.)
 *   3. Copy the file ID from the URL  /d/<FILE_ID>/edit  and paste it into
 *      Apps Script → Project Settings → Script Properties as
 *      PUBLIC_ALBUM_INDEX_SHEET_ID.
 *   4. From the GAS editor, run rebuildPublicAlbumIndex() once to populate it.
 *      Subsequent updates happen automatically whenever an album is created
 *      or a batch finishes syncing.
 */

import { listPublicAlbumIndex, PublicAlbumIndexEntry } from './publicAlbumIndexService';
import { nowIsoTimestamp } from '../utils/dateFormatter';

/* global PropertiesService, SpreadsheetApp, Logger */

/** Tab name inside the public spreadsheet. */
const PUBLIC_ALBUM_TAB = 'Albums';

/** Script Property key holding the public spreadsheet's file ID. */
const PROP_KEY = 'PUBLIC_ALBUM_INDEX_SHEET_ID';

/**
 * Header row written at the top of the Albums tab.
 *
 * Column order is part of the public contract — anyone who has bookmarked
 * the published-to-web view will see this layout. Add new columns at the
 * end rather than reordering.
 */
const HEADERS: ReadonlyArray<string> = [
  'Event Date',     // YYYY-MM-DD
  'Event Name',
  'Scope',          // "Event" or "Club"
  'Club',           // empty for Event-scope rows
  'Tag',            // empty for Event-scope rows
  'Album Title',
  'Photos',         // syncedFileCount
  'Album Link',     // shareableUrl (or albumUrl as fallback)
  'Last Sync',      // ISO timestamp of last sync; empty if never synced
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
 * Flattens the grouped index into a 2D array matching HEADERS column order.
 * Within each event, the event-level album row is emitted first, followed by
 * the per-club rows in display-name order (already sorted upstream).
 */
function buildRows(entries: ReadonlyArray<PublicAlbumIndexEntry>): unknown[][] {
  const rows: unknown[][] = [];

  for (const entry of entries) {
    if (entry.eventAlbum) {
      const a = entry.eventAlbum;
      rows.push([
        entry.eventDate,
        entry.eventName,
        'Event',
        '',
        '',
        a.albumTitle,
        a.syncedFileCount,
        a.shareableUrl || a.albumUrl,
        a.lastSyncAt,
      ]);
    }
    for (const c of entry.clubAlbums) {
      const a = c.album;
      rows.push([
        entry.eventDate,
        entry.eventName,
        'Club',
        c.clubDisplayName,
        a.tag,
        a.albumTitle,
        a.syncedFileCount,
        a.shareableUrl || a.albumUrl,
        a.lastSyncAt,
      ]);
    }
  }

  return rows;
}

/**
 * Rebuilds the public Albums tab from scratch.
 *
 * Steps:
 *   1. Resolve the spreadsheet by file ID; create the "Albums" tab if missing.
 *   2. Clear all existing content.
 *   3. Write headers, then the flattened rows.
 *   4. Stamp a "last refreshed" note in row 1, column J.
 *
 * Returns the number of data rows written (0 if the property is unset).
 *
 * Throws on any underlying Sheets API error so manual admin runs see the
 * failure. Hot-path callers should use tryRebuildPublicAlbumIndex().
 */
export function rebuildPublicAlbumIndex(): number {
  const fileId = getPublicSheetId();
  if (!fileId) {
    Logger.log(
      `[publicSpreadsheetService] ${PROP_KEY} not set — public album index is disabled`
    );
    return 0;
  }

  const ss = SpreadsheetApp.openById(fileId);
  let sheet = ss.getSheetByName(PUBLIC_ALBUM_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(PUBLIC_ALBUM_TAB);
  }

  const entries = listPublicAlbumIndex();
  const dataRows = buildRows(entries);

  // Clear and rewrite. clearContents() leaves formatting (frozen rows, column
  // widths) intact, which keeps any layout the admin set up by hand.
  sheet.clearContents();

  // Header row + freeze
  sheet
    .getRange(1, 1, 1, HEADERS.length)
    .setValues([HEADERS as unknown[]])
    .setFontWeight('bold');
  sheet.setFrozenRows(1);

  // "Last refreshed" stamp one column past the last header so it doesn't
  // collide with the column titles. Visible-but-unobtrusive.
  sheet
    .getRange(1, HEADERS.length + 1)
    .setValue(`Last refreshed: ${nowIsoTimestamp()}`)
    .setFontStyle('italic');

  if (dataRows.length > 0) {
    sheet
      .getRange(2, 1, dataRows.length, HEADERS.length)
      .setValues(dataRows);
  }

  // Force the write to commit so a viewer reloading the page right after
  // upload sees the new rows.
  SpreadsheetApp.flush();

  Logger.log(
    `[publicSpreadsheetService] Rewrote ${PUBLIC_ALBUM_TAB} tab: ` +
    `${dataRows.length} row(s) across ${entries.length} event(s)`
  );
  return dataRows.length;
}

/**
 * Best-effort wrapper for hot paths (album creation, batch sync completion).
 * Swallows every error and logs it — the public sheet is a downstream
 * convenience, not a source of truth, so a transient Sheets API hiccup must
 * never fail an upload.
 */
export function tryRebuildPublicAlbumIndex(): void {
  try {
    rebuildPublicAlbumIndex();
  } catch (err) {
    Logger.log(
      `[publicSpreadsheetService] Non-fatal: failed to refresh public album index: ${String(err)}`
    );
  }
}
