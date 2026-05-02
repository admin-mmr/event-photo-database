/**
 * albumReconciliationService.ts — finds drift between the Photo_Albums sheet
 * and the actual albums this app owns in Google Photos.
 *
 * Why this exists
 * ---------------
 * The Photo_Albums sheet is the system's record of which Google Photos
 * albums each event/club owns. In practice, the two surfaces drift apart:
 *
 *   • Albums get created in Google Photos directly (e.g. an admin made a
 *     test album by hand) — those exist in "My albums" but never landed in
 *     the sheet, so the public spreadsheet, the Events page, and the upload
 *     pipeline all behave as if the album doesn't exist.
 *
 *   • Sheet rows survive after the underlying Photos album is deleted from
 *     photos.google.com — visiting the album link returns 404 and the
 *     public sheet shows a broken row forever.
 *
 *   • Bugs in earlier versions of the album-creation flow (race conditions,
 *     transient API failures) wrote a Photos album without persisting the
 *     sheet row. We've fixed those, but legacy drift remains.
 *
 * Reconciliation surfaces every divergence so the admin can fix them by
 * hand: re-link sheet rows to the right albumId, delete dangling rows,
 * or run a backfill.
 *
 * Scope visibility note (post-March-2025)
 * --------------------------------------
 * This app is authorized with `photoslibrary.appendonly` and
 * `photoslibrary.edit.appcreateddata`, so GET /albums returns ONLY the
 * albums created by this app. Albums the user made manually inside
 * photos.google.com are intentionally invisible to us — listing them
 * would require a broader scope and a Google security review. The
 * reconciliation report is therefore "everything the app touched in
 * Photos vs. everything the app recorded in the sheet" — exactly what we
 * need to find drift introduced by our own pipeline.
 */

import { PhotosAlbumRecord } from '../types/models';
import { listAllAlbums } from './photoAlbumsRepo';
import { listAll as listAllEvents } from './eventService';
import { findByNormalizedName as findClubByName } from './clubService';
import { photosListOwnedAlbums, ListedAlbum } from './photosApiClient';
import { getConfig } from '../config/constants';
import { nowIsoTimestamp } from '../utils/dateFormatter';

/* global SpreadsheetApp, Logger */

/**
 * Tab name written into the MAIN spreadsheet (not the public one) holding
 * the latest reconciliation report. Lives next to Photo_Albums so admins
 * can flip between the two without changing files.
 */
export const RECONCILIATION_TAB = 'Reconciliation';

/**
 * Header row written at the top of the Reconciliation tab.
 * Columns are stable; new ones go at the end.
 */
const HEADERS: ReadonlyArray<string> = [
  'Status',          // "Orphan in Photos" | "Orphan in Sheet" | "Matched (drift)"
  'Album ID',
  'Album Title',
  'Photos Count',    // mediaItemsCount when known; sheet's syncedFileCount otherwise
  'Album URL',
  'Sheet Event',     // event name from sheet row, if any
  'Sheet Club / Tag',// "Club / Tag" composite, if any
  'Notes',           // human-readable explanation of the drift
];

/** One sheet row that has no corresponding Google Photos album. */
export interface OrphanInSheet {
  readonly album:           PhotosAlbumRecord;
  readonly eventName:       string;        // resolved via Events sheet; '' if unknown
  readonly eventDate:       string;
  readonly clubDisplayName: string;        // resolved via Clubs sheet; '' if event-scope
  readonly notes:           string;        // why we flagged it
}

/** One Google Photos album that is not represented by any sheet row. */
export interface OrphanInPhotos {
  readonly album: ListedAlbum;
  readonly notes: string;
}

/** A matched pair where the sheet has stale metadata vs. the live album. */
export interface MatchedDrift {
  readonly album:    PhotosAlbumRecord;
  readonly live:     ListedAlbum;
  readonly notes:    string;
}

export interface ReconciliationReport {
  readonly generatedAt:    string;
  readonly orphansInSheet: ReadonlyArray<OrphanInSheet>;
  readonly orphansInPhotos: ReadonlyArray<OrphanInPhotos>;
  readonly matchedDrift:   ReadonlyArray<MatchedDrift>;
  readonly checkedSheet:   number;
  readonly checkedPhotos:  number;
  /** Empty unless the Photos API listing failed; the sheet side may still be valid. */
  readonly photosApiError: string;
}

/**
 * Builds the full reconciliation report.
 *
 * Cost: one albums.list pagination loop (≤ N/50 HTTP calls), plus one
 * read each from Photo_Albums, Events, and Clubs. No per-album
 * round-trips here — the listing already includes media counts.
 *
 * If the Photos API listing fails (rare; usually a transient 5xx) we
 * still return a report with `photosApiError` set so the admin sees the
 * failure mode rather than an empty page.
 */
export function buildReconciliationReport(): ReconciliationReport {
  const sheetAlbums = listAllAlbums();
  const events = listAllEvents(1, 10000, 'desc').items;
  const eventById = new Map(events.map((e) => [e.eventId, e]));

  // Pull every album the app owns in Google Photos. On failure we fall
  // through with an empty live list so the orphan-in-sheet half of the
  // report can still be produced (it doesn't depend on the live data).
  const live = photosListOwnedAlbums();
  const liveItems: ListedAlbum[] = live.ok ? live.items ?? [] : [];
  const liveById = new Map<string, ListedAlbum>();
  for (const a of liveItems) liveById.set(a.id, a);

  const sheetById = new Map<string, PhotosAlbumRecord>();
  for (const a of sheetAlbums) {
    if (a.albumId) sheetById.set(a.albumId, a);
  }

  // ─── Orphans in sheet: row exists, Photos album doesn't ────────────────
  const orphansInSheet: OrphanInSheet[] = [];
  for (const album of sheetAlbums) {
    if (!album.albumId) {
      orphansInSheet.push({
        album,
        eventName:       eventById.get(album.eventId)?.eventName ?? '',
        eventDate:       eventById.get(album.eventId)?.eventDate ?? '',
        clubDisplayName: resolveClubDisplay(album),
        notes:           'Sheet row has empty albumId',
      });
      continue;
    }
    if (live.ok && !liveById.has(album.albumId)) {
      orphansInSheet.push({
        album,
        eventName:       eventById.get(album.eventId)?.eventName ?? '',
        eventDate:       eventById.get(album.eventId)?.eventDate ?? '',
        clubDisplayName: resolveClubDisplay(album),
        notes:           'No Google Photos album with this ID — likely deleted',
      });
    }
  }

  // ─── Orphans in Photos: live album exists, no sheet row ───────────────
  const orphansInPhotos: OrphanInPhotos[] = [];
  for (const a of liveItems) {
    if (!sheetById.has(a.id)) {
      orphansInPhotos.push({
        album: a,
        notes: 'Album exists in Google Photos but has no Photo_Albums row',
      });
    }
  }

  // ─── Matched drift: counts or titles disagree ─────────────────────────
  const matchedDrift: MatchedDrift[] = [];
  for (const a of liveItems) {
    const row = sheetById.get(a.id);
    if (!row) continue;
    const driftReasons: string[] = [];
    if (
      typeof a.mediaItemsCount === 'number' &&
      a.mediaItemsCount !== row.syncedFileCount
    ) {
      driftReasons.push(
        `count: sheet=${row.syncedFileCount}, photos=${a.mediaItemsCount}`
      );
    }
    if (a.title && row.albumTitle && a.title !== row.albumTitle) {
      driftReasons.push(`title differs`);
    }
    if (driftReasons.length > 0) {
      matchedDrift.push({ album: row, live: a, notes: driftReasons.join('; ') });
    }
  }

  return {
    generatedAt:     nowIsoTimestamp(),
    orphansInSheet,
    orphansInPhotos,
    matchedDrift,
    checkedSheet:    sheetAlbums.length,
    checkedPhotos:   liveItems.length,
    photosApiError:  live.ok ? '' : (live.error ?? 'Unknown Photos API error'),
  };
}

/**
 * Resolves the human-readable club display name for a sheet row, or '' for
 * event-scope albums. Decoupled into a helper because we look it up in two
 * places (orphan-in-sheet and matched-drift rows).
 */
function resolveClubDisplay(album: PhotosAlbumRecord): string {
  if (album.albumType !== 'club' || !album.clubName) return '';
  const club = findClubByName(album.clubName);
  return club?.displayName ?? album.clubName;
}

/**
 * Writes the report into the MAIN spreadsheet's Reconciliation tab.
 * The tab is rewritten in place on every run; rows are NOT diff-merged.
 * Returns the total number of data rows written.
 */
export function writeReconciliationTab(report: ReconciliationReport): number {
  const config = getConfig();
  const ss = SpreadsheetApp.openById(config.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(RECONCILIATION_TAB);
  if (!sheet) sheet = ss.insertSheet(RECONCILIATION_TAB);

  sheet.clearContents();
  sheet
    .getRange(1, 1, 1, HEADERS.length)
    .setValues([HEADERS as unknown[]])
    .setFontWeight('bold');
  sheet.setFrozenRows(1);

  // Status banner one column past the headers — matches the public sheet.
  const summary =
    `Generated: ${report.generatedAt}` +
    ` | Sheet: ${report.checkedSheet}` +
    ` | Photos: ${report.checkedPhotos}` +
    ` | Orphans (sheet/photos): ${report.orphansInSheet.length}/${report.orphansInPhotos.length}` +
    ` | Drift: ${report.matchedDrift.length}` +
    (report.photosApiError ? ` | API ERROR: ${report.photosApiError}` : '');
  sheet
    .getRange(1, HEADERS.length + 1)
    .setValue(summary)
    .setFontStyle('italic');

  const rows: unknown[][] = [];

  for (const o of report.orphansInSheet) {
    rows.push([
      'Orphan in Sheet',
      o.album.albumId,
      o.album.albumTitle,
      o.album.syncedFileCount,
      o.album.albumUrl,
      o.eventName + (o.eventDate ? ` (${o.eventDate})` : ''),
      [o.clubDisplayName, o.album.tag].filter(Boolean).join(' / '),
      o.notes,
    ]);
  }
  for (const o of report.orphansInPhotos) {
    rows.push([
      'Orphan in Photos',
      o.album.id,
      o.album.title,
      o.album.mediaItemsCount ?? '',
      o.album.productUrl,
      '',
      '',
      o.notes,
    ]);
  }
  for (const d of report.matchedDrift) {
    rows.push([
      'Matched (drift)',
      d.album.albumId,
      d.live.title || d.album.albumTitle,
      d.live.mediaItemsCount ?? d.album.syncedFileCount,
      d.album.albumUrl,
      '',
      [resolveClubDisplay(d.album), d.album.tag].filter(Boolean).join(' / '),
      d.notes,
    ]);
  }

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  }

  SpreadsheetApp.flush();
  Logger.log(
    `[albumReconciliation] Wrote ${rows.length} row(s) to ${RECONCILIATION_TAB}`
  );
  return rows.length;
}
