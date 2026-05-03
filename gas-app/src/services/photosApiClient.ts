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
 *
 * `status` mirrors photosGet — populated when an HTTP response was actually
 * received, 0 when the fetch itself threw.
 */
export function photosPost(
  endpoint: string,
  body: object
): { ok: boolean; data?: unknown; error?: string; status: number } {
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
      return { ok: false, error: `HTTP ${code}: ${text.slice(0, 300)}`, status: code };
    }
    return { ok: true, data: JSON.parse(text), status: code };
  } catch (err) {
    return { ok: false, error: String(err), status: 0 };
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

// ─── Album sharing-status check ───────────────────────────────────────────────

/**
 * Makes a GET request to the Photos Library API.
 * Returns parsed JSON data on 2xx, or an error description on failure.
 *
 * The HTTP status code is always populated when the request actually
 * round-tripped (status > 0); callers use it to distinguish 403/404
 * "not visible to this app" from 5xx "transient backend error". A status
 * of 0 means the fetch threw before we got a response.
 */
export function photosGet(
  endpoint: string
): { ok: boolean; data?: unknown; error?: string; status: number } {
  try {
    const response = UrlFetchApp.fetch(`${PHOTOS_API_BASE}${endpoint}`, {
      method: 'get',
      headers: {
        Authorization: `Bearer ${getAuthToken()}`,
      },
      muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    const text = response.getContentText();

    if (code < 200 || code >= 300) {
      return { ok: false, error: `HTTP ${code}: ${text.slice(0, 300)}`, status: code };
    }
    return { ok: true, data: JSON.parse(text), status: code };
  } catch (err) {
    return { ok: false, error: String(err), status: 0 };
  }
}

export interface AlbumShareInfo {
  /** True if the album has been shared (shareInfo present in API response). */
  isShared: boolean;
  /** The shareable link, if available from the API. May be empty. */
  shareableUrl: string;
}

/**
 * Coarse-grained outcome bucket for `albums.get`. Distinguishes the cases
 * the public-sheet rebuild and the reconciliation report care about:
 *
 *   'ok'           — 2xx; album exists and is visible to this app.
 *   'denied'       — 403/404. With our scopes (appendonly +
 *                    edit.appcreateddata) Google returns 403/404 not just
 *                    for deleted albums but also for albums the app didn't
 *                    create (legacy albums, manually-created albums,
 *                    albums migrated from a different OAuth client).
 *                    Callers should NOT label these as "Missing"; the
 *                    album probably still exists, we just can't see it.
 *   'server_error' — 5xx; usually transient. Retry next rebuild.
 *   'network'      — fetch threw, no HTTP response at all.
 *   'other'        — any other non-2xx status we didn't categorize.
 */
export type AlbumAccessibility =
  | 'ok'
  | 'denied'
  | 'server_error'
  | 'network'
  | 'other';

/**
 * Richer view of an album returned by `albums.get`. Includes everything
 * AlbumShareInfo carries plus the live media-item count and whether the
 * album was actually found (used by reconciliation to detect dangling
 * sheet rows whose albumId no longer exists in Google Photos).
 */
export interface AlbumDetails extends AlbumShareInfo {
  /** True when the API returned 200 — i.e. accessibility === 'ok'. */
  found: boolean;
  /** Why we couldn't see the album, if found is false. See AlbumAccessibility. */
  accessibility: AlbumAccessibility;
  /** Last HTTP status returned (or 0 for network errors). */
  httpStatus: number;
  /** Live count from mediaMetadata (server-side), or null on error. */
  mediaItemsCount: number | null;
  /** Title as currently stored in Google Photos; empty on error. */
  title: string;
  /** Web URL viewable by the album owner; empty on error. */
  productUrl: string;
}

/**
 * Fetches an album from the Photos Library API and returns its sharing status.
 *
 * The `albums.get` endpoint still works post-March-2025 deprecation; only
 * the albums:share write endpoint was removed. The `shareInfo` field is
 * present in the response only when the album has been shared manually by
 * the owner from photos.google.com.
 *
 * Returns { isShared: false } on any API error so callers conservatively
 * treat fetch failures as "not yet confirmed public".
 */
export function getGoogleAlbumShareInfo(
  albumId: string
): AlbumShareInfo {
  const details = getGoogleAlbumDetails(albumId);
  return { isShared: details.isShared, shareableUrl: details.shareableUrl };
}

/**
 * Single-call album fetch that returns share status, live media-items
 * count, and whether the album exists at all. Public-sheet rebuild and
 * reconciliation both call this so they only pay one HTTP round-trip per
 * album to learn everything they need.
 *
 * mediaItemsCount comes from the API as a string; we coerce to number and
 * surface null when the album is missing or the field is absent (older
 * albums occasionally omit it).
 */
export function getGoogleAlbumDetails(
  albumId: string
): AlbumDetails {
  const result = photosGet(`/albums/${encodeURIComponent(albumId)}`);
  if (!result.ok || !result.data) {
    return {
      isShared: false,
      shareableUrl: '',
      found: false,
      accessibility: classifyAccessibility(result.status),
      httpStatus: result.status,
      mediaItemsCount: null,
      title: '',
      productUrl: '',
    };
  }

  const album = result.data as {
    id?: string;
    title?: string;
    productUrl?: string;
    mediaItemsCount?: string | number;
    shareInfo?: { shareableUrl?: string };
  };

  const rawCount = album.mediaItemsCount;
  let mediaItemsCount: number | null = null;
  if (typeof rawCount === 'number' && Number.isFinite(rawCount)) {
    mediaItemsCount = rawCount;
  } else if (typeof rawCount === 'string' && rawCount.trim() !== '') {
    const parsed = Number(rawCount);
    mediaItemsCount = Number.isFinite(parsed) ? parsed : null;
  }

  return {
    isShared:        Boolean(album.shareInfo),
    shareableUrl:    album.shareInfo?.shareableUrl ?? '',
    found:           true,
    accessibility:   'ok',
    httpStatus:      result.status,
    mediaItemsCount,
    title:           album.title    ?? '',
    productUrl:      album.productUrl ?? '',
  };
}

/**
 * Maps an HTTP status code into the AlbumAccessibility bucket. 403/404 both
 * collapse into 'denied' because Google deliberately conflates "not found"
 * with "you don't have permission" for security reasons — we can't reliably
 * tell whether an album was deleted or just isn't visible to this OAuth
 * client.
 */
function classifyAccessibility(status: number): AlbumAccessibility {
  if (status === 403 || status === 404) return 'denied';
  if (status >= 500 && status < 600) return 'server_error';
  if (status === 0) return 'network';
  return 'other';
}

// ─── Owner-album listing (reconciliation) ────────────────────────────────────

/**
 * One entry returned by `photosListOwnedAlbums`. Mirrors the subset of fields
 * the reconciliation comparator needs; we strip the rest at the boundary.
 */
export interface ListedAlbum {
  id:              string;
  title:           string;
  productUrl:      string;
  mediaItemsCount: number | null;
  isShared:        boolean;
}

/**
 * Lists every album that this OAuth client owns (i.e. created via the
 * appendonly / edit.appcreateddata scope).
 *
 * After the March 2025 Library API deprecation, GET /albums returns only the
 * albums the calling app has access to — that's exactly the set we want to
 * reconcile against the Photo_Albums sheet. Albums the user created manually
 * in photos.google.com are intentionally not returned and would not appear
 * here even with broader scopes.
 *
 * Paginates internally; the API caps pageSize at 50.
 */
export function photosListOwnedAlbums(): {
  ok: boolean;
  items?: ListedAlbum[];
  error?: string;
} {
  const out: ListedAlbum[] = [];
  let pageToken: string | undefined = undefined;
  let safetyPages = 0;
  const MAX_PAGES = 100; // 100 × 50 = 5,000 albums hard cap

  do {
    const qs = new URLSearchParams();
    qs.set('pageSize', '50');
    if (pageToken) qs.set('pageToken', pageToken);

    const resp = photosGet(`/albums?${qs.toString()}`);
    if (!resp.ok || !resp.data) {
      return { ok: false, error: resp.error ?? 'albums.list failed' };
    }

    const data = resp.data as {
      albums?: Array<{
        id?:              string;
        title?:           string;
        productUrl?:      string;
        mediaItemsCount?: string | number;
        shareInfo?:       { shareableUrl?: string };
      }>;
      nextPageToken?: string;
    };

    for (const a of data.albums ?? []) {
      if (!a.id) continue;
      const raw = a.mediaItemsCount;
      let count: number | null = null;
      if (typeof raw === 'number' && Number.isFinite(raw)) count = raw;
      else if (typeof raw === 'string' && raw.trim() !== '') {
        const parsed = Number(raw);
        count = Number.isFinite(parsed) ? parsed : null;
      }
      out.push({
        id:              a.id,
        title:           a.title      ?? '',
        productUrl:      a.productUrl ?? '',
        mediaItemsCount: count,
        isShared:        Boolean(a.shareInfo),
      });
    }

    pageToken = data.nextPageToken;
    safetyPages++;
  } while (pageToken && safetyPages < MAX_PAGES);

  return { ok: true, items: out };
}
