/**
 * photosApiClient.ts — Low-level Google Photos Library API HTTP helpers.
 *
 * Extracted from photosService.ts (§1.1 god-file split) so that HTTP/auth
 * concerns live in isolation from sheet I/O and sync orchestration.
 *
 * This module never reads or writes sheets; every function is pure HTTP or
 * pure computation over the Photos Library REST API.
 */

import { ResultStatus, PhotoMimeType } from '../types/enums';
import { ServiceResult } from '../types/responses';

/* global ScriptApp, UrlFetchApp */

// ─── Constants ────────────────────────────────────────────────────────────────

export const PHOTOS_API_BASE = 'https://photoslibrary.googleapis.com/v1';

/**
 * MIME types eligible for Photos upload.
 * Single source of truth: derived from PhotoMimeType enum in types/enums.ts.
 * The equivalent list in cloud-run/main.py (PILLOW_MIMES + HEIC_MIMES) must be
 * kept in sync manually when this enum changes.
 */
export const PHOTO_MIME_TYPES: ReadonlySet<string> = new Set(Object.values(PhotoMimeType));

// ─── Auth ─────────────────────────────────────────────────────────────────────

export function getAuthToken(): string {
  return ScriptApp.getOAuthToken();
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

/**
 * Makes a POST request to the Photos Library API with a JSON body.
 * Returns parsed JSON data on 2xx, or an error description on failure.
 */
export function photosPost(
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
export function photosUploadBytes(
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

// ─── Batch media-item operations ──────────────────────────────────────────────

/**
 * Maximum items per Photos API batch operation.
 * Both /mediaItems:batchCreate and /albums/{id}:batchAddMediaItems cap at 50.
 */
export const PHOTOS_BATCH_LIMIT = 50;

/**
 * One item to create via /mediaItems:batchCreate.
 * The uploadToken is what /uploads returned earlier; description shows in the
 * media item details panel in Photos.
 */
export interface BatchCreateItem {
  uploadToken: string;
  fileName:    string;
}

/**
 * Result of one batchCreate item: either a new mediaItem on success, or an
 * error string. Order matches the input items array exactly so callers can
 * pair them back up with their source files.
 */
export interface BatchCreateResultItem {
  fileName:    string;
  mediaItemId: string;   // empty if errored
  error:       string;   // empty if succeeded
}

/**
 * Creates media items in batches of up to PHOTOS_BATCH_LIMIT per HTTP call.
 *
 * Returns one result entry per input item, in the same order. A 200 response
 * may still contain per-item errors (e.g. an expired upload token); those are
 * surfaced via the per-item `error` field rather than aborting the batch.
 *
 * @param albumId  The album to attach the media items to.
 * @param items    One entry per file (uploadToken + fileName).
 */
export function photosBatchCreateMediaItems(
  albumId: string,
  items: BatchCreateItem[]
): BatchCreateResultItem[] {
  const out: BatchCreateResultItem[] = new Array(items.length);

  for (let chunkStart = 0; chunkStart < items.length; chunkStart += PHOTOS_BATCH_LIMIT) {
    const chunk = items.slice(chunkStart, chunkStart + PHOTOS_BATCH_LIMIT);
    const newMediaItems = chunk.map((it) => ({
      description:     it.fileName,
      simpleMediaItem: { uploadToken: it.uploadToken, fileName: it.fileName },
    }));

    const resp = photosPost('/mediaItems:batchCreate', { albumId, newMediaItems });
    if (!resp.ok || !resp.data) {
      // Whole-chunk failure — annotate every item in this chunk.
      for (let i = 0; i < chunk.length; i++) {
        out[chunkStart + i] = {
          fileName:    chunk[i].fileName,
          mediaItemId: '',
          error:       resp.error ?? 'mediaItems:batchCreate failed',
        };
      }
      continue;
    }

    const data = resp.data as {
      newMediaItemResults?: Array<{
        status?:    { message?: string; code?: number };
        mediaItem?: { id: string };
      }>;
    };
    const results = data.newMediaItemResults ?? [];

    for (let i = 0; i < chunk.length; i++) {
      const r = results[i];
      if (r?.mediaItem?.id) {
        out[chunkStart + i] = {
          fileName:    chunk[i].fileName,
          mediaItemId: r.mediaItem.id,
          error:       '',
        };
      } else {
        out[chunkStart + i] = {
          fileName:    chunk[i].fileName,
          mediaItemId: '',
          error:       r?.status?.message ?? 'Unexpected per-item response',
        };
      }
    }
  }

  return out;
}

/**
 * Adds existing media items to an album in batches of up to PHOTOS_BATCH_LIMIT.
 *
 * This is the cheap second-album path: rather than re-uploading bytes, we
 * reuse the mediaItemIds we got back from photosBatchCreateMediaItems. The
 * underlying endpoint /albums/{id}:batchAddMediaItems is much faster than
 * /uploads + /mediaItems:batchCreate.
 *
 * Returns the indices (into mediaItemIds) of items that failed, plus an error
 * string keyed to the chunk that failed. The success path returns an empty
 * failures array.
 */
export interface BatchAddFailure {
  index:    number;
  message:  string;
}

export function photosBatchAddMediaItemsToAlbum(
  albumId: string,
  mediaItemIds: string[]
): { failures: BatchAddFailure[] } {
  const failures: BatchAddFailure[] = [];

  for (let chunkStart = 0; chunkStart < mediaItemIds.length; chunkStart += PHOTOS_BATCH_LIMIT) {
    const chunk = mediaItemIds.slice(chunkStart, chunkStart + PHOTOS_BATCH_LIMIT);
    const resp = photosPost(`/albums/${encodeURIComponent(albumId)}:batchAddMediaItems`, {
      mediaItemIds: chunk,
    });
    if (!resp.ok) {
      // Whole-chunk failure — flag every item in the chunk.
      for (let i = 0; i < chunk.length; i++) {
        failures.push({
          index:   chunkStart + i,
          message: resp.error ?? 'batchAddMediaItems failed',
        });
      }
    }
  }

  return { failures };
}

// ─── Album listing ────────────────────────────────────────────────────────────

/**
 * Subset of mediaItem fields we care about when listing an album.
 * The Photos API returns more fields; we strip them out at the boundary.
 */
export interface ListedMediaItem {
  id:           string;
  filename:     string;
  productUrl:   string;
  creationTime: string;  // ISO-8601 from mediaMetadata.creationTime; '' if missing
}

/**
 * Lists every media item in the given album using POST /mediaItems:search.
 * Paginates internally — Photos API caps pageSize at 100.
 *
 * Returns ALL items in one shot. Caller should be aware this can be slow
 * (one HTTP round-trip per 100 items) and may approach the GAS 6-minute
 * execution limit on very large albums.
 */
export function photosListAlbumMediaItems(
  albumId: string
): { ok: boolean; items?: ListedMediaItem[]; error?: string } {
  const out: ListedMediaItem[] = [];
  let pageToken: string | undefined = undefined;
  let safetyPages = 0;
  const MAX_PAGES = 200; // 200 × 100 = 20,000 items hard cap

  do {
    const body: { albumId: string; pageSize: number; pageToken?: string } = {
      albumId,
      pageSize: 100,
    };
    if (pageToken) body.pageToken = pageToken;

    const resp = photosPost('/mediaItems:search', body);
    if (!resp.ok || !resp.data) {
      return { ok: false, error: resp.error ?? 'mediaItems:search failed' };
    }

    const data = resp.data as {
      mediaItems?: Array<{
        id?:            string;
        filename?:      string;
        productUrl?:    string;
        mediaMetadata?: { creationTime?: string };
      }>;
      nextPageToken?: string;
    };

    for (const m of data.mediaItems ?? []) {
      if (!m.id) continue;
      out.push({
        id:           m.id,
        filename:     m.filename     ?? '',
        productUrl:   m.productUrl   ?? '',
        creationTime: m.mediaMetadata?.creationTime ?? '',
      });
    }

    pageToken = data.nextPageToken;
    safetyPages++;
  } while (pageToken && safetyPages < MAX_PAGES);

  return { ok: true, items: out };
}

// ─── Album creation ───────────────────────────────────────────────────────────

export interface GoogleAlbumCreationResult {
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
export function createGoogleAlbum(
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
