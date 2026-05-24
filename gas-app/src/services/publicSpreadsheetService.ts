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
import { PhotosAlbumRecord, PhotosFileRecord, EventRecord, SpecialFolderRecord, ClubRecord } from '../types/models';
import { nowIsoTimestamp } from '../utils/dateFormatter';
import { getGoogleAlbumDetails, AlbumDetails } from './photosApiClient';
import { loadAlbumOverrides, AlbumOverride } from './albumOverridesService';
import { listAllSpecialFolders } from './specialFoldersService';
import { listAll as listAllEvents } from './eventService';
import { listActive as listActiveClubs } from './clubService';
import { listAllFileRecords } from './photoAlbumsRepo';

/* global PropertiesService, SpreadsheetApp, Logger, Utilities */

/** Tab name inside the public spreadsheet. */
const PUBLIC_ALBUM_TAB = 'Albums';

/**
 * Tab name for the new index of consolidated photo folders + per-scope video
 * folders that specialFoldersService maintains in Drive. Sits alongside the
 * Albums tab; the column layout is independent so admins can rearrange one
 * without affecting the other.
 */
const PUBLIC_FOLDERS_TAB = 'Folders';

/**
 * Tab name for the per-file Photos index. One row per synced photo, joining
 * Photo_Files with Photo_Albums and Events so a public viewer can browse the
 * full catalogue without logging into the admin sheet.
 */
const PUBLIC_PHOTOS_TAB = 'Photos';

/**
 * How long after creation we trust the stored album URL even when the Photos
 * API returns 403/404. Post-March-2025 the Library API frequently returns
 * 'denied' for albums it just created (scope restrictions), which previously
 * caused us to blank both the Album Link and Photos count on the public sheet.
 *
 * For albums younger than this we assume the denied response is a permissions
 * artefact, NOT a deletion, and keep the cached URL + counts visible.
 *
 * Reconciliation still surfaces truly-deleted albums via a separate trigger.
 */
const ALBUM_DENIED_GRACE_DAYS = 30;

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
 * rebuild time, or an admin-provided override when the API can't see the
 * album:
 *   - "Public"       → album has shareInfo (Anyone with the link can view)
 *   - "Private"      → album exists but is unshared
 *   - "Inaccessible" → API returned 403/404. With our scopes this most
 *                      often means the album was created outside this OAuth
 *                      client, NOT that it was deleted. Set an entry in the
 *                      ALBUM_OVERRIDES Script Property to pin the label.
 *   - "Unknown"      → API hit a 5xx / network error during rebuild
 *
 * "Photos" is also refreshed live from `mediaItemsCount` on each rebuild,
 * so albums that were populated outside the sync pipeline (e.g. backfills
 * done manually in photos.google.com) no longer show 0. When neither the
 * API nor the sheet has a positive count, the cell is left blank rather
 * than displaying a misleading "0".
 *
 * "Album Link" prefers, in order:
 *   1. shareInfo.shareableUrl from the live API (canonical public URL)
 *   2. override.shareableUrl from ALBUM_OVERRIDES Script Property
 *   3. The sheet's stored albumUrl (productUrl — owner-only, may 500
 *      for anonymous viewers; last-resort fallback only)
 */
const HEADERS: ReadonlyArray<string> = [
  'Event Date',     // YYYY-MM-DD
  'Event Name',
  'Scope',          // "Event" or "Club"
  'Club',           // empty for Event-scope rows
  'Tag',            // empty for Event-scope rows
  'Album Title',
  'Photos',         // live mediaItemsCount, falls back to syncedFileCount
  'Drive Folder',   // canonical public-browse URL — Drive shortcut folder; works without any
                    // Photos-side sharing (the Drive folder gets "Anyone with link → Viewer"
                    // programmatically at creation time, see specialFoldersService.ts)
  'Album Link',     // shareableUrl (or albumUrl fallback). Often "Inaccessible" because the
                    // Photos Library API can't read share state for our scopes — use the
                    // Drive Folder column above as the canonical public link.
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
 * Maps live album-details + admin override into the user-facing permission
 * label. The admin override always wins, since it represents
 * ground-truth that the admin has manually verified.
 *
 * Label semantics:
 *   - 'Public'       → API confirms shareInfo (or override pins it)
 *   - 'Private'      → API confirms no shareInfo (or override pins it)
 *   - 'Inaccessible' → API returned 403/404; album exists but our OAuth
 *                      client cannot read it. Most common reason an admin
 *                      who *just* shared an album still sees the wrong
 *                      label.
 *   - 'Unknown'      → 5xx, network error, or the rebuild never asked
 *
 * Note we deliberately do NOT use 'Missing'. With Google's deny-by-default
 * 404 behaviour for cross-client reads, we cannot tell deleted albums
 * apart from inaccessible ones. The reconciliation report (a separate
 * trigger) catches the truly-deleted case.
 */
function permissionLabel(
  album: PhotosAlbumRecord,
  details: AlbumDetails | null,
  override: AlbumOverride | undefined
): string {
  if (override?.permission) return override.permission;
  if (!details) return 'Unknown';
  // Denied + no admin override + outside grace window => treat as deleted in
  // Photos. Blank cells in the public sheet so visitors aren't shown stale
  // permission info for an album that no longer exists. See looksDeleted().
  if (looksDeleted(album, details, override)) return '';
  if (details.accessibility === 'denied') return 'Inaccessible';
  if (!details.found) return 'Unknown';
  return details.isShared ? 'Public' : 'Private';
}

/**
 * Treat an album as "deleted in Google Photos" when albums.get returned
 * 403/404 (`accessibility === 'denied'`) AND the album is old enough that the
 * denied response is unlikely to be a transient API/scope artefact AND the
 * admin hasn't pinned anything for it in ALBUM_OVERRIDES.
 *
 * The age guard (ALBUM_DENIED_GRACE_DAYS) exists because the post-March-2025
 * Library API often returns 403/404 for albums it has *just created* via the
 * appendonly + edit.appcreateddata scopes. Without this guard, every freshly
 * created album would land on the public sheet with a blank Album Link and
 * blank Photos count — which is exactly what we saw in production for the
 * 2026-05-16 Brooklyn Half rows.
 *
 * Inside the grace window we keep the cached URL/count visible. Reconciliation
 * still flags truly-orphaned rows through a separate channel.
 */
function looksDeleted(
  album: PhotosAlbumRecord,
  details: AlbumDetails | null,
  override: AlbumOverride | undefined
): boolean {
  if (!details) return false;
  if (override?.permission || override?.shareableUrl) return false;
  if (details.accessibility !== 'denied') return false;
  if (isWithinDeniedGrace(album)) return false;
  return true;
}

/**
 * True when the album's createdAt is within ALBUM_DENIED_GRACE_DAYS of now.
 * Empty / unparseable createdAt is treated as "within grace" (newly migrated
 * rows shouldn't be blanked just because they're missing a timestamp).
 */
function isWithinDeniedGrace(album: PhotosAlbumRecord): boolean {
  const raw = (album.createdAt || '').trim();
  if (!raw) return true;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return true;
  const ageMs = Date.now() - t;
  return ageMs < ALBUM_DENIED_GRACE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Picks the URL to render in the "Album Link" column.
 *
 * Priority:
 *   1. live shareInfo.shareableUrl  — public, sharded "Anyone with the link"
 *      URL. Works for unauthenticated viewers.
 *   2. override.shareableUrl        — admin-pinned share URL, used when
 *      the API can't see the album but the admin has manually shared it.
 *   3. normalized sheet URL         — historical productUrl. Owner-only;
 *      anonymous viewers will see a Google 500 page when clicking. We
 *      keep this as a last resort so existing rows aren't blanked out.
 *
 * Returning '' (empty string) is intentionally avoided unless we truly
 * have nothing — the sheet renders that as a blank cell, and admins
 * usually prefer a dead link they can debug over no link at all.
 */
function albumLink(
  album: PhotosAlbumRecord,
  normalizedUrl: string,
  details: AlbumDetails | null,
  override: AlbumOverride | undefined
): string {
  if (details?.shareableUrl) return details.shareableUrl;
  if (override?.shareableUrl) return override.shareableUrl;
  // Deleted-in-Photos albums: drop the stale sheet URL so visitors don't
  // click into a dead link. permissionLabel() and the call site clear Last
  // Sync the same way. The grace-window check inside looksDeleted means
  // freshly created albums whose API returns denied still keep their URL.
  if (looksDeleted(album, details, override)) return '';
  return normalizedUrl;
}

/**
 * Picks the photo count to display.
 *
 *   - Prefer the live mediaItemsCount from Google Photos when available.
 *   - Fall back to the sheet's cached syncedFileCount.
 *   - Fall back further to the count of Photo_Files rows for this album.
 *     This is robust against drift in syncedFileCount (e.g. a partial sync
 *     that wrote Photo_Files rows but never updated the album stats).
 *   - When everything is zero AND the album is within the denied grace
 *     window we render '' (empty) so the cell reads "unknown" rather than
 *     misleading "0" for an album the API can't yet see.
 *
 * Returns either a number (≥ 0) or '' for "we don't know".
 */
function photoCount(
  album: PhotosAlbumRecord,
  details: AlbumDetails | null,
  fileCountByAlbumId: Map<string, number>
): number | string {
  if (details && details.found && typeof details.mediaItemsCount === 'number') {
    return details.mediaItemsCount;
  }
  if (album.syncedFileCount > 0) return album.syncedFileCount;
  const fromFiles = fileCountByAlbumId.get(album.albumId) ?? 0;
  if (fromFiles > 0) return fromFiles;
  // Nothing positive from any source. If we've seen the album recently (within
  // the grace window) the API answer is unreliable — show '' so admins know
  // the count is undetermined rather than promising 0 photos. Otherwise we
  // emit 0 since that's the most accurate signal we can give.
  if (details && isWithinDeniedGrace(album)) return '';
  return 0;
}

/**
 * Builds an eventId → Drive folder URL lookup for the per-event Photos_NNN
 * shortcut folders. We always pick the FIRST bucket (Photos_001) for the
 * Albums tab — it's a single deep link a member can click to start browsing,
 * even when later overflow buckets exist. Full enumeration of every bucket
 * lives on the Folders tab.
 *
 * Pure function — exported for unit testing. Tag/club scope folders are
 * excluded; only scope='photos' rows participate. Buckets are picked by
 * lowest folderIndex so the link is deterministic across rebuilds.
 */
export function buildEventPhotosFolderUrlIndex(
  records: ReadonlyArray<SpecialFolderRecord>
): Map<string, string> {
  // Track the bucket with the lowest folderIndex per event so we always
  // hand the visitor Photos_001 (the natural starting point), even if later
  // buckets were materialised first in some out-of-order rebuild.
  const bestByEvent = new Map<string, { index: number; url: string }>();
  for (const r of records) {
    if (r.scope !== 'photos') continue;
    if (!r.eventId || !r.folderUrl) continue;
    const prev = bestByEvent.get(r.eventId);
    if (!prev || r.folderIndex < prev.index) {
      bestByEvent.set(r.eventId, { index: r.folderIndex, url: r.folderUrl });
    }
  }
  const out = new Map<string, string>();
  for (const [eventId, entry] of bestByEvent) out.set(eventId, entry.url);
  return out;
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
 *
 * `driveFolderUrlByEvent` provides the canonical public-browse URL — the
 * Photos_001 Drive shortcut folder for each event. The same URL is repeated
 * on every row within an event (event-scope and per-club rows alike) so the
 * spreadsheet stays one-click for visitors regardless of which row catches
 * their eye. The Photos Library API can't reliably surface its own share URL
 * for our scopes, so the Drive folder is what we promote as primary.
 */
function buildRows(
  entries: ReadonlyArray<PublicAlbumIndexEntry>,
  liveDetails: Map<string, AlbumDetails>,
  overrides: Map<string, AlbumOverride>,
  fileCountByAlbumId: Map<string, number>,
  driveFolderUrlByEvent: Map<string, string>
): unknown[][] {
  const rows: unknown[][] = [];

  for (const entry of entries) {
    const driveFolderUrl = driveFolderUrlByEvent.get(entry.eventId) ?? '';

    if (entry.eventAlbum) {
      const a = entry.eventAlbum;
      const fallback = `${entry.eventDate} ${entry.eventName}`;
      const norm = normalizeAlbumDisplay(a, fallback);
      const details = liveDetails.get(a.albumId) ?? null;
      const override = overrides.get(a.albumId);
      const deleted = looksDeleted(a, details, override);
      rows.push([
        entry.eventDate,
        entry.eventName,
        'Event',
        '',
        '',
        norm.title,
        photoCount(a, details, fileCountByAlbumId),
        driveFolderUrl,
        albumLink(a, norm.url, details, override),
        deleted ? '' : norm.lastSyncAt,
        permissionLabel(a, details, override),
      ]);
    }
    for (const c of entry.clubAlbums) {
      const a = c.album;
      const fallback = `${entry.eventDate} ${entry.eventName} – ${c.clubDisplayName}` +
        (a.tag ? ` – ${a.tag}` : '');
      const norm = normalizeAlbumDisplay(a, fallback);
      const details = liveDetails.get(a.albumId) ?? null;
      const override = overrides.get(a.albumId);
      const deleted = looksDeleted(a, details, override);
      rows.push([
        entry.eventDate,
        entry.eventName,
        'Club',
        c.clubDisplayName,
        a.tag,
        norm.title,
        photoCount(a, details, fileCountByAlbumId),
        driveFolderUrl,
        albumLink(a, norm.url, details, override),
        deleted ? '' : norm.lastSyncAt,
        permissionLabel(a, details, override),
      ]);
    }
  }

  return rows;
}

/**
 * Builds an albumId → row-count map from all Photo_Files rows. Used as a
 * tertiary fallback for the Photos column when both the live API count and
 * the cached syncedFileCount are unavailable.
 */
function countFilesByAlbumId(
  fileRecords: ReadonlyArray<PhotosFileRecord>
): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of fileRecords) {
    if (!f.albumId) continue;
    out.set(f.albumId, (out.get(f.albumId) ?? 0) + 1);
  }
  return out;
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
  // Collect (albumId, albumTitle) once per unique id so the diagnostic
  // log lines are human-readable. The title makes it 100x easier to
  // figure out which album an "API denied" entry refers to.
  const seen = new Set<string>();
  const queue: { id: string; title: string }[] = [];
  for (const entry of entries) {
    const ev = entry.eventAlbum;
    if (ev?.albumId && !seen.has(ev.albumId)) {
      seen.add(ev.albumId);
      queue.push({ id: ev.albumId, title: ev.albumTitle });
    }
    for (const c of entry.clubAlbums) {
      const a = c.album;
      if (a.albumId && !seen.has(a.albumId)) {
        seen.add(a.albumId);
        queue.push({ id: a.albumId, title: a.albumTitle });
      }
    }
  }

  const out = new Map<string, AlbumDetails>();
  let denied = 0;
  let serverError = 0;
  let networkError = 0;

  for (let i = 0; i < queue.length; i++) {
    if (i > 0) Utilities.sleep(REBUILD_INTER_CALL_DELAY_MS);
    const { id, title } = queue[i];
    try {
      const details = getGoogleAlbumDetails(id);
      out.set(id, details);

      if (!details.found) {
        // Per-row log so admins can see exactly which albums the API
        // can't see and why. Truncate title — Logger lines are limited.
        const titleShort = title.length > 60 ? title.slice(0, 57) + '…' : title;
        Logger.log(
          `[publicSpreadsheetService] albums.get HTTP ${details.httpStatus} ` +
          `(${details.accessibility}) for "${titleShort}" (${id})`
        );
        if (details.accessibility === 'denied')       denied++;
        else if (details.accessibility === 'server_error') serverError++;
        else if (details.accessibility === 'network')      networkError++;
      }
    } catch (err) {
      Logger.log(
        `[publicSpreadsheetService] albums.get threw for "${title}" (${id}): ${String(err)}`
      );
      // Leave it out of the map — caller will render "Unknown".
    }
  }

  if (denied + serverError + networkError > 0) {
    Logger.log(
      `[publicSpreadsheetService] Live album fetch summary: ` +
      `total=${queue.length}, denied=${denied}, ` +
      `server_error=${serverError}, network=${networkError}. ` +
      `Set ALBUM_OVERRIDES Script Property to pin Permission/URL for denied albums.`
    );
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
  // Admin-pinned values for albums the API can't see (403/404). Read from
  // the ALBUM_OVERRIDES Script Property; safe to call even when unset.
  const overrides = loadAlbumOverrides();
  if (overrides.size > 0) {
    Logger.log(
      `[publicSpreadsheetService] Applying ${overrides.size} entry(ies) from ALBUM_OVERRIDES`
    );
  }
  // Local fallback count from Photo_Files — used when the live API denies
  // the album AND syncedFileCount is 0 (common right after a fresh sync of
  // a brand-new album, where the album stats row hasn't been updated yet).
  const fileRecords = listAllFileRecords();
  const fileCountByAlbumId = countFilesByAlbumId(fileRecords);

  // Drive Folder column data: each event maps to its Photos_001 Drive
  // shortcut folder. This is the canonical PUBLIC-BROWSE URL — sharing on
  // Drive is fully programmable (see drivePermissionsService.ts), unlike
  // Google Photos sharing which the Library API can no longer toggle.
  // Reading the whole Special_Folders sheet here is cheap relative to the
  // per-album albums.get calls above; with thousands of folders it stays
  // well under a second.
  const driveFolderUrlByEvent = buildEventPhotosFolderUrlIndex(
    listAllSpecialFolders()
  );
  const dataRows = buildRows(
    entries,
    liveDetails,
    overrides,
    fileCountByAlbumId,
    driveFolderUrlByEvent
  );

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

// ─── Folders tab (consolidated photos + per-scope videos) ────────────────────

/**
 * Header row written at the top of the Folders tab.
 *
 * Column order is part of the public contract — anyone who has bookmarked
 * the published-to-web view will see this layout. Add new columns at the
 * end rather than reordering.
 *
 * Scope semantics:
 *   - "Photos" → one of the per-event Photos_NNN buckets (each up to
 *     MAX_SHORTCUTS_PER_PHOTOS_FOLDER shortcuts). Club/Tag are blank.
 *   - "Videos" → the per-(event, club, tag) Videos folder. Club + Tag
 *     are populated.
 *
 * "Folder Index" is the 1-based ordinal (1..N for photo buckets; always 1
 * for video folders), so admins sorting by (Event, Scope, Folder Index) get
 * the natural reading order.
 */
const FOLDERS_HEADERS: ReadonlyArray<string> = [
  'Event Date',     // YYYY-MM-DD
  'Event Name',
  'Scope',          // "Photos" or "Videos"
  'Club',           // empty for Photos rows
  'Tag',            // empty for Photos rows
  'Folder Name',    // e.g. "Photos_001", "Videos"
  'Folder Index',   // 1..N for photos; 1 for videos
  'File Count',     // shortcut count at last refresh
  'Folder Link',    // https://drive.google.com/drive/folders/<id>
  'Last Refreshed', // ISO timestamp of the most recent rebuild
];

/** Display labels keep the public tab readable; they don't affect storage. */
function scopeLabel(scope: 'photos' | 'videos'): string {
  return scope === 'photos' ? 'Photos' : 'Videos';
}

/**
 * Sorts Special_Folders rows for the public tab.
 *
 * Primary:   event date descending (newest first), to match the Albums tab.
 * Secondary: event id ascending so events on the same date are grouped.
 * Tertiary:  Photos before Videos within an event.
 * Within Photos: bucket ordinal ascending (Photos_001, Photos_002, …).
 * Within Videos: club name ascending, then tag ascending.
 */
function compareFolderRows(
  a: { eventDate: string; eventId: string; record: SpecialFolderRecord },
  b: { eventDate: string; eventId: string; record: SpecialFolderRecord }
): number {
  if (a.eventDate !== b.eventDate) return b.eventDate.localeCompare(a.eventDate);
  if (a.eventId !== b.eventId) return a.eventId.localeCompare(b.eventId);
  if (a.record.scope !== b.record.scope) {
    return a.record.scope === 'photos' ? -1 : 1;
  }
  if (a.record.scope === 'photos') {
    return a.record.folderIndex - b.record.folderIndex;
  }
  // Both videos
  const clubCmp = a.record.clubName.localeCompare(b.record.clubName);
  if (clubCmp !== 0) return clubCmp;
  return a.record.tag.localeCompare(b.record.tag);
}

/**
 * Flattens Special_Folders records into the 2D row layout used by the
 * Folders tab. Pure function — exported for unit testing.
 *
 * Rows whose eventId is unknown to the Events sheet are dropped (the event
 * was deleted or migrated away). Rows whose clubName is unknown are still
 * shown using the raw normalizedName so admins can see and clean them up.
 */
export function buildFolderRows(
  records: ReadonlyArray<SpecialFolderRecord>,
  events: ReadonlyArray<EventRecord>,
  clubs: ReadonlyArray<ClubRecord>
): unknown[][] {
  const eventById = new Map<string, EventRecord>();
  for (const ev of events) eventById.set(ev.eventId, ev);

  const clubDisplayByNorm = new Map<string, string>();
  for (const c of clubs) clubDisplayByNorm.set(c.normalizedName, c.displayName);

  const enriched: Array<{
    eventDate: string;
    eventId: string;
    record: SpecialFolderRecord;
    eventName: string;
  }> = [];

  for (const r of records) {
    const ev = eventById.get(r.eventId);
    if (!ev) continue; // event deleted / unknown — drop
    enriched.push({
      eventDate: ev.eventDate,
      eventId: ev.eventId,
      eventName: ev.eventName,
      record: r,
    });
  }

  enriched.sort(compareFolderRows);

  return enriched.map((e) => {
    const r = e.record;
    const clubLabel =
      r.scope === 'photos'
        ? ''
        : clubDisplayByNorm.get(r.clubName) ?? r.clubName;
    return [
      e.eventDate,
      e.eventName,
      scopeLabel(r.scope),
      clubLabel,
      r.scope === 'photos' ? '' : r.tag,
      r.folderName,
      r.folderIndex,
      r.fileCount,
      r.folderUrl,
      r.lastRefreshedAt,
    ];
  });
}

/**
 * Rebuilds the Folders tab from scratch.
 *
 * Mirrors rebuildPublicAlbumIndex() in shape: open the configured public
 * spreadsheet, ensure the tab exists, clear contents, write headers + rows,
 * stamp a "last refreshed" note one column past the headers.
 *
 * Returns the number of data rows written. Returns 0 with a log when the
 * Script Property is unset (feature disabled).
 *
 * Throws on Sheets API errors so manual admin runs see the failure. Hot-path
 * callers should use tryRebuildPublicFoldersIndex().
 */
export function rebuildPublicFoldersIndex(): number {
  const fileId = getPublicSheetId();
  if (!fileId) {
    Logger.log(
      `[publicSpreadsheetService] ${PROP_KEY} not set — public folders index is disabled`
    );
    return 0;
  }

  const ss = SpreadsheetApp.openById(fileId);
  let sheet = ss.getSheetByName(PUBLIC_FOLDERS_TAB);
  if (!sheet) sheet = ss.insertSheet(PUBLIC_FOLDERS_TAB);

  // Pull the source data once. listAllEvents uses a generous pageSize so
  // tens of thousands of events fit; for systems past that, paginate.
  const records = listAllSpecialFolders();
  const events = listAllEvents(1, 10000, 'desc').items;
  const clubs = listActiveClubs();

  const dataRows = buildFolderRows(records, events, clubs);

  sheet.clearContents();

  sheet
    .getRange(1, 1, 1, FOLDERS_HEADERS.length)
    .setValues([FOLDERS_HEADERS as unknown[]])
    .setFontWeight('bold');
  sheet.setFrozenRows(1);

  sheet
    .getRange(1, FOLDERS_HEADERS.length + 1)
    .setValue(`Last refreshed: ${nowIsoTimestamp()}`)
    .setFontStyle('italic');

  if (dataRows.length > 0) {
    sheet
      .getRange(2, 1, dataRows.length, FOLDERS_HEADERS.length)
      .setValues(dataRows);
  }

  SpreadsheetApp.flush();

  Logger.log(
    `[publicSpreadsheetService] Rewrote ${PUBLIC_FOLDERS_TAB} tab: ` +
    `${dataRows.length} row(s) across ${records.length} folder(s)`
  );
  return dataRows.length;
}

/**
 * Best-effort wrapper for hot paths (post-batch-sync hook in photosService).
 * Swallows every error and logs it — the Folders tab is a downstream
 * convenience like the Albums tab; failing here must never fail an upload.
 */
export function tryRebuildPublicFoldersIndex(): void {
  try {
    rebuildPublicFoldersIndex();
  } catch (err) {
    Logger.log(
      `[publicSpreadsheetService] Non-fatal: failed to refresh public folders index: ${String(err)}`
    );
  }
}

// ─── Photos tab (per-file index) ─────────────────────────────────────────────

/**
 * Header row written at the top of the Photos tab.
 *
 * One row per Photo_Files entry, joined with the album/event/club metadata
 * so a public viewer can see every uploaded photo without logging into the
 * admin spreadsheet. Each Drive file appears twice (once per album it was
 * synced into — event-level and club/tag-level) so visitors can filter by
 * either scope.
 *
 * Column order is part of the public contract — add new columns at the end
 * rather than reordering.
 */
const PHOTOS_HEADERS: ReadonlyArray<string> = [
  'Event Date',     // YYYY-MM-DD
  'Event Name',
  'Album Scope',    // 'Event' or 'Club'
  'Club',           // empty for Event-scope rows
  'Tag',            // empty for Event-scope rows
  'Album Title',
  'File Name',
  'Synced At',      // ISO timestamp from Photo_Files
  'Drive File',     // Drive URL — clickable
  'Photo',          // Google Photos URL — clickable when known
];

const DRIVE_FILE_URL_PREFIX = 'https://drive.google.com/file/d/';

/**
 * Builds the per-photo rows for the Photos tab.
 *
 * Pure function — exported for unit testing. Filters out file records whose
 * album or event no longer exists in the source sheets (orphans from deleted
 * albums or events). Sorted newest-first by synced-at, then by file name so
 * the most recent uploads appear at the top.
 */
export function buildPhotosRows(
  fileRecords: ReadonlyArray<PhotosFileRecord>,
  albums: ReadonlyArray<PhotosAlbumRecord>,
  events: ReadonlyArray<EventRecord>,
  clubs: ReadonlyArray<ClubRecord>
): unknown[][] {
  const albumById = new Map<string, PhotosAlbumRecord>();
  for (const a of albums) albumById.set(a.albumId, a);

  const eventById = new Map<string, EventRecord>();
  for (const ev of events) eventById.set(ev.eventId, ev);

  const clubDisplayByNorm = new Map<string, string>();
  for (const c of clubs) clubDisplayByNorm.set(c.normalizedName, c.displayName);

  type Enriched = {
    eventDate:   string;
    eventName:   string;
    albumScope:  'Event' | 'Club';
    clubLabel:   string;
    tag:         string;
    albumTitle:  string;
    fileName:    string;
    syncedAt:    string;
    driveUrl:    string;
    photoUrl:    string;
  };

  const enriched: Enriched[] = [];

  for (const f of fileRecords) {
    if (!f.driveFileId || !f.fileName) continue;
    const album = albumById.get(f.albumId);
    if (!album) continue; // album removed; skip orphan
    const ev = eventById.get(f.eventId);
    if (!ev) continue; // event removed; skip orphan

    const isClubScope = f.albumType === 'club';
    const clubLabel = isClubScope
      ? (clubDisplayByNorm.get(f.clubName) ?? f.clubName)
      : '';

    // Drive URL is fully predictable from the file id and works without any
    // additional API calls. Photos URL we don't store today — leave empty
    // and let the Albums tab handle navigation.
    enriched.push({
      eventDate:   ev.eventDate,
      eventName:   ev.eventName,
      albumScope:  isClubScope ? 'Club' : 'Event',
      clubLabel,
      tag:         isClubScope ? f.tag : '',
      albumTitle:  album.albumTitle,
      fileName:    f.fileName,
      syncedAt:    f.syncedAt,
      driveUrl:    DRIVE_FILE_URL_PREFIX + encodeURIComponent(f.driveFileId) + '/view',
      photoUrl:    '',
    });
  }

  enriched.sort((a, b) => {
    if (a.eventDate !== b.eventDate) return b.eventDate.localeCompare(a.eventDate);
    if (a.syncedAt !== b.syncedAt) return b.syncedAt.localeCompare(a.syncedAt);
    return a.fileName.localeCompare(b.fileName);
  });

  return enriched.map((e) => [
    e.eventDate,
    e.eventName,
    e.albumScope,
    e.clubLabel,
    e.tag,
    e.albumTitle,
    e.fileName,
    e.syncedAt,
    e.driveUrl,
    e.photoUrl,
  ]);
}

/**
 * Rebuilds the Photos tab from scratch.
 *
 * Mirrors rebuildPublicAlbumIndex / rebuildPublicFoldersIndex in shape:
 * open the configured public spreadsheet, ensure the tab exists, clear
 * contents, write headers + rows, stamp a "last refreshed" note one column
 * past the headers.
 *
 * Returns the number of data rows written. Returns 0 when the Script
 * Property is unset (feature disabled).
 *
 * Throws on Sheets API errors so manual admin runs see the failure. Hot-path
 * callers should use tryRebuildPublicPhotosIndex().
 */
export function rebuildPublicPhotosIndex(): number {
  const fileId = getPublicSheetId();
  if (!fileId) {
    Logger.log(
      `[publicSpreadsheetService] ${PROP_KEY} not set — public photos index is disabled`
    );
    return 0;
  }

  const ss = SpreadsheetApp.openById(fileId);
  let sheet = ss.getSheetByName(PUBLIC_PHOTOS_TAB);
  if (!sheet) sheet = ss.insertSheet(PUBLIC_PHOTOS_TAB);

  const fileRecords = listAllFileRecords();
  const albums = listPublicAlbumIndex().flatMap((entry) => {
    const out: PhotosAlbumRecord[] = [];
    if (entry.eventAlbum) out.push(entry.eventAlbum);
    for (const c of entry.clubAlbums) out.push(c.album);
    return out;
  });
  const events = listAllEvents(1, 10000, 'desc').items;
  const clubs = listActiveClubs();

  const dataRows = buildPhotosRows(fileRecords, albums, events, clubs);

  sheet.clearContents();

  sheet
    .getRange(1, 1, 1, PHOTOS_HEADERS.length)
    .setValues([PHOTOS_HEADERS as unknown[]])
    .setFontWeight('bold');
  sheet.setFrozenRows(1);

  sheet
    .getRange(1, PHOTOS_HEADERS.length + 1)
    .setValue(`Last refreshed: ${nowIsoTimestamp()}`)
    .setFontStyle('italic');

  if (dataRows.length > 0) {
    sheet
      .getRange(2, 1, dataRows.length, PHOTOS_HEADERS.length)
      .setValues(dataRows);
  }

  SpreadsheetApp.flush();

  Logger.log(
    `[publicSpreadsheetService] Rewrote ${PUBLIC_PHOTOS_TAB} tab: ` +
    `${dataRows.length} row(s) across ${fileRecords.length} Photo_Files entry(ies)`
  );
  return dataRows.length;
}

/**
 * Best-effort wrapper for hot paths (post-batch-sync hook in photosService).
 * Swallows every error and logs it — the Photos tab is a downstream
 * convenience like the Albums/Folders tabs; failing here must never fail
 * an upload.
 */
export function tryRebuildPublicPhotosIndex(): void {
  try {
    rebuildPublicPhotosIndex();
  } catch (err) {
    Logger.log(
      `[publicSpreadsheetService] Non-fatal: failed to refresh public photos index: ${String(err)}`
    );
  }
}
