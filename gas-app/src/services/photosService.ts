import { ResultStatus } from '../types/enums';
import { PhotosAlbumRecord } from '../types/models';
import { ServiceResult } from '../types/responses';
import { getConfig } from '../config/constants';
import { getAllRows, appendRow, updateRow } from './sheetService';
import { toPhotosAlbumRecord, fromPhotosAlbumRecord, toEventRecord } from '../utils/sheetMapper';
import { nowIsoTimestamp } from '../utils/dateFormatter';

/* global ScriptApp, UrlFetchApp, DriveApp, Logger */

/**
 * PhotosService — Google Photos Library API integration.
 *
 * Manages the lifecycle of Google Photos albums that mirror the Drive folder
 * hierarchy.  For each event a "master" album is created containing all clubs'
 * photos; for each event+club combination a narrower "club" album is created.
 *
 * Album metadata is persisted in the "Photos_Albums" Google Sheet so that
 * album IDs survive across GAS executions and albums are never created twice.
 *
 * Drive → Photos sync flow:
 *   1. ensureEventAlbum()   — idempotently creates the event-level album
 *   2. ensureClubAlbum()    — idempotently creates the per-club album
 *   3. syncBatchToAlbums()  — called from serverCompleteUpload / API upload
 *      ├── syncBatchFolderToAlbum(eventAlbumId, batchFolderId)
 *      └── syncBatchFolderToAlbum(clubAlbumId,  batchFolderId)
 *
 * For admin-triggered full syncs / backfills:
 *   syncEventToAlbums(event)  — walks Layer-2 clubs → Layer-3 batches → files
 *   backfillAllAlbums()       — iterates every event in the Events sheet
 *
 * Google Photos Library API reference:
 *   https://developers.google.com/photos/library/reference/rest
 *
 * Constraints:
 *   - GAS 6-minute execution limit: backfill of large archives may require
 *     multiple runs (the function is idempotent — already-synced photos are
 *     re-added, but Google Photos deduplicates by content hash in most cases).
 *   - Photos API rate limit: ~10,000 media items per day per project.
 *   - Upload tokens expire after ~24 hours; they are used immediately here.
 */

// ─── Google Photos API constants ──────────────────────────────────────────────

const PHOTOS_API_BASE = 'https://photoslibrary.googleapis.com/v1';

/** MIME types eligible for Photos upload (mirrors PhotoMimeType enum). */
const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/heic'];

// ─── Low-level HTTP helpers ───────────────────────────────────────────────────

function getAuthToken(): string {
  return ScriptApp.getOAuthToken();
}

/**
 * Makes a POST request to the Photos Library API with a JSON body.
 * Returns parsed JSON data on 2xx, or an error description on failure.
 */
function photosPost(
  endpoint: string,
  body: object
): { ok: boolean; data?: unknown; error?: string } {
  try {
    const response = UrlFetchApp.fetch(`${PHOTOS_API_BASE}${endpoint}`, {
      method: 'post',
      headers: {
        Authorization: `Bearer ${getAuthToken()}`,
        'Content-Type': 'application/json',
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    const text = response.getContentText();

    if (code < 200 || code >= 300) {
      return { ok: false, error: `HTTP ${code}: ${text.slice(0, 300)}` };
    }
    return { ok: true, data: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Uploads raw image bytes to the Photos "resumable upload" endpoint.
 * Returns an uploadToken string that can be used in a subsequent
 * mediaItems:batchCreate call.
 *
 * Protocol: raw (non-resumable) — sufficient for files ≤ 50 MB, which is
 * the GAS payload limit anyway.
 */
function photosUploadBytes(
  blob: GoogleAppsScript.Base.Blob,
  mimeType: string
): { ok: boolean; uploadToken?: string; error?: string } {
  try {
    const response = UrlFetchApp.fetch(`${PHOTOS_API_BASE}/uploads`, {
      method: 'post',
      headers: {
        Authorization: `Bearer ${getAuthToken()}`,
        'Content-Type': 'application/octet-stream',
        'X-Goog-Upload-Content-Type': mimeType,
        'X-Goog-Upload-Protocol': 'raw',
      },
      payload: blob.getBytes(),
      muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    if (code < 200 || code >= 300) {
      return {
        ok: false,
        error: `HTTP ${code}: ${response.getContentText().slice(0, 300)}`,
      };
    }
    return { ok: true, uploadToken: response.getContentText().trim() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ─── Photos_Albums sheet helpers ──────────────────────────────────────────────

function loadAlbums(): PhotosAlbumRecord[] {
  const config = getConfig();
  const rows = getAllRows(config.SHEET_NAMES.PHOTOS_ALBUMS);
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
 * Finds the club-level album record for a given event+club pair, or null.
 */
export function findAlbumByEventAndClub(
  eventId: string,
  clubName: string
): PhotosAlbumRecord | null {
  return (
    loadAlbums().find(
      (a) => a.albumType === 'club' && a.eventId === eventId && a.clubName === clubName
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

function saveAlbum(record: PhotosAlbumRecord): void {
  const config = getConfig();
  appendRow(config.SHEET_NAMES.PHOTOS_ALBUMS, fromPhotosAlbumRecord(record));
}

/**
 * Updates the lastSyncAt and syncedFileCount columns for an existing album row.
 * Matches by albumId (column 0).
 */
function updateAlbumSyncStats(
  albumId: string,
  lastSyncAt: string,
  syncedFileCount: number
): void {
  const config = getConfig();
  const rows = getAllRows(config.SHEET_NAMES.PHOTOS_ALBUMS);
  const rowIndex = rows.findIndex((row) => String(row[0] ?? '').trim() === albumId);
  if (rowIndex < 0) return;

  const record = toPhotosAlbumRecord(rows[rowIndex]);
  if (!record) return;

  const updated: PhotosAlbumRecord = { ...record, lastSyncAt, syncedFileCount };
  // updateRow is 1-based and accounts for the header row (+2 offset: 1 for header, 1 for 0→1 index)
  updateRow(config.SHEET_NAMES.PHOTOS_ALBUMS, rowIndex + 2, fromPhotosAlbumRecord(updated));
}

// ─── Album creation ───────────────────────────────────────────────────────────

interface GoogleAlbumCreationResult {
  albumId: string;
  productUrl: string;
  shareableUrl: string;
}

/**
 * Creates a new Google Photos album and makes it shareable.
 * Returns the album ID, product URL, and public shareable URL.
 *
 * Note: the shareable URL requires a second API call (:share).
 * If sharing fails (e.g. org policy), productUrl is used as a fallback.
 */
function createGoogleAlbum(
  title: string
): ServiceResult<GoogleAlbumCreationResult> {
  // Step 1: create the album
  const createResult = photosPost('/albums', { album: { title } });
  if (!createResult.ok || !createResult.data) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to create Photos album "${title}": ${createResult.error}`,
    };
  }

  const albumData = createResult.data as { id: string; productUrl: string };
  const albumId = albumData.id;
  const productUrl = albumData.productUrl ?? '';

  // Step 2: share the album (best-effort — not fatal if it fails)
  let shareableUrl = productUrl;
  const shareResult = photosPost(`/albums/${albumId}:share`, {
    sharedAlbumOptions: { isCollaborative: false, isCommentable: false },
  });
  if (shareResult.ok && shareResult.data) {
    const shareData = shareResult.data as {
      shareInfo?: { shareableUrl?: string };
    };
    shareableUrl = shareData.shareInfo?.shareableUrl ?? productUrl;
  } else {
    Logger.log(
      `[PhotosService] Warning: album "${title}" sharing failed (${shareResult.error}); ` +
      'productUrl will be used as fallback.'
    );
  }

  return {
    status: ResultStatus.SUCCESS,
    message: `Album "${title}" created`,
    data: { albumId, productUrl, shareableUrl },
  };
}

// ─── Public API — album lifecycle ─────────────────────────────────────────────

/**
 * Ensures a master event album exists for the given event.
 * Creates it in Google Photos and persists the record if it doesn't exist yet.
 *
 * Album title format: "YYYY-MM-DD EventName"
 * e.g. "2026-04-15 Boston Marathon"
 *
 * Idempotent — safe to call multiple times; returns the existing record on
 * subsequent calls without making any API requests.
 */
export function ensureEventAlbum(
  eventId: string,
  eventName: string,
  eventDate: string
): ServiceResult<PhotosAlbumRecord> {
  const existing = findAlbumByEvent(eventId);
  if (existing) {
    return { status: ResultStatus.SUCCESS, message: 'Event album already exists', data: existing };
  }

  const title = `${eventDate} ${eventName}`;
  const createResult = createGoogleAlbum(title);
  if (createResult.status !== ResultStatus.SUCCESS || !createResult.data) {
    return { status: ResultStatus.ERROR, message: createResult.message };
  }

  const now = nowIsoTimestamp();
  const record: PhotosAlbumRecord = {
    albumId:         createResult.data.albumId,
    albumType:       'event',
    eventId,
    clubName:        '',
    albumTitle:      title,
    albumUrl:        createResult.data.productUrl,
    shareableUrl:    createResult.data.shareableUrl,
    createdAt:       now,
    lastSyncAt:      '',
    syncedFileCount: 0,
  };

  saveAlbum(record);
  Logger.log(`[PhotosService] Created event album: "${title}" (${record.albumId})`);

  return {
    status: ResultStatus.SUCCESS,
    message: `Event album created: "${title}"`,
    data: record,
  };
}

/**
 * Ensures a per-club album exists for the given event+club combination.
 * Creates it in Google Photos and persists the record if it doesn't exist yet.
 *
 * Album title format: "YYYY-MM-DD EventName – ClubDisplayName"
 * e.g. "2026-04-15 Boston Marathon – Misty Mountain"
 *
 * Idempotent — see ensureEventAlbum.
 */
export function ensureClubAlbum(
  eventId: string,
  eventName: string,
  eventDate: string,
  clubName: string,
  clubDisplayName: string
): ServiceResult<PhotosAlbumRecord> {
  const existing = findAlbumByEventAndClub(eventId, clubName);
  if (existing) {
    return { status: ResultStatus.SUCCESS, message: 'Club album already exists', data: existing };
  }

  const title = `${eventDate} ${eventName} \u2013 ${clubDisplayName}`;
  const createResult = createGoogleAlbum(title);
  if (createResult.status !== ResultStatus.SUCCESS || !createResult.data) {
    return { status: ResultStatus.ERROR, message: createResult.message };
  }

  const now = nowIsoTimestamp();
  const record: PhotosAlbumRecord = {
    albumId:         createResult.data.albumId,
    albumType:       'club',
    eventId,
    clubName,
    albumTitle:      title,
    albumUrl:        createResult.data.productUrl,
    shareableUrl:    createResult.data.shareableUrl,
    createdAt:       now,
    lastSyncAt:      '',
    syncedFileCount: 0,
  };

  saveAlbum(record);
  Logger.log(`[PhotosService] Created club album: "${title}" (${record.albumId})`);

  return {
    status: ResultStatus.SUCCESS,
    message: `Club album created: "${title}"`,
    data: record,
  };
}

// ─── Public API — file sync ───────────────────────────────────────────────────

/**
 * Uploads a single Drive file to a Google Photos album.
 *
 * Steps:
 *   1. Read the file blob from Google Drive
 *   2. POST raw bytes to /v1/uploads → receive uploadToken
 *   3. POST /v1/mediaItems:batchCreate with the token → media item created
 *
 * @param albumId      Google Photos album ID (from PhotosAlbumRecord.albumId)
 * @param driveFileId  Google Drive file ID
 * @param fileName     Target filename (used as the media item description)
 * @param mimeType     Image MIME type (must be a PHOTO_MIME_TYPES member)
 */
export function addDriveFileToAlbum(
  albumId: string,
  driveFileId: string,
  fileName: string,
  mimeType: string
): ServiceResult<{ mediaItemId: string }> {
  // Read blob from Drive
  let blob: GoogleAppsScript.Base.Blob;
  try {
    blob = DriveApp.getFileById(driveFileId).getBlob();
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Cannot read Drive file "${driveFileId}": ${String(err)}`,
    };
  }

  // Upload bytes → uploadToken
  const uploadResult = photosUploadBytes(blob, mimeType);
  if (!uploadResult.ok || !uploadResult.uploadToken) {
    return {
      status: ResultStatus.ERROR,
      message: `Byte upload failed for "${fileName}": ${uploadResult.error}`,
    };
  }

  // Create media item in album
  const batchResult = photosPost('/mediaItems:batchCreate', {
    albumId,
    newMediaItems: [
      {
        description: fileName,
        simpleMediaItem: {
          uploadToken: uploadResult.uploadToken,
          fileName,
        },
      },
    ],
  });

  if (!batchResult.ok || !batchResult.data) {
    return {
      status: ResultStatus.ERROR,
      message: `mediaItems:batchCreate failed for "${fileName}": ${batchResult.error}`,
    };
  }

  const batchData = batchResult.data as {
    newMediaItemResults?: Array<{
      status?: { message?: string; code?: number };
      mediaItem?: { id: string };
    }>;
  };

  const itemResult = batchData.newMediaItemResults?.[0];
  if (!itemResult?.mediaItem?.id) {
    const errMsg = itemResult?.status?.message ?? 'Unexpected API response';
    return {
      status: ResultStatus.ERROR,
      message: `Media item creation failed for "${fileName}": ${errMsg}`,
    };
  }

  return {
    status: ResultStatus.SUCCESS,
    message: `"${fileName}" added to album`,
    data: { mediaItemId: itemResult.mediaItem.id },
  };
}

export interface FolderSyncResult {
  synced: number;
  skipped: number;
  errors: string[];
}

/**
 * Syncs all eligible photos in a single Drive batch folder (Layer 3) to the
 * given Google Photos album.
 *
 * Only JPEG, PNG, and HEIC files are uploaded; all other types are skipped.
 * Per-file errors are collected and returned rather than aborting the whole sync.
 *
 * @param albumId       Google Photos album ID
 * @param batchFolderId Drive ID of the Layer-3 batch folder
 */
export function syncBatchFolderToAlbum(
  albumId: string,
  batchFolderId: string
): ServiceResult<FolderSyncResult> {
  let folder: GoogleAppsScript.Drive.Folder;
  try {
    folder = DriveApp.getFolderById(batchFolderId);
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Cannot access batch folder "${batchFolderId}": ${String(err)}`,
    };
  }

  const iter = folder.getFiles();
  let synced = 0;
  let skipped = 0;
  const errors: string[] = [];

  while (iter.hasNext()) {
    const file = iter.next();
    const mimeType = file.getMimeType();

    if (!PHOTO_MIME_TYPES.includes(mimeType)) {
      skipped++;
      continue;
    }

    const result = addDriveFileToAlbum(albumId, file.getId(), file.getName(), mimeType);
    if (result.status === ResultStatus.SUCCESS) {
      synced++;
    } else {
      errors.push(`${file.getName()}: ${result.message}`);
      Logger.log(`[PhotosService] syncBatchFolderToAlbum error: ${result.message}`);
    }
  }

  return {
    status: ResultStatus.SUCCESS,
    message: `Synced ${synced} file(s) (${skipped} skipped, ${errors.length} error(s))`,
    data: { synced, skipped, errors },
  };
}

export interface BatchAlbumSyncResult {
  eventAlbumId:  string;
  clubAlbumId:   string;
  eventSynced:   number;
  clubSynced:    number;
  errors:        string[];
}

/**
 * Syncs all photos in one upload batch folder to both the event album and the
 * club-specific album.  Creates either album if it doesn't exist yet.
 *
 * This is the primary hook called from serverCompleteUpload (web upload) and
 * handleApiUploadFile (REST API upload) after files are written to Drive.
 *
 * @param eventId          UUID of the event
 * @param eventName        Human-readable event name
 * @param eventDate        YYYY-MM-DD
 * @param clubName         Normalized club folder name (e.g. "New_Bee")
 * @param clubDisplayName  Club display name for album title (e.g. "New Bee")
 * @param batchFolderId    Drive ID of the Layer-3 batch folder
 */
export function syncBatchToAlbums(
  eventId: string,
  eventName: string,
  eventDate: string,
  clubName: string,
  clubDisplayName: string,
  batchFolderId: string
): ServiceResult<BatchAlbumSyncResult> {
  const errors: string[] = [];

  // Ensure event album
  const eventAlbumResult = ensureEventAlbum(eventId, eventName, eventDate);
  if (eventAlbumResult.status !== ResultStatus.SUCCESS || !eventAlbumResult.data) {
    return {
      status: ResultStatus.ERROR,
      message: `Cannot ensure event album: ${eventAlbumResult.message}`,
    };
  }
  const eventAlbumRecord = eventAlbumResult.data;

  // Ensure club album
  const clubAlbumResult = ensureClubAlbum(eventId, eventName, eventDate, clubName, clubDisplayName);
  if (clubAlbumResult.status !== ResultStatus.SUCCESS || !clubAlbumResult.data) {
    return {
      status: ResultStatus.ERROR,
      message: `Cannot ensure club album: ${clubAlbumResult.message}`,
    };
  }
  const clubAlbumRecord = clubAlbumResult.data;

  // Sync batch to event album
  const eventSyncResult = syncBatchFolderToAlbum(eventAlbumRecord.albumId, batchFolderId);
  const eventSynced = eventSyncResult.data?.synced ?? 0;
  if (eventSyncResult.data?.errors.length) {
    errors.push(...eventSyncResult.data.errors.map((e) => `[event] ${e}`));
  }

  // Sync batch to club album
  const clubSyncResult = syncBatchFolderToAlbum(clubAlbumRecord.albumId, batchFolderId);
  const clubSynced = clubSyncResult.data?.synced ?? 0;
  if (clubSyncResult.data?.errors.length) {
    errors.push(...clubSyncResult.data.errors.map((e) => `[club:${clubName}] ${e}`));
  }

  // Persist updated sync stats
  const now = nowIsoTimestamp();
  updateAlbumSyncStats(
    eventAlbumRecord.albumId,
    now,
    eventAlbumRecord.syncedFileCount + eventSynced
  );
  updateAlbumSyncStats(
    clubAlbumRecord.albumId,
    now,
    clubAlbumRecord.syncedFileCount + clubSynced
  );

  Logger.log(
    `[PhotosService] syncBatchToAlbums: event="${eventName}", club="${clubName}", ` +
    `eventSynced=${eventSynced}, clubSynced=${clubSynced}, errors=${errors.length}`
  );

  return {
    status: ResultStatus.SUCCESS,
    message:
      `Batch synced: ${eventSynced} photo(s) → event album, ` +
      `${clubSynced} photo(s) → club album`,
    data: {
      eventAlbumId: eventAlbumRecord.albumId,
      clubAlbumId:  clubAlbumRecord.albumId,
      eventSynced,
      clubSynced,
      errors,
    },
  };
}

// ─── EventInfo helper type ────────────────────────────────────────────────────

/**
 * Minimal event data required by syncEventToAlbums.
 * Mirrors the relevant fields of EventRecord without importing EventService
 * (which would create a circular dependency).
 */
export interface EventInfo {
  readonly eventId:       string;
  readonly eventName:     string;
  readonly eventDate:     string;
  readonly driveFolderId: string;
}

export interface ClubSyncSummary {
  clubName:    string;
  clubAlbumId: string;
  synced:      number;
}

export interface SyncEventResult {
  eventId:      string;
  eventAlbumId: string;
  clubsSynced:  ClubSyncSummary[];
  totalSynced:  number;
  errors:       string[];
}

/**
 * Full sync of all Drive photos for one event to Google Photos albums.
 *
 * Walks the Drive hierarchy:
 *   Layer 1 (event folder) → Layer 2 (club folders) → Layer 3 (batch folders) → files
 *
 * For each club folder:
 *   1. Ensures the event-level album exists
 *   2. Ensures the club-level album exists
 *   3. Syncs every batch folder's photos to both albums
 *
 * Used for:
 *   - Admin-triggered manual sync (serverSyncAlbum)
 *   - Backfill of existing events (backfillAllAlbums)
 *
 * @param event  EventInfo object (subset of EventRecord)
 * @param clubDisplayNames  Optional map of normalizedName → displayName for album titles.
 *                          If omitted, underscores in normalizedName are replaced with spaces.
 */
export function syncEventToAlbums(
  event: EventInfo,
  clubDisplayNames?: Record<string, string>
): ServiceResult<SyncEventResult> {
  const errors: string[] = [];
  const clubsSynced: ClubSyncSummary[] = [];
  let totalSynced = 0;

  // Ensure event-level album
  const eventAlbumResult = ensureEventAlbum(event.eventId, event.eventName, event.eventDate);
  if (eventAlbumResult.status !== ResultStatus.SUCCESS || !eventAlbumResult.data) {
    return {
      status: ResultStatus.ERROR,
      message: `Cannot ensure event album for "${event.eventName}": ${eventAlbumResult.message}`,
    };
  }
  const eventAlbumRecord = eventAlbumResult.data;

  // Open the Layer-1 event folder in Drive
  let eventFolder: GoogleAppsScript.Drive.Folder;
  try {
    eventFolder = DriveApp.getFolderById(event.driveFolderId);
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Cannot access Drive folder for event "${event.eventName}": ${String(err)}`,
    };
  }

  // Walk Layer-2 club folders
  const clubIter = eventFolder.getFolders();
  while (clubIter.hasNext()) {
    const clubFolder = clubIter.next();
    const clubName = clubFolder.getName();
    const clubDisplayName =
      clubDisplayNames?.[clubName] ?? clubName.replace(/_/g, ' ');

    // Ensure club album
    const clubAlbumResult = ensureClubAlbum(
      event.eventId, event.eventName, event.eventDate,
      clubName, clubDisplayName
    );
    if (clubAlbumResult.status !== ResultStatus.SUCCESS || !clubAlbumResult.data) {
      errors.push(`Club "${clubName}": ${clubAlbumResult.message}`);
      continue;
    }
    const clubAlbumRecord = clubAlbumResult.data;
    let clubSynced = 0;

    // Walk Layer-3 batch folders
    const batchIter = clubFolder.getFolders();
    while (batchIter.hasNext()) {
      const batchFolder = batchIter.next();
      const batchFolderId = batchFolder.getId();
      const batchName = batchFolder.getName();

      // Sync to event album
      const evResult = syncBatchFolderToAlbum(eventAlbumRecord.albumId, batchFolderId);
      const evSynced = evResult.data?.synced ?? 0;
      totalSynced += evSynced;
      if (evResult.data?.errors.length) {
        errors.push(
          ...evResult.data.errors.map((e) => `[${clubName}/${batchName}/event] ${e}`)
        );
      }

      // Sync to club album
      const clResult = syncBatchFolderToAlbum(clubAlbumRecord.albumId, batchFolderId);
      const clSynced = clResult.data?.synced ?? 0;
      clubSynced += clSynced;
      if (clResult.data?.errors.length) {
        errors.push(
          ...clResult.data.errors.map((e) => `[${clubName}/${batchName}/club] ${e}`)
        );
      }
    }

    clubsSynced.push({ clubName, clubAlbumId: clubAlbumRecord.albumId, synced: clubSynced });
  }

  // Persist sync stats for the event album
  const now = nowIsoTimestamp();
  updateAlbumSyncStats(eventAlbumRecord.albumId, now, totalSynced);

  Logger.log(
    `[PhotosService] syncEventToAlbums: event="${event.eventName}", ` +
    `clubs=${clubsSynced.length}, totalSynced=${totalSynced}, errors=${errors.length}`
  );

  return {
    status: ResultStatus.SUCCESS,
    message:
      `Synced ${totalSynced} photo(s) across ${clubsSynced.length} club(s) ` +
      `for "${event.eventName}"`,
    data: {
      eventId:      event.eventId,
      eventAlbumId: eventAlbumRecord.albumId,
      clubsSynced,
      totalSynced,
      errors,
    },
  };
}

// ─── Backfill ─────────────────────────────────────────────────────────────────

export interface BackfillResult {
  eventsProcessed: number;
  albumsCreated:   number;
  totalSynced:     number;
  errors:          string[];
}

/**
 * Backfills Google Photos albums for every event in the Events sheet.
 *
 * For each event:
 *   1. Creates the master event album (if missing)
 *   2. Walks every club folder in Drive
 *   3. Creates a club album per event+club pair (if missing)
 *   4. Syncs all batch photos to both albums
 *
 * This function is idempotent but NOT incremental — photos already synced
 * will be added again (Google Photos may deduplicate by content hash).
 * For large archives, schedule multiple runs if the 6-minute GAS limit is hit.
 *
 * @param clubDisplayNames  Optional map of normalizedName → displayName.
 *                          Pass the result of listActiveClubs() converted to a map.
 */
export function backfillAllAlbums(
  clubDisplayNames?: Record<string, string>
): ServiceResult<BackfillResult> {
  const config = getConfig();

  // Load all events directly (avoid importing eventService to prevent circular deps)
  let eventRows: unknown[][];
  try {
    eventRows = getAllRows(config.SHEET_NAMES.EVENTS);
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Cannot read Events sheet: ${String(err)}`,
    };
  }

  const events = eventRows
    .map(toEventRecord)
    .filter((r): r is NonNullable<ReturnType<typeof toEventRecord>> => r !== null);

  let eventsProcessed = 0;
  let albumsCreatedBefore = loadAlbums().length;
  let totalSynced = 0;
  const errors: string[] = [];

  for (const event of events) {
    Logger.log(
      `[PhotosService] Backfill: processing "${event.eventName}" (${event.eventId})`
    );

    const result = syncEventToAlbums(
      {
        eventId:       event.eventId,
        eventName:     event.eventName,
        eventDate:     event.eventDate,
        driveFolderId: event.driveFolderId,
      },
      clubDisplayNames
    );

    eventsProcessed++;

    if (result.status !== ResultStatus.SUCCESS || !result.data) {
      errors.push(`Event "${event.eventName}": ${result.message}`);
      continue;
    }

    totalSynced += result.data.totalSynced;
    if (result.data.errors.length) {
      errors.push(...result.data.errors.map((e) => `[${event.eventName}] ${e}`));
    }
  }

  const albumsCreatedAfter = loadAlbums().length;
  const albumsCreated = albumsCreatedAfter - albumsCreatedBefore;

  Logger.log(
    `[PhotosService] Backfill complete: events=${eventsProcessed}, ` +
    `albumsCreated=${albumsCreated}, totalSynced=${totalSynced}, errors=${errors.length}`
  );

  return {
    status: ResultStatus.SUCCESS,
    message:
      `Backfill complete: ${eventsProcessed} event(s) processed, ` +
      `${albumsCreated} album(s) created, ${totalSynced} photo(s) synced, ` +
      `${errors.length} error(s)`,
    data: { eventsProcessed, albumsCreated, totalSynced, errors },
  };
}
