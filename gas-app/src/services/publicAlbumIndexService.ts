import { PhotosAlbumRecord, ClubRecord } from '../types/models';
import { listAll as listAllEvents } from './eventService';
import { listAllAlbums } from './photosService';
import { listActive as listActiveClubs } from './clubService';

/**
 * PublicAlbumIndexService — assembles the data model shown on the public-facing
 * album index page (Phase 5, design §6).
 *
 * The page is gated by Google login (any Google account admitted) but does NOT
 * require a registered admin or club-admin role, so this data join must be safe
 * to expose to any authenticated visitor. It lists every event that has at
 * least one synced Google Photos album and the per-club breakdown underneath.
 *
 * Input sources (read-only):
 *   - Events         → event name + date
 *   - Photo_Albums   → album ID, type, title, public URL
 *   - Clubs (active) → normalizedName → displayName lookup
 *
 * Intentional exclusions:
 *   - Events with zero album rows are skipped — there is nothing public to see
 *     yet, and showing a bare event name would leak future-event metadata.
 *   - Inactive clubs are still shown if their album exists. We only use the
 *     Clubs sheet to decorate normalizedName → displayName; an archived club's
 *     historical album should remain browsable.
 *
 * The service is synchronous because all sources are in-spreadsheet; there are
 * no Photos API calls here (that's the sync job's job — this is read-only).
 */

/** One per-club album rendered underneath a parent event. */
export interface PublicClubAlbumEntry {
  /** Normalized club folder name, e.g. "New_Bee". */
  readonly clubName: string;
  /**
   * Human-readable club name as shown in the admin UI.
   * Falls back to clubName if no Clubs-sheet row exists for the normalizedName
   * (e.g. a legacy album for a club that has since been removed).
   */
  readonly clubDisplayName: string;
  /** The Photo_Albums row itself, carrying the shareable URL + counts. */
  readonly album: PhotosAlbumRecord;
}

/** One event group on the public index. */
export interface PublicAlbumIndexEntry {
  readonly eventId:   string;
  readonly eventName: string;
  readonly eventDate: string; // ISO date YYYY-MM-DD

  /**
   * The aggregate "[Event Name] — All Clubs" album, if it has been created yet.
   * null means the backfill sync has not yet run for this event — the per-club
   * albums may still be present. The template should gracefully handle this.
   */
  readonly eventAlbum: PhotosAlbumRecord | null;

  /**
   * Per-club albums for this event, sorted by club display name ascending.
   * Empty array is a valid state (event-level album may exist on its own).
   */
  readonly clubAlbums: ReadonlyArray<PublicClubAlbumEntry>;
}

/**
 * Returns the full public album index, grouped by event and sorted
 * newest-first by event date. Excludes events that have no album records.
 *
 * Cost: one read per sheet (Events, Photo_Albums, Clubs). The join happens
 * in memory; with ~hundreds of events this completes well under a second.
 * If the sheet grows past ~10k rows this should move to a materialized view.
 */
export function listPublicAlbumIndex(): PublicAlbumIndexEntry[] {
  // 1. Pull all events. The pageSize is large enough to treat listAll as an
  //    un-paginated fetch for the foreseeable future; if we ever exceed
  //    10k events we'll revisit with a proper full-sheet read.
  const events = listAllEvents(1, 10000, 'desc').items;

  // 2. All albums, regardless of type.
  const albums: PhotosAlbumRecord[] = listAllAlbums();

  // 3. Active clubs — used to resolve normalizedName → displayName for a
  //    friendlier UI. We don't filter out inactive clubs' albums; we just
  //    won't have a prettier display name for them.
  const clubs: ClubRecord[] = listActiveClubs();
  const clubDisplayByNorm = new Map<string, string>();
  for (const c of clubs) {
    clubDisplayByNorm.set(c.normalizedName, c.displayName);
  }

  // Group albums by eventId for an O(events + albums) join below.
  const albumsByEvent = new Map<string, PhotosAlbumRecord[]>();
  for (const a of albums) {
    if (!a.eventId) continue;
    const bucket = albumsByEvent.get(a.eventId);
    if (bucket) bucket.push(a);
    else albumsByEvent.set(a.eventId, [a]);
  }

  const entries: PublicAlbumIndexEntry[] = [];
  for (const ev of events) {
    const evAlbums = albumsByEvent.get(ev.eventId);
    if (!evAlbums || evAlbums.length === 0) continue; // nothing public to show

    const eventAlbum = evAlbums.find((a) => a.albumType === 'event') ?? null;

    const clubAlbums: PublicClubAlbumEntry[] = evAlbums
      .filter((a) => a.albumType === 'club' && a.clubName)
      .map((a) => ({
        clubName: a.clubName,
        clubDisplayName: clubDisplayByNorm.get(a.clubName) ?? a.clubName,
        album: a,
      }));
    clubAlbums.sort((x, y) =>
      x.clubDisplayName.localeCompare(y.clubDisplayName)
    );

    entries.push({
      eventId:   ev.eventId,
      eventName: ev.eventName,
      eventDate: ev.eventDate,
      eventAlbum,
      clubAlbums,
    });
  }

  // listAllEvents already returned desc, but sort again defensively so the
  // public page's contract ("newest event first") is independent of that.
  entries.sort((a, b) => b.eventDate.localeCompare(a.eventDate));

  return entries;
}
