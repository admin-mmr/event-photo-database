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
import { PhotosAlbumRecord } from '../types/models';
import { nowIsoTimestamp } from '../utils/dateFormatter';
import { getGoogleAlbumDetails, AlbumDetails } from './photosApiClient';

/* global PropertiesService, SpreadsheetApp, Logger, Utilities */

/** Tab name inside the public spreadsheet. */
const PUBLIC_ALBUM_TAB = 'Albums';

/** Script Property key holding the public spreadsheet's file ID. */
const PROP_KEY = 'PUBLIC_ALBUM_INDEX_SHEET_ID';

/**
 * Throttle between Photos API calls during a live rebuild.
 * `albums.get` has generous quota (10k/day) but we still pace per-second so a
 * full rebuild over hundreds of albums never trips the per-second cap. With
 * 150 ms × 100 albums ≈ 15 s, well under the 6-minute GAS execution limit.
 */
const REBUILD_INTER_CALL_DELAY_MS = 150;

/**
 * Header row written at the top of the Albums tab.
 *
 * Column order is part of the public contract — anyone who has bookmarked
 * the published-to-web view will see this layout. Add new columns at the
 * end rather than reordering.
 *
 * "Permission" reflects the live share status read from Google Photos at
 * rebuild time:
 *   - "Public"  → album has shareInfo (Anyone with the link can view)
 *   - "Private" → album exists but is unshared
 *   - "Missing" → album was not found in Google Photos (likely deleted)
 *   - "Unknown" → API call failed or feature disabled
 *
 * "Photos" is also refreshed live from `mediaItemsCount` on each rebuild,
 * so albums that were populated outside the sync pipeline (e.g. backfills
 * done manually in photos.google.com) no longer show 0.
 */
const HEADERS: ReadonlyArray<string> = [
  'Event Date',     // YYYY-MM-DD
  'Event Name',
  'Scope',          // "Event" or "Club"
  'Club',           // empty for Event-scope rows
  'Tag',            // empty for Event-scope rows
  'Album Title',
  'Photos',         // live mediaItemsCount, falls back to syncedFileCount
  'Album Link',     // shareableUrl (or albumUrl as fallback)
  'Last Sync',      // ISO timestamp of last sync; empty if never synced
  'Permission',     // "Public" / "Private" / "Missing" / "Unknown"
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
 * Public-facing URL for the album-index spreadsheet, or empty string if the
 * feature is unconfigured.
 *
 * Used by the dashboard and login pages to decide whether to render the
 * "Browse all albums" banner card. We deliberately return '' (rather than
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

/**
 * Heuristic: detects when a Photo_Albums row appears column-shifted, i.e.
 * the cell that should hold a human-readable title actually holds a URL, or
 * the cell that should hold a URL actually holds a timestamp.
 *
 * We've seen exactly this shape historically on event-scope rows (where
 * albumTitle = "https://photos.google.com/…" and albumUrl = an ISO timestamp),
 * which made the public sheet show URLs in the "Album Title" column. Rather
 * than silently propagate that into the public view, swap the two fields
 * back into their intended slots so the sheet reads correctly even before the
 * underlying Photo_Albums row is repaired.
 */
function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
function looksLikeIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);
}

interface NormalizedAlbumDisplay {
  title: string;
  url: string;
  lastSyncAt: string;
}

/**
 * Returns the (title, url, lastSyncAt) triple to display for a given album,
 * with light auto-correction for the title/url-swap pattern documented above.
 *
 * - If albumTitle is an http(s) URL, treat it as the URL and prefer
 *   `${eventDate} ${eventName}` (or display name) as the title.
 * - If albumUrl looks like a timestamp rather than a URL, treat it as the
 *   missing lastSyncAt value.
 *
 * Logging only — we never write back into Photo_Albums from here.
 */
function normalizeAlbumDisplay(
  album: PhotosAlbumRecord,
  fallbackTitle: string
): NormalizedAlbumDisplay {
  const rawTitle = album.albumTitle || '';
  // shareableUrl is being deprecated (always equal to albumUrl); fall back to
  // it only for legacy rows where albumUrl might be empty.
  const rawUrl   = album.albumUrl || album.shareableUrl || '';
  const rawSync  = album.lastSyncAt || '';

  let title = rawTitle;
  let url   = rawUrl;
  let lastSyncAt = rawSync;

  // Swap pattern: title cell holds a URL, url cell holds a timestamp.
  if (looksLikeUrl(rawTitle) && looksLikeIsoTimestamp(rawUrl)) {
    Logger.log(
      `[publicSpreadsheetService] Repaired column-shifted row for albumId=${album.albumId}: ` +
      `title looked like URL, url looked like timestamp.`
    );
    url        = rawTitle;
    lastSyncAt = lastSyncAt || rawUrl;
    title      = fallbackTitle;
  } else if (looksLikeUrl(rawTitle) && !looksLikeUrl(rawUrl)) {
    // Looser pattern: title is a URL but url cell isn't. Still fix the
    // visible title; keep whatever the url cell had.
    Logger.log(
      `[publicSpreadsheetService] Album ${album.albumId} has a URL in its title field; using fallback title.`
    );
    if (!url) url = rawTitle;
    title = fallbackTitle;
  }

  return { title, url, lastSyncAt };
}

/**
 * Maps live album-details into the user-facing permission label.
 * `null` (missing entry in the cache) means we never asked the API — fall
 * back to "Unknown" so the column never goes blank.
 */
function permissionLabel(details: AlbumDetails | null): string {
  if (!details) return 'Unknown';
  if (!details.found) return 'Missing';
  return details.isShared ? 'Public' : 'Private';
}

/**
 * Picks the photo count to display: prefer the live mediaItemsCount from
 * Google Photos when available, otherwise fall back to the cached
 * syncedFileCount on the sheet row. Resolves the "Photos always 0" pattern
 * for albums that were populated out-of-band.
 */
function photoCount(album: PhotosAlbumRecord, details: AlbumDetails | null): number {
  if (details && details.found && typeof details.mediaItemsCount === 'number') {
    return details.mediaItemsCount;
  }
  return album.syncedFileCount;
}

/**
 * Flattens the grouped index into a 2D array matching HEADERS column order.
 * Within each event, the event-level album row is emitted first, followed by
 * the per-club rows in display-name order (already sorted upstream).
 *
 * `liveDetails` is keyed by albumId. When an entry is present, its values
 * win over the cached sheet values (count, share status). When absent, we
 * gracefully fall back to whatever the sheet has and stamp Permission as
 * "Unknown" so callers can tell the live check didn't run for that row.
 */
function buildRows(
  entries: ReadonlyArray<PublicAlbumIndexEntry>,
  liveDetails: Map<string, AlbumDetails>
): unknown[][] {
  const rows: unknown[][] = [];

  for (const entry of entries) {
    if (entry.eventAlbum) {
      const a = entry.eventAlbum;
      const fallback = `${entry.eventDate} ${entry.eventName}`;
      const norm = normalizeAlbumDisplay(a, fallback);
      const details = liveDetails.get(a.albumId) ?? null;
      rows.push([
        entry.eventDate,
        entry.eventName,
        'Event',
        '',
        '',
        norm.title,
        photoCount(a, details),
        norm.url,
        norm.lastSyncAt,
        permissionLabel(details),
      ]);
    }
    for (const c of entry.clubAlbums) {
      const a = c.album;
      const fallback = `${entry.eventDate} ${entry.eventName} – ${c.clubDisplayName}` +
        (a.tag ? ` – ${a.tag}` : '');
      const norm = normalizeAlbumDisplay(a, fallback);
      const details = liveDetails.get(a.albumId) ?? null;
      rows.push([
        entry.eventDate,
        entry.eventName,
        'Club',
        c.clubDisplayName,
        a.tag,
        norm.title,
        photoCount(a, details),
        norm.url,
        norm.lastSyncAt,
        permissionLabel(details),
      ]);
    }
  }

  return rows;
}

/**
 * Calls albums.get for every unique albumId in the index and returns a
 * map of albumId → details. Errors are absorbed (left out of the map) so
 * the rebuild can still write rows with "Unknown" permission for failed
 * lookups rather than failing the whole tab.
 *
 * Throttles inter-call delays to stay well clear of the per-second quota.
 */
function fetchLiveAlbumDetails(
  entries: ReadonlyArray<PublicAlbumIndexEntry>
): Map<string, AlbumDetails> {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.eventAlbum?.albumId && !seen.has(entry.eventAlbum.albumId)) {
      seen.add(entry.eventAlbum.albumId);
      ids.push(entry.eventAlbum.albumId);
    }
    for (const c of entry.clubAlbums) {
      if (c.album.albumId && !seen.has(c.album.albumId)) {
        seen.add(c.album.albumId);
        ids.push(c.album.albumId);
      }
    }
  }

  const out = new Map<string, AlbumDetails>();
  for (let i = 0; i < ids.length; i++) {
    if (i > 0) Utilities.sleep(REBUILD_INTER_CALL_DELAY_MS);
    try {
      out.set(ids[i], getGoogleAlbumDetails(ids[i]));
    } catch (err) {
      Logger.log(
        `[publicSpreadsheetService] albums.get failed for ${ids[i]}: ${String(err)}`
      );
      // Leave it out of the map — caller will render "Unknown".
    }
  }
  return out;
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
  // Live API calls happen ONCE per rebuild — share status + media count
  // come from the same albums.get response, so we pay one HTTP round-trip
  // per album and learn everything we need.
  const liveDetails = fetchLiveAlbumDetails(entries);
  const dataRows = buildRows(entries, liveDetails);

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
