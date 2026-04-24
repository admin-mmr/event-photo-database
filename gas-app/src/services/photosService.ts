import { ResultStatus } from '../types/enums';
import { PhotosAlbumRecord, PhotosFileRecord } from '../types/models';
import { ServiceResult } from '../types/responses';
import { getConfig } from '../config/constants';
import { getAllRows, appendRow, updateRow } from './sheetService';
import {
  toPhotosAlbumRecord,
  fromPhotosAlbumRecord,
  toEventRecord,
  toPhotosFileRecord,
  fromPhotosFileRecord,
} from '../utils/sheetMapper';
import { nowIsoTimestamp } from '../utils/dateFormatter';
import {
  incrementJobCounters,
  isCancelRequested,
  updateJob,
} from './syncJobService';

/* global ScriptApp, UrlFetchApp, DriveApp, Logger */

/**
 * PhotosService — Google Photos Library API integration.
 *
 * Manages the lifecycle of Google Photos albums that mirror the Drive folder
 * hierarchy.  For each event a "master" album is created containing all clubs'
 * photos; for each event+club combination a narrower "club" album is created.
 *
 * Album metadata is persisted in the "Photo_Albums" Google Sheet so that
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

// ─── Photo_Albums sheet helpers ──────────────────────────────────────────────

function loadAlbums(): PhotosAlbumRecord[] {
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

/**
 * Returns all album records in the Photo_Albums sheet.
 * Used by the admin Photos Overview page to render the full album index.
 */
export function listAllAlbums(): PhotosAlbumRecord[] {
  return loadAlbums();
}

function saveAlbum(record: PhotosAlbumRecord): void {
  const config = getConfig();
  appendRow(config.SHEET_NAMES.PHOTO_ALBUMS, fromPhotosAlbumRecord(record));
}

// ─── Photo_Files helpers ─────────────────────────────────────────────────────

/**
 * Loads all rows from the Photo_Files sheet and maps them to typed records.
 * Rows that fail validation are silently dropped.
 */
function loadFileRecords(): PhotosFileRecord[] {
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

/**
 * Appends a new row to Photo_Files after a successful sync.
 */
function saveFileRecord(record: PhotosFileRecord): void {
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

/**
 * Updates the lastSyncAt and syncedFileCount columns for an existing album row.
 * Matches by albumId (column 0).
 *
 * @param preloadedRows  Optional pre-loaded Photo_Albums rows (avoids an extra
 *                       sheet read when the caller already holds them). Pass
 *                       null/undefined to trigger a fresh read.
 */
function updateAlbumSyncStats(
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

// ─── Album creation ───────────────────────────────────────────────────────────

interface GoogleAlbumCreationResult {
  albumId: string;
  productUrl: string;
  shareableUrl: string;
}

/**
 * Creates a new Google Photos album.
 * Returns the album ID and product URL.
 *
 * Sharing note (post March 2025):
 *   The Library API's album-sharing endpoints (albums:share, sharedAlbums.*)
 *   and the `photoslibrary.sharing` OAuth scope were deprecated by Google on
 *   March 31, 2025. Calls to /albums/{id}:share now return 403
 *   PERMISSION_DENIED, so we no longer attempt to auto-share albums here.
 *
 *   For viewers outside the owner's account, admins should share the album
 *   manually from photos.google.com (three-dot menu → "Share"). The
 *   shareableUrl field in the Photo_Albums sheet therefore now falls back to
 *   the productUrl (visible only to the deploying/owner account until
 *   manually shared).
 *
 *   Reference: https://developers.google.com/photos/support/updates
 */
function createGoogleAlbum(
  title: string
): ServiceResult<GoogleAlbumCreationResult> {
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

  // Library API sharing is deprecated — productUrl is the only URL we can
  // surface automatically. Admins must share manually in Google Photos if they
  // need a public viewer link.
  const shareableUrl = productUrl;

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
 *
 * @param preloadedAlbums  Optional pre-loaded Photo_Albums records. When provided
 *                         the function skips the sheet read and searches this list
 *                         instead (avoids redundant reads inside hot-path callers
 *                         like syncBatchToAlbums that already hold the full list).
 */
export function ensureEventAlbum(
  eventId: string,
  eventName: string,
  eventDate: string,
  preloadedAlbums?: PhotosAlbumRecord[] | null
): ServiceResult<PhotosAlbumRecord> {
  const albums = preloadedAlbums ?? loadAlbums();
  const existing = albums.find((a) => a.albumType === 'event' && a.eventId === eventId) ?? null;
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
 *
 * @param preloadedAlbums  See ensureEventAlbum for semantics.
 */
export function ensureClubAlbum(
  eventId: string,
  eventName: string,
  eventDate: string,
  clubName: string,
  clubDisplayName: string,
  preloadedAlbums?: PhotosAlbumRecord[] | null
): ServiceResult<PhotosAlbumRecord> {
  const albums = preloadedAlbums ?? loadAlbums();
  const existing =
    albums.find(
      (a) => a.albumType === 'club' && a.eventId === eventId && a.clubName === clubName
    ) ?? null;
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
  skipped: number;     // wrong MIME type
  deduplicated: number; // already in Photo_Files for this album → skipped
  errors: string[];
}

/**
 * Syncs all eligible photos in a single Drive batch folder (Layer 3) to the
 * given Google Photos album.
 *
 * Deduplication: before uploading each file, checks the Photo_Files sheet for
 * an existing (driveFileId, albumId) record. Files already synced are counted
 * in `deduplicated` and skipped — this makes every sync idempotent and safe to
 * call multiple times without creating duplicate Photos media items.
 *
 * On successful upload, writes a row to Photo_Files recording the Drive→Photos
 * mapping so future syncs can detect it.
 *
 * Only JPEG, PNG, and HEIC files are uploaded; all other types are skipped.
 * Per-file errors are collected and returned rather than aborting the whole sync.
 *
 * @param albumId       Google Photos album ID
 * @param albumType     'event' or 'club' — stored in the file record
 * @param eventId       UUID of the event — stored in the file record
 * @param clubName      Normalized club name (empty string for event albums)
 * @param batchFolderId Drive ID of the Layer-3 batch folder
 * @param existingSyncedKeys Pre-loaded set of "driveFileId|albumId" strings to
 *                      avoid re-reading Photo_Files once per folder iteration.
 *                      Pass an empty Set to trigger a fresh sheet read.
 * @param jobId         Optional SyncJob id — when provided, per-photo counters
 *                      are pushed to the job record so the admin UI can show a
 *                      live progress bar. Cancellation is also checked between
 *                      files; a cancelled run returns early with what it has.
 * @param progressStep  Human-readable label for the job's `currentStep` while
 *                      this batch runs (e.g. "'Misty Mountain' / batch 2").
 */
export function syncBatchFolderToAlbum(
  albumId: string,
  albumType: 'event' | 'club',
  eventId: string,
  clubName: string,
  batchFolderId: string,
  existingSyncedKeys: Set<string>,
  jobId?: string,
  progressStep?: string
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
  let synced       = 0;
  let skipped      = 0;
  let deduplicated = 0;
  const errors: string[] = [];
  const now = nowIsoTimestamp();

  // Emit the folder-level step once, up front — avoids spamming the job record
  // with an update per file while still giving the UI a human-readable label.
  if (jobId && progressStep) {
    updateJob(jobId, { currentStep: progressStep });
  }

  while (iter.hasNext()) {
    // Cooperative cancellation: honour Cancel clicks between files so we never
    // cut off mid-upload (which could leave a half-written mediaItem).
    if (jobId && isCancelRequested(jobId)) {
      return {
        status: ResultStatus.SUCCESS,
        message:
          `Cancelled after syncing ${synced} file(s) ` +
          `(${skipped} skipped, ${deduplicated} deduplicated)`,
        data: { synced, skipped, deduplicated, errors },
      };
    }

    const file     = iter.next();
    const mimeType = file.getMimeType();

    // Skip non-photo files
    if (!PHOTO_MIME_TYPES.includes(mimeType)) {
      skipped++;
      if (jobId) incrementJobCounters(jobId, { photosSkipped: 1 });
      continue;
    }

    const driveFileId = file.getId();
    const dedupeKey   = `${driveFileId}|${albumId}`;

    // Skip if already recorded in Photo_Files for this album
    if (existingSyncedKeys.has(dedupeKey)) {
      deduplicated++;
      if (jobId) incrementJobCounters(jobId, { photosDeduplicated: 1 });
      Logger.log(`[PhotosService] Dedup skip: "${file.getName()}" already in album ${albumId}`);
      continue;
    }

    const result = addDriveFileToAlbum(albumId, driveFileId, file.getName(), mimeType);
    if (result.status === ResultStatus.SUCCESS && result.data) {
      synced++;
      // Persist the Drive → Photos mapping so future syncs can detect this file
      const fileRecord: PhotosFileRecord = {
        driveFileId,
        mediaItemId: result.data.mediaItemId,
        albumId,
        albumType,
        eventId,
        clubName,
        fileName: file.getName(),
        syncedAt: now,
      };
      saveFileRecord(fileRecord);
      // Add to in-memory set so duplicate batches within the same run are caught
      existingSyncedKeys.add(dedupeKey);
      // Bump the progress counters so the UI shows movement in near-real-time.
      if (jobId) {
        incrementJobCounters(
          jobId,
          { photosSynced: 1 },
          progressStep
            ? `${progressStep} — ${synced} uploaded`
            : undefined
        );
      }
    } else {
      errors.push(`${file.getName()}: ${result.message}`);
      Logger.log(`[PhotosService] syncBatchFolderToAlbum error: ${result.message}`);
      if (jobId) {
        updateJob(jobId, { errors: [`${file.getName()}: ${result.message}`] });
      }
    }
  }

  return {
    status: ResultStatus.SUCCESS,
    message:
      `Synced ${synced} file(s) ` +
      `(${skipped} skipped, ${deduplicated} deduplicated, ${errors.length} error(s))`,
    data: { synced, skipped, deduplicated, errors },
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
  const config = getConfig();

  // ── Pre-load Photo_Albums ONCE (§3.1 performance fix) ────────────────────────
  // Threads the loaded rows through ensureEventAlbum, ensureClubAlbum, and
  // updateAlbumSyncStats so the sheet is read at most once per call instead of
  // four times (2 × loadAlbums + 2 × getAllRows in updateAlbumSyncStats).
  const albumRows = getAllRows(config.SHEET_NAMES.PHOTO_ALBUMS);
  const albums = albumRows
    .map(toPhotosAlbumRecord)
    .filter((r): r is PhotosAlbumRecord => r !== null);

  // Ensure event album (lookup uses pre-loaded list; creates via API if missing)
  const eventAlbumResult = ensureEventAlbum(eventId, eventName, eventDate, albums);
  if (eventAlbumResult.status !== ResultStatus.SUCCESS || !eventAlbumResult.data) {
    return {
      status: ResultStatus.ERROR,
      message: `Cannot ensure event album: ${eventAlbumResult.message}`,
    };
  }
  const eventAlbumRecord = eventAlbumResult.data;
  // If the album was just created it won't be in albumRows yet — add it so
  // updateAlbumSyncStats can find the row by albumId.
  if (!albumRows.some((r) => String(r[0] ?? '').trim() === eventAlbumRecord.albumId)) {
    albumRows.push(fromPhotosAlbumRecord(eventAlbumRecord));
    albums.push(eventAlbumRecord);
  }

  // Ensure club album (lookup uses same pre-loaded list, now including any
  // event album that was just created above)
  const clubAlbumResult = ensureClubAlbum(
    eventId, eventName, eventDate, clubName, clubDisplayName, albums
  );
  if (clubAlbumResult.status !== ResultStatus.SUCCESS || !clubAlbumResult.data) {
    return {
      status: ResultStatus.ERROR,
      message: `Cannot ensure club album: ${clubAlbumResult.message}`,
    };
  }
  const clubAlbumRecord = clubAlbumResult.data;
  if (!albumRows.some((r) => String(r[0] ?? '').trim() === clubAlbumRecord.albumId)) {
    albumRows.push(fromPhotosAlbumRecord(clubAlbumRecord));
  }

  // ── Build dedup key set from Photo_Files ONCE for both album syncs ───────────
  // Key format: "driveFileId|albumId"
  const allFileRecords = loadFileRecords();
  const syncedKeys = new Set(allFileRecords.map((r) => `${r.driveFileId}|${r.albumId}`));

  // Sync batch to event album
  const eventSyncResult = syncBatchFolderToAlbum(
    eventAlbumRecord.albumId, 'event', eventId, '', batchFolderId, syncedKeys
  );
  const eventSynced = eventSyncResult.data?.synced ?? 0;
  if (eventSyncResult.data?.errors.length) {
    errors.push(...eventSyncResult.data.errors.map((e) => `[event] ${e}`));
  }

  // Sync batch to club album (syncedKeys is shared so dedup also works across albums)
  const clubSyncResult = syncBatchFolderToAlbum(
    clubAlbumRecord.albumId, 'club', eventId, clubName, batchFolderId, syncedKeys
  );
  const clubSynced = clubSyncResult.data?.synced ?? 0;
  if (clubSyncResult.data?.errors.length) {
    errors.push(...clubSyncResult.data.errors.map((e) => `[club:${clubName}] ${e}`));
  }

  // ── Persist updated sync stats using pre-loaded rows (no extra sheet reads) ──
  const now = nowIsoTimestamp();
  updateAlbumSyncStats(
    eventAlbumRecord.albumId,
    now,
    eventAlbumRecord.syncedFileCount + eventSynced,
    albumRows
  );
  updateAlbumSyncStats(
    clubAlbumRecord.albumId,
    now,
    clubAlbumRecord.syncedFileCount + clubSynced,
    albumRows
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
 * @param jobId   Optional SyncJob id — when provided, album-creation and
 *                per-photo counters are pushed to the job record so the admin
 *                UI can render a live progress bar. Cancellation is honoured
 *                between clubs and between files.
 */
export function syncEventToAlbums(
  event: EventInfo,
  clubDisplayNames?: Record<string, string>,
  jobId?: string
): ServiceResult<SyncEventResult> {
  const errors: string[] = [];
  const clubsSynced: ClubSyncSummary[] = [];
  let totalSynced = 0;

  // Ensure event-level album
  if (jobId) {
    updateJob(jobId, { currentStep: `Creating event album for "${event.eventName}"…` });
  }
  const eventAlbumResult = ensureEventAlbum(event.eventId, event.eventName, event.eventDate);
  if (eventAlbumResult.status !== ResultStatus.SUCCESS || !eventAlbumResult.data) {
    return {
      status: ResultStatus.ERROR,
      message: `Cannot ensure event album for "${event.eventName}": ${eventAlbumResult.message}`,
    };
  }
  const eventAlbumRecord = eventAlbumResult.data;
  // If the album was just created in this call its lastSyncAt will be empty.
  if (jobId && !eventAlbumRecord.lastSyncAt && eventAlbumRecord.syncedFileCount === 0) {
    incrementJobCounters(jobId, { albumsCreated: 1 });
  }

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

  // Build dedup key set once for the entire event sync to avoid re-reading the
  // Photo_Files sheet on every batch folder iteration.
  const allFileRecords = loadFileRecords();
  const syncedKeys = new Set(allFileRecords.map((r) => `${r.driveFileId}|${r.albumId}`));

  // Walk Layer-2 club folders
  const clubIter = eventFolder.getFolders();
  while (clubIter.hasNext()) {
    // Honour cancellation between clubs too — catches the "pressed Cancel
    // during a quiet moment between batches" case.
    if (jobId && isCancelRequested(jobId)) break;

    const clubFolder = clubIter.next();
    const clubName = clubFolder.getName();
    const clubDisplayName =
      clubDisplayNames?.[clubName] ?? clubName.replace(/_/g, ' ');

    // Ensure club album
    if (jobId) {
      updateJob(jobId, { currentStep: `Creating club album for "${clubDisplayName}"…` });
    }
    const clubAlbumResult = ensureClubAlbum(
      event.eventId, event.eventName, event.eventDate,
      clubName, clubDisplayName
    );
    if (clubAlbumResult.status !== ResultStatus.SUCCESS || !clubAlbumResult.data) {
      const msg = `Club "${clubName}": ${clubAlbumResult.message}`;
      errors.push(msg);
      if (jobId) updateJob(jobId, { errors: [msg] });
      continue;
    }
    const clubAlbumRecord = clubAlbumResult.data;
    if (jobId && !clubAlbumRecord.lastSyncAt && clubAlbumRecord.syncedFileCount === 0) {
      incrementJobCounters(jobId, { albumsCreated: 1 });
    }
    let clubSynced = 0;

    // Walk Layer-3 batch folders
    const batchIter = clubFolder.getFolders();
    while (batchIter.hasNext()) {
      if (jobId && isCancelRequested(jobId)) break;

      const batchFolder = batchIter.next();
      const batchFolderId = batchFolder.getId();
      const batchName = batchFolder.getName();

      // Sync to event album (dedup key set is shared and updated in-place)
      const evResult = syncBatchFolderToAlbum(
        eventAlbumRecord.albumId, 'event', event.eventId, '', batchFolderId, syncedKeys,
        jobId, `"${clubDisplayName}" / ${batchName} → event album`
      );
      const evSynced = evResult.data?.synced ?? 0;
      totalSynced += evSynced;
      if (evResult.data?.errors.length) {
        errors.push(
          ...evResult.data.errors.map((e) => `[${clubName}/${batchName}/event] ${e}`)
        );
      }

      // Sync to club album
      const clResult = syncBatchFolderToAlbum(
        clubAlbumRecord.albumId, 'club', event.eventId, clubName, batchFolderId, syncedKeys,
        jobId, `"${clubDisplayName}" / ${batchName} → club album`
      );
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
 * @param jobId  Optional SyncJob id — when provided, the backfill emits
 *               per-event progress (events processed, photos synced, albums
 *               created) to the job record so the admin UI can show a live
 *               progress bar. Cancellation is honoured between events.
 */
export function backfillAllAlbums(
  clubDisplayNames?: Record<string, string>,
  jobId?: string
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

  // Seed the job totals so the UI can draw a meaningful progress bar from step 0
  if (jobId) {
    updateJob(jobId, {
      eventsTotal: events.length,
      currentStep: `Starting backfill of ${events.length} event(s)…`,
    });
  }

  for (const event of events) {
    if (jobId && isCancelRequested(jobId)) break;

    Logger.log(
      `[PhotosService] Backfill: processing "${event.eventName}" (${event.eventId})`
    );
    if (jobId) {
      updateJob(jobId, {
        currentStep: `Event ${eventsProcessed + 1}/${events.length}: "${event.eventName}"`,
      });
    }

    const result = syncEventToAlbums(
      {
        eventId:       event.eventId,
        eventName:     event.eventName,
        eventDate:     event.eventDate,
        driveFolderId: event.driveFolderId,
      },
      clubDisplayNames,
      jobId
    );

    eventsProcessed++;
    if (jobId) incrementJobCounters(jobId, { eventsProcessed: 1 });

    if (result.status !== ResultStatus.SUCCESS || !result.data) {
      const msg = `Event "${event.eventName}": ${result.message}`;
      errors.push(msg);
      if (jobId) updateJob(jobId, { errors: [msg] });
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

// ─── Reconciliation ───────────────────────────────────────────────────────────

/** Per-club breakdown within one event reconciliation result. */
export interface ClubReconciliationResult {
  clubName:     string;
  driveCount:   number;  // Photo files found in Drive (Layer 2 + 3 hierarchy)
  syncedCount:  number;  // Rows in Photo_Files for the club album
  missingCount: number;  // driveCount - syncedCount (negative means orphans in Photos)
  clubAlbumId:  string;  // Empty string if no club album exists yet
}

/** Full reconciliation result for one event. */
export interface EventReconciliationResult {
  eventId:          string;
  eventName:        string;
  eventDate:        string;
  hasEventAlbum:    boolean;
  eventAlbumId:     string;
  driveTotal:       number;  // All photo files across all clubs in Drive
  eventSyncedCount: number;  // Rows in Photo_Files for the event album
  clubs:            ClubReconciliationResult[];
  errors:           string[];
}

/**
 * Reconciles Drive file counts against Photo_Files records for one event.
 *
 * Walk strategy:
 *   - Layer 1 → event Drive folder
 *   - Layer 2 → club sub-folders  (count JPEG/PNG/HEIC files across all batches)
 *   - Compare each club's Drive count vs Photo_Files rows for that club's album
 *
 * This is a READ-ONLY operation — it does not create albums or upload files.
 *
 * @param event            Minimal event info (eventId, eventName, eventDate, driveFolderId)
 * @param albumsByEventId  Pre-loaded map of eventId → PhotosAlbumRecord[] (avoids
 *                         repeated sheet reads when reconciling multiple events)
 * @param fileRecords      Pre-loaded Photo_Files records (avoids repeated sheet reads)
 */
export function reconcileEventPhotos(
  event: EventInfo,
  albumsByEventId: Map<string, PhotosAlbumRecord[]>,
  fileRecords: PhotosFileRecord[]
): EventReconciliationResult {
  const eventAlbums = albumsByEventId.get(event.eventId) ?? [];
  const eventAlbumRecord = eventAlbums.find((a) => a.albumType === 'event') ?? null;
  const errors: string[] = [];
  const clubs: ClubReconciliationResult[] = [];
  let driveTotal = 0;

  // Count Photo_Files rows for the event album
  const eventSyncedCount = eventAlbumRecord
    ? fileRecords.filter((r) => r.albumId === eventAlbumRecord.albumId).length
    : 0;

  // Open event Drive folder
  let eventFolder: GoogleAppsScript.Drive.Folder | null = null;
  try {
    eventFolder = DriveApp.getFolderById(event.driveFolderId);
  } catch (err) {
    errors.push(`Cannot access Drive folder: ${String(err)}`);
  }

  if (eventFolder) {
    // Walk club (Layer-2) folders
    const clubIter = eventFolder.getFolders();
    while (clubIter.hasNext()) {
      const clubFolder = clubIter.next();
      const clubName = clubFolder.getName();

      // Count photo files across all batch (Layer-3) folders
      let clubDriveCount = 0;
      try {
        const batchIter = clubFolder.getFolders();
        while (batchIter.hasNext()) {
          const batchFolder = batchIter.next();
          const fileIter = batchFolder.getFiles();
          while (fileIter.hasNext()) {
            const file = fileIter.next();
            if (PHOTO_MIME_TYPES.includes(file.getMimeType())) {
              clubDriveCount++;
            }
          }
        }
      } catch (err) {
        errors.push(`Club "${clubName}" Drive walk error: ${String(err)}`);
      }

      driveTotal += clubDriveCount;

      // Find club album and count Photo_Files rows
      const clubAlbumRecord = eventAlbums.find(
        (a) => a.albumType === 'club' && a.clubName === clubName
      ) ?? null;
      const clubAlbumId = clubAlbumRecord?.albumId ?? '';
      const syncedCount = clubAlbumId
        ? fileRecords.filter((r) => r.albumId === clubAlbumId).length
        : 0;

      clubs.push({
        clubName,
        driveCount:   clubDriveCount,
        syncedCount,
        missingCount: clubDriveCount - syncedCount,
        clubAlbumId,
      });
    }
  }

  return {
    eventId:          event.eventId,
    eventName:        event.eventName,
    eventDate:        event.eventDate,
    hasEventAlbum:    !!eventAlbumRecord,
    eventAlbumId:     eventAlbumRecord?.albumId ?? '',
    driveTotal,
    eventSyncedCount,
    clubs,
    errors,
  };
}

/** Aggregate result across all events. */
export interface ReconciliationReport {
  events:          EventReconciliationResult[];
  totalDrive:      number;
  totalSynced:     number;
  totalMissing:    number;
  eventsWithGaps:  number;
}

/**
 * Runs reconcileEventPhotos for all events in the Events sheet.
 *
 * Pre-loads Photo_Albums and Photo_Files once to avoid redundant sheet reads
 * during the per-event loop.
 *
 * Admin-only. May be slow for large archives (Drive API calls per folder).
 */
export function reconcileAllPhotos(): ServiceResult<ReconciliationReport> {
  const config = getConfig();

  // Load events
  let eventRows: unknown[][];
  try {
    eventRows = getAllRows(config.SHEET_NAMES.EVENTS);
  } catch (err) {
    return { status: ResultStatus.ERROR, message: `Cannot read Events sheet: ${String(err)}` };
  }
  const events = eventRows
    .map(toEventRecord)
    .filter((r): r is NonNullable<ReturnType<typeof toEventRecord>> => r !== null);

  // Pre-load albums grouped by eventId
  const allAlbums = loadAlbums();
  const albumsByEventId = new Map<string, PhotosAlbumRecord[]>();
  for (const album of allAlbums) {
    const list = albumsByEventId.get(album.eventId) ?? [];
    list.push(album);
    albumsByEventId.set(album.eventId, list);
  }

  // Pre-load file records
  const fileRecords = loadFileRecords();

  const results: EventReconciliationResult[] = [];
  let totalDrive   = 0;
  let totalSynced  = 0;
  let eventsWithGaps = 0;

  for (const event of events) {
    const result = reconcileEventPhotos(
      { eventId: event.eventId, eventName: event.eventName,
        eventDate: event.eventDate, driveFolderId: event.driveFolderId },
      albumsByEventId,
      fileRecords
    );
    results.push(result);
    totalDrive  += result.driveTotal;
    totalSynced += result.eventSyncedCount;
    const eventMissing = result.clubs.reduce((sum, c) => sum + Math.max(0, c.missingCount), 0);
    if (eventMissing > 0 || !result.hasEventAlbum) eventsWithGaps++;
  }

  const totalMissing = totalDrive - totalSynced;

  Logger.log(
    `[PhotosService] Reconciliation: events=${results.length}, ` +
    `drive=${totalDrive}, synced=${totalSynced}, missing=${totalMissing}`
  );

  return {
    status: ResultStatus.SUCCESS,
    message: `Reconciliation complete: ${results.length} event(s), ${totalMissing} photo(s) not yet synced`,
    data: { events: results, totalDrive, totalSynced, totalMissing, eventsWithGaps },
  };
}

// ─── Delete / restore sync ────────────────────────────────────────────────────

/**
 * Calls the Photos Library API to remove a single media item from an album.
 * Returns true on 2xx, false on any error (logged but non-throwing).
 */
function apiRemoveMediaItemFromAlbum(albumId: string, mediaItemId: string): boolean {
  const result = photosPost(
    `/albums/${encodeURIComponent(albumId)}:removeMediaItems`,
    { mediaItemIds: [mediaItemId] },
  );
  if (!result.ok) {
    Logger.log(
      `[PhotosService.apiRemoveMediaItemFromAlbum] Failed to remove mediaItem ` +
      `${mediaItemId} from album ${albumId}: ${result.error}`,
    );
    return false;
  }
  return true;
}

/**
 * Removes all Photo_Files rows whose driveFileId matches from the sheet.
 * Deletes rows in reverse index order so earlier deletions do not shift
 * later indices. Returns the removed records for use in the callers.
 */
function clearPhotoFilesForDriveFile(driveFileId: string): PhotosFileRecord[] {
  const config  = getConfig();
  const name    = config.SHEET_NAMES.PHOTO_FILES;

  const allRows = getAllRows(name);
  const matches: { rowIndex: number; record: PhotosFileRecord }[] = [];

  for (let i = 0; i < allRows.length; i++) {
    const rec = toPhotosFileRecord(allRows[i]);
    if (rec && rec.driveFileId === driveFileId) {
      matches.push({ rowIndex: i, record: rec });
    }
  }

  if (matches.length === 0) return [];

  // Delete from sheet in reverse order (highest index first) to keep indices
  // stable as rows are removed.
  /* global SpreadsheetApp */
  const ss    = SpreadsheetApp.openById(config.SPREADSHEET_ID);
  const sheet = ss.getSheetByName(name);
  if (sheet) {
    for (let i = matches.length - 1; i >= 0; i--) {
      // +2: +1 for 0→1-base, +1 for header row
      sheet.deleteRow(matches[i].rowIndex + 2);
    }
  }

  return matches.map((m) => m.record);
}

/**
 * Removes a Drive file from all Google Photos albums it was synced to, then
 * clears its Photo_Files rows so it is no longer tracked as synced.
 *
 * Called by deleteService after a file is soft-deleted. Non-fatal: Photos API
 * failures are logged but never thrown — the Deleted_Files record has already
 * been written and the Drive file is already trashed.
 *
 * Returns SUCCESS even if no Photo_Files records existed (file was never synced).
 */
export function removeFileFromPhotos(
  driveFileId: string,
): ServiceResult<{ albumsUpdated: number }> {
  try {
    const records = clearPhotoFilesForDriveFile(driveFileId);

    let albumsUpdated = 0;
    for (const record of records) {
      if (record.mediaItemId && record.albumId) {
        if (apiRemoveMediaItemFromAlbum(record.albumId, record.mediaItemId)) {
          albumsUpdated++;
        }
      }
    }

    Logger.log(
      `[PhotosService.removeFileFromPhotos] driveFileId=${driveFileId}: ` +
      `removed from ${albumsUpdated}/${records.length} album(s), cleared ${records.length} Photo_Files row(s)`,
    );

    return {
      status: ResultStatus.SUCCESS,
      message: `Removed from ${albumsUpdated} album(s)`,
      data: { albumsUpdated },
    };
  } catch (err) {
    const msg = String(err);
    Logger.log(`[PhotosService.removeFileFromPhotos] ERROR: ${msg}`);
    return { status: ResultStatus.ERROR, message: msg };
  }
}

/**
 * Clears Photo_Files sync records for a Drive file without calling the Photos
 * API. Used when restoring a file from trash: the old media item IDs in Photos
 * were removed when the file was deleted, so the records are stale. Clearing
 * them allows the next batch sync to re-upload the file as a fresh media item.
 *
 * Returns the number of records cleared.
 */
export function clearSyncRecordsForFile(
  driveFileId: string,
): ServiceResult<{ recordsCleared: number }> {
  try {
    const records = clearPhotoFilesForDriveFile(driveFileId);
    Logger.log(
      `[PhotosService.clearSyncRecordsForFile] driveFileId=${driveFileId}: ` +
      `cleared ${records.length} stale Photo_Files row(s)`,
    );
    return {
      status: ResultStatus.SUCCESS,
      message: `Cleared ${records.length} sync record(s)`,
      data: { recordsCleared: records.length },
    };
  } catch (err) {
    const msg = String(err);
    Logger.log(`[PhotosService.clearSyncRecordsForFile] ERROR: ${msg}`);
    return { status: ResultStatus.ERROR, message: msg };
  }
}
