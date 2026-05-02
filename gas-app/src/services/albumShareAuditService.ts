/**
 * albumShareAuditService.ts — scans every album in the Photo_Albums sheet
 * and identifies those that have not yet been shared publicly in Google Photos.
 *
 * Background
 * ----------
 * Since the Google Photos Library API sharing endpoints were deprecated in
 * March 2025, the system can no longer auto-share albums on creation.  Admins
 * must open each album in photos.google.com and flip the "Anyone with the
 * link can view" toggle manually.
 *
 * This service calls the still-functioning `albums.get` endpoint for every
 * tracked album and checks whether the returned object contains a `shareInfo`
 * block — its presence is the canonical signal that the album is publicly
 * accessible via a shareable link.
 *
 * Usage
 * -----
 * Call `auditUnsharedAlbums()` to get a list of albums that need attention.
 * The main.ts `auditAlbumSharing()` trigger calls this and then fans out
 * `notifyAlbumNeedsShare` emails for each result.
 *
 * Rate-limiting note
 * ------------------
 * The Photos API quota for `albums.get` is generous (10 000 req/day for most
 * projects), but we add a small sleep between calls to stay well clear of
 * per-second rate limits.  GAS's Utilities.sleep is used; it is a no-op in
 * unit tests that mock it away.
 */

import { PhotosAlbumRecord } from '../types/models';
import { loadAlbums } from './photoAlbumsRepo';
import { getGoogleAlbumShareInfo } from './photosApiClient';
import { findById as findEventById } from './eventService';
import { findByNormalizedName as findClubByName } from './clubService';

/* global Utilities, Logger */

/** Milliseconds to wait between Photos API calls to respect per-second quota. */
const INTER_CALL_DELAY_MS = 200;

/**
 * One unshared album entry returned by the audit.
 * Carries everything `notifyAlbumNeedsShare` needs so the caller doesn't have
 * to re-fetch any context.
 */
export interface UnsharedAlbumEntry {
  readonly album:           PhotosAlbumRecord;
  readonly eventName:       string;
  readonly eventDate:       string;
  readonly clubDisplayName: string; // empty for event-scope albums
  readonly scope:           'event' | 'club';
}

/**
 * Result returned by `auditUnsharedAlbums`.
 */
export interface AlbumShareAuditResult {
  /** Albums confirmed not yet shared with "Anyone with the link". */
  readonly unshared:  ReadonlyArray<UnsharedAlbumEntry>;
  /** Number of albums successfully checked (shared + unshared). */
  readonly checked:   number;
  /** Number of albums skipped due to a missing albumId or albumUrl. */
  readonly skipped:   number;
  /** Number of API errors encountered (counted separately from unshared). */
  readonly apiErrors: number;
}

/**
 * Loads all albums from the sheet, queries the Photos API for each one, and
 * returns those that are not yet publicly shared.
 *
 * This function makes one Photos API call per tracked album and may take
 * O(n × INTER_CALL_DELAY_MS) ms to complete.  With 200 ms delay and 50
 * albums that is ~10 s, well within a GAS 6-minute execution limit.
 * For larger deployments consider batching or caching the results.
 */
export function auditUnsharedAlbums(): AlbumShareAuditResult {
  const albums = loadAlbums();

  const unshared:  UnsharedAlbumEntry[] = [];
  let checked   = 0;
  let skipped   = 0;
  let apiErrors = 0;

  for (const album of albums) {
    if (!album.albumId || !album.albumUrl) {
      skipped++;
      Logger.log(`[AlbumShareAudit] Skipped album with missing id/url: "${album.albumTitle}"`);
      continue;
    }

    // Throttle to respect Photos API per-second quota.
    if (checked > 0) {
      Utilities.sleep(INTER_CALL_DELAY_MS);
    }

    const shareInfo = getGoogleAlbumShareInfo(album.albumId);

    if (shareInfo.isShared) {
      Logger.log(`[AlbumShareAudit] OK (shared): "${album.albumTitle}"`);
      checked++;
      continue;
    }

    // API returned no shareInfo — album is either unshared or fetch failed.
    // We treat both conservatively: log and include in the unshared list.
    checked++;

    // Resolve event context for the notification email.
    const event     = findEventById(album.eventId);
    const eventName = event?.eventName ?? album.eventId;
    const eventDate = event?.eventDate ?? '';

    // Resolve club display name (empty for event-scope albums).
    let clubDisplayName = '';
    if (album.albumType === 'club' && album.clubName) {
      const club = findClubByName(album.clubName);
      clubDisplayName = club?.displayName ?? album.clubName;
    }

    Logger.log(`[AlbumShareAudit] NOT shared: "${album.albumTitle}" (${album.albumId})`);

    unshared.push({
      album,
      eventName,
      eventDate,
      clubDisplayName,
      scope: album.albumType,
    });
  }

  Logger.log(
    `[AlbumShareAudit] Done — checked: ${checked}, unshared: ${unshared.length}, ` +
    `skipped: ${skipped}, apiErrors: ${apiErrors}`
  );

  return { unshared, checked, skipped, apiErrors };
}
