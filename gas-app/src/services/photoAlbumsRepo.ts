/**
 * photoAlbumsRepo.ts — Sheet I/O layer for Photo_Albums and Photo_Files.
 *
 * Extracted from photosService.ts (§1.1 god-file split) so that all
 * Google Sheets read/write operations for Photos data live in one place,
 * separate from the HTTP API client and the sync orchestration layer.
 *
 * No Photos API calls are made here — every function is pure sheet I/O.
 */

import { PhotosAlbumRecord, PhotosFileRecord } from '../types/models';
import { getConfig } from '../config/constants';
import { getAllRows, appendRow, updateRow, clearDataRows } from './sheetService';
import {
  toPhotosAlbumRecord,
  fromPhotosAlbumRecord,
  toPhotosFileRecord,
  fromPhotosFileRecord,
} from '../utils/sheetMapper';

// ─── Photo_Albums sheet helpers ──────────────────────────────────────────────

/**
 * Loads all rows from the Photo_Albums sheet and maps them to typed records.
 * Rows that fail validation are silently dropped.
 */
export function loadAlbums(): PhotosAlbumRecord[] {
  const config = getConfig();
  const rows = getAllRows(config.SHEET_NAMES.PHOTO_ALBUMS);
  return rows
    .map(toPhotosAlbumRecord)
    .filter((r): r is PhotosAlbumRecord => r !== null);
}

/**
 * Finds the event-level album record for a given event, or null.
 */
export function findAlbumByEvent(eventId: string): PhotosAlbumRecord | null {
  return (
    loadAlbums().find((a) => a.albumType === 'event' && a.eventId === eventId) ?? null
  );
}

/**
 * Finds the album record for a given (event, club, tag) triple, or null.
 *
 * Every non-event album is scoped to a (club, tag) pair — there is no
 * tag-less per-club album in the new schema.
 */
export function findAlbumByEventClubTag(
  eventId: string,
  clubName: string,
  tag: string
): PhotosAlbumRecord | null {
  return (
    loadAlbums().find(
      (a) => a.albumType === 'club'
          && a.eventId === eventId
          && a.clubName === clubName
          && a.tag === tag
    ) ?? null
  );
}

/**
 * Returns all album records (event + club) for a given event.
 * Used by the Events page to render album links.
 */
export function findAlbumsByEvent(eventId: string): PhotosAlbumRecord[] {
  return loadAlbums().filter((a) => a.eventId === eventId);
}

/**
 * Returns all album records in the Photo_Albums sheet.
 * Used by the admin Photos Overview page to render the full album index.
 */
export function listAllAlbums(): PhotosAlbumRecord[] {
  return loadAlbums();
}

/** Appends a new album record to the Photo_Albums sheet. */
export function saveAlbum(record: PhotosAlbumRecord): void {
  const config = getConfig();
  appendRow(config.SHEET_NAMES.PHOTO_ALBUMS, fromPhotosAlbumRecord(record));
}

/**
 * Updates the lastSyncAt and syncedFileCount columns for an existing album row.
 * Matches by albumId (column 0).
 *
 * @param preloadedRows  Optional pre-loaded Photo_Albums rows (avoids an extra
 *                       sheet read when the caller already holds them). Pass
 *                       null/undefined to trigger a fresh read.
 */
export function updateAlbumSyncStats(
  albumId: string,
  lastSyncAt: string,
  syncedFileCount: number,
  preloadedRows?: unknown[][] | null
): void {
  const config = getConfig();
  const rows = preloadedRows ?? getAllRows(config.SHEET_NAMES.PHOTO_ALBUMS);
  const rowIndex = rows.findIndex((row) => String(row[0] ?? '').trim() === albumId);
  if (rowIndex < 0) return;

  const record = toPhotosAlbumRecord(rows[rowIndex]);
  if (!record) return;

  const updated: PhotosAlbumRecord = { ...record, lastSyncAt, syncedFileCount };
  // updateRow is 1-based and accounts for the header row (+2 offset: 1 for header, 1 for 0→1 index)
  updateRow(config.SHEET_NAMES.PHOTO_ALBUMS, rowIndex + 2, fromPhotosAlbumRecord(updated));
}

// ─── Photo_Files helpers ─────────────────────────────────────────────────────

/**
 * Loads all rows from the Photo_Files sheet and maps them to typed records.
 * Rows that fail validation are silently dropped.
 */
export function loadFileRecords(): PhotosFileRecord[] {
  const config = getConfig();
  const rows = getAllRows(config.SHEET_NAMES.PHOTO_FILES);
  return rows
    .map(toPhotosFileRecord)
    .filter((r): r is PhotosFileRecord => r !== null);
}

/**
 * Returns the file record for the given (driveFileId, albumId) pair, or null.
 * Used before each upload to avoid syncing the same Drive file to the same
 * album twice.
 */
export function findSyncedFile(
  driveFileId: string,
  albumId: string
): PhotosFileRecord | null {
  return (
    loadFileRecords().find(
      (r) => r.driveFileId === driveFileId && r.albumId === albumId
    ) ?? null
  );
}

/** Appends a new row to Photo_Files after a successful sync. */
export function saveFileRecord(record: PhotosFileRecord): void {
  const config = getConfig();
  appendRow(config.SHEET_NAMES.PHOTO_FILES, fromPhotosFileRecord(record));
}

/**
 * Returns all file records in the Photo_Files sheet.
 * Used by the reconciliation audit to compare Drive vs Photos counts.
 */
export function listAllFileRecords(): PhotosFileRecord[] {
  return loadFileRecords();
}

// ─── Destructive helpers (reset operations) ──────────────────────────────────

/**
 * Deletes every data row from Photo_Albums (header preserved).
 * Returns the count of rows removed.
 *
 * WARNING: This is irreversible. The caller must ensure the admin has
 * confirmed the action before invoking this function.
 */
export function clearAllAlbumRows(): number {
  const config = getConfig();
  return clearDataRows(config.SHEET_NAMES.PHOTO_ALBUMS);
}

/**
 * Deletes Photo_Files rows whose albumId is NOT in `remainingAlbumIds`.
 * After a full album purge, pass an empty Set to remove every file record.
 * Returns the count of rows removed.
 *
 * Implementation: reads all rows first, finds orphan indices, then rewrites
 * the sheet without those rows (Sheets API has no single-row delete in batch,
 * so we clear the whole data range and re-append keepers).
 */
export function clearOrphanFileRows(remainingAlbumIds: ReadonlySet<string>): number {
  const config = getConfig();
  const sheetName = config.SHEET_NAMES.PHOTO_FILES;
  const rows = getAllRows(sheetName);
  if (rows.length === 0) return 0;

  const keepers = rows.filter((row) => {
    const albumId = String(row[1] ?? '').trim(); // column B = albumId
    return remainingAlbumIds.has(albumId);
  });

  const removed = rows.length - keepers.length;
  if (removed === 0) return 0;

  // Clear all data rows then re-append the keepers one by one.
  // In practice, after a full album purge keepers will be empty, so
  // this loop almost never runs.
  clearDataRows(sheetName);
  for (const row of keepers) {
    appendRow(sheetName, row as unknown[]);
  }
  return removed;
}
