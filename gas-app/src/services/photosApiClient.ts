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
