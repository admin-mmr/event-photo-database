/**
 * Tests for publicAlbumIndexService.listPublicAlbumIndex().
 *
 * This service joins three read-only sources (Events, Photo_Albums, Clubs) and
 * produces the data model shown on the Google-login-gated public index page.
 *
 * Covered:
 *   1. Returns entries sorted by event date descending (newest first)
 *   2. Excludes events that have no album rows at all
 *   3. Groups albums correctly by eventId
 *   4. Correctly separates 'event' vs 'club' album types
 *   5. Falls back to normalizedName when a club is not in the Clubs sheet
 *   6. Per-club albums are sorted by clubDisplayName ascending
 *   7. Returns empty list cleanly when there are no events / no albums
 *   8. Skips malformed album rows (missing eventId)
 *
 * We mock the three upstream service modules so no real sheets are touched.
 */

import {
  listPublicAlbumIndex,
  PublicAlbumIndexEntry,
} from '../../src/services/publicAlbumIndexService';
import {
  EventRecord,
  PhotosAlbumRecord,
  ClubRecord,
} from '../../src/types/models';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../../src/services/eventService', () => ({
  listAll: jest.fn(),
}));

jest.mock('../../src/services/photosService', () => ({
  listAllAlbums: jest.fn(),
}));

jest.mock('../../src/services/clubService', () => ({
  listActive: jest.fn(),
}));

// Mock Logger (GAS global) in case any transitive import reaches for it
(global as unknown as Record<string, unknown>).Logger = { log: jest.fn() };

import { listAll as listAllEvents } from '../../src/services/eventService';
import { listAllAlbums } from '../../src/services/photosService';
import { listActive as listActiveClubs } from '../../src/services/clubService';

const mockListAllEvents  = listAllEvents     as jest.Mock;
const mockListAllAlbums  = listAllAlbums     as jest.Mock;
const mockListActiveClubs = listActiveClubs   as jest.Mock;

// ─── Fixture builders ─────────────────────────────────────────────────────────

function makeEvent(
  eventId: string,
  eventName: string,
  eventDate: string
): EventRecord {
  return {
    eventId,
    eventName,
    eventDate,
    folderName:    `${eventDate}_${eventName.replace(/\s+/g, '_')}`,
    driveFolderId: `folder-${eventId}`,
    createdBy:     'admin@mmrunners.org',
    createdAt:     '2026-04-01T09:00:00.000Z',
  };
}

function makeAlbum(
  albumId: string,
  albumType: 'event' | 'club',
  eventId: string,
  clubName = '',
  tag = ''
): PhotosAlbumRecord {
  const effectiveTag = albumType === 'club' ? (tag || 'finish_line') : '';
  return {
    albumId,
    albumType,
    eventId,
    clubName,
    tag:              effectiveTag,
    albumTitle:       albumType === 'event' ? 'Event All Clubs' : `Club ${clubName} – ${effectiveTag}`,
    albumUrl:         `https://photos.google.com/lr/album/${albumId}`,
    shareableUrl:     `https://photos.app.goo.gl/${albumId}`,
    createdAt:        '2026-04-19T09:00:00.000Z',
    lastSyncAt:       '2026-04-19T10:00:00.000Z',
    syncedFileCount:  5,
  };
}

function makeClub(
  normalizedName: string,
  displayName: string
): ClubRecord {
  return {
    displayName,
    normalizedName,
    status:     'active',
    addedDate:  '2026-03-01',
    addedBy:    'admin@mmrunners.org',
  };
}

/** Convenience: the mock for listAllEvents must return a PaginatedResult shape. */
function setEvents(events: EventRecord[]) {
  mockListAllEvents.mockReturnValue({
    items:    events,
    total:    events.length,
    page:     1,
    pageSize: 10000,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('listPublicAlbumIndex()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Sensible defaults: all empty unless overridden
    setEvents([]);
    mockListAllAlbums.mockReturnValue([]);
    mockListActiveClubs.mockReturnValue([]);
  });

  it('returns an empty array when there are no events', () => {
    const result = listPublicAlbumIndex();
    expect(result).toEqual([]);
  });

  it('returns an empty array when events exist but no albums have been synced', () => {
    setEvents([
      makeEvent('evt-1', 'Spring 5K', '2026-04-15'),
      makeEvent('evt-2', 'Fall 10K',  '2025-10-10'),
    ]);
    mockListAllAlbums.mockReturnValue([]);

    const result = listPublicAlbumIndex();
    expect(result).toEqual([]);
  });

  it('excludes events with zero album rows', () => {
    setEvents([
      makeEvent('evt-with-albums', 'Has Albums',   '2026-04-15'),
      makeEvent('evt-no-albums',   'No Albums',    '2026-03-10'),
    ]);
    mockListAllAlbums.mockReturnValue([
      makeAlbum('album-evt-1', 'event', 'evt-with-albums'),
    ]);

    const result = listPublicAlbumIndex();
    expect(result).toHaveLength(1);
    expect(result[0].eventId).toBe('evt-with-albums');
  });

  it('returns entries sorted by event date descending (newest first)', () => {
    setEvents([
      makeEvent('evt-old',    'Old Event',    '2025-01-01'),
      makeEvent('evt-newest', 'Newest Event', '2026-05-30'),
      makeEvent('evt-mid',    'Mid Event',    '2025-11-15'),
    ]);
    mockListAllAlbums.mockReturnValue([
      makeAlbum('album-old',    'event', 'evt-old'),
      makeAlbum('album-newest', 'event', 'evt-newest'),
      makeAlbum('album-mid',    'event', 'evt-mid'),
    ]);

    const result = listPublicAlbumIndex();
    expect(result.map((e) => e.eventId)).toEqual([
      'evt-newest',
      'evt-mid',
      'evt-old',
    ]);
  });

  it('groups albums correctly by eventId', () => {
    setEvents([
      makeEvent('evt-A', 'Event A', '2026-04-15'),
      makeEvent('evt-B', 'Event B', '2026-03-15'),
    ]);
    mockListAllAlbums.mockReturnValue([
      makeAlbum('album-A-event', 'event', 'evt-A'),
      makeAlbum('album-A-club1', 'club',  'evt-A', 'New_Bee'),
      makeAlbum('album-B-event', 'event', 'evt-B'),
      makeAlbum('album-B-club1', 'club',  'evt-B', 'CHI'),
      makeAlbum('album-B-club2', 'club',  'evt-B', 'DKR'),
    ]);

    const result = listPublicAlbumIndex();
    expect(result).toHaveLength(2);

    const evA = result.find((e) => e.eventId === 'evt-A')!;
    const evB = result.find((e) => e.eventId === 'evt-B')!;

    expect(evA.eventAlbum?.albumId).toBe('album-A-event');
    expect(evA.clubAlbums).toHaveLength(1);
    expect(evA.clubAlbums[0].clubName).toBe('New_Bee');

    expect(evB.eventAlbum?.albumId).toBe('album-B-event');
    expect(evB.clubAlbums).toHaveLength(2);
  });

  it('correctly separates event-type vs club-type albums under one event', () => {
    setEvents([
      makeEvent('evt-1', 'Spring 5K', '2026-04-15'),
    ]);
    mockListAllAlbums.mockReturnValue([
      makeAlbum('album-event', 'event', 'evt-1'),
      makeAlbum('album-nb',    'club',  'evt-1', 'New_Bee'),
      makeAlbum('album-chi',   'club',  'evt-1', 'CHI'),
    ]);

    const result = listPublicAlbumIndex();
    expect(result).toHaveLength(1);

    const entry = result[0];
    expect(entry.eventAlbum).not.toBeNull();
    expect(entry.eventAlbum!.albumType).toBe('event');
    expect(entry.eventAlbum!.albumId).toBe('album-event');

    expect(entry.clubAlbums).toHaveLength(2);
    for (const c of entry.clubAlbums) {
      expect(c.album.albumType).toBe('club');
    }
  });

  it('sets eventAlbum to null when only club albums exist for an event', () => {
    setEvents([
      makeEvent('evt-clubs-only', 'Club-only Event', '2026-04-15'),
    ]);
    mockListAllAlbums.mockReturnValue([
      makeAlbum('album-nb', 'club', 'evt-clubs-only', 'New_Bee'),
    ]);

    const result = listPublicAlbumIndex();
    expect(result).toHaveLength(1);
    expect(result[0].eventAlbum).toBeNull();
    expect(result[0].clubAlbums).toHaveLength(1);
  });

  it('returns empty clubAlbums when only an event-level album exists', () => {
    setEvents([
      makeEvent('evt-event-only', 'Event-level Only', '2026-04-15'),
    ]);
    mockListAllAlbums.mockReturnValue([
      makeAlbum('album-event', 'event', 'evt-event-only'),
    ]);

    const result = listPublicAlbumIndex();
    expect(result).toHaveLength(1);
    expect(result[0].eventAlbum).not.toBeNull();
    expect(result[0].clubAlbums).toEqual([]);
  });

  it('resolves clubDisplayName from the Clubs sheet via normalizedName', () => {
    setEvents([
      makeEvent('evt-1', 'Spring 5K', '2026-04-15'),
    ]);
    mockListAllAlbums.mockReturnValue([
      makeAlbum('album-nb', 'club', 'evt-1', 'New_Bee'),
    ]);
    mockListActiveClubs.mockReturnValue([
      makeClub('New_Bee', 'New Bee Runners'),
    ]);

    const result = listPublicAlbumIndex();
    expect(result[0].clubAlbums[0].clubName).toBe('New_Bee');
    expect(result[0].clubAlbums[0].clubDisplayName).toBe('New Bee Runners');
  });

  it('falls back to normalizedName when a club is not in the Clubs sheet', () => {
    setEvents([
      makeEvent('evt-1', 'Spring 5K', '2026-04-15'),
    ]);
    mockListAllAlbums.mockReturnValue([
      makeAlbum('album-legacy', 'club', 'evt-1', 'Legacy_Club'),
    ]);
    // Clubs sheet does NOT contain Legacy_Club (it may have been archived or deleted)
    mockListActiveClubs.mockReturnValue([
      makeClub('New_Bee', 'New Bee Runners'),
    ]);

    const result = listPublicAlbumIndex();
    expect(result[0].clubAlbums[0].clubName).toBe('Legacy_Club');
    expect(result[0].clubAlbums[0].clubDisplayName).toBe('Legacy_Club');
  });

  it('sorts per-club albums by clubDisplayName ascending', () => {
    setEvents([
      makeEvent('evt-1', 'Spring 5K', '2026-04-15'),
    ]);
    mockListAllAlbums.mockReturnValue([
      makeAlbum('album-z',  'club', 'evt-1', 'Zebra_Runners'),
      makeAlbum('album-a',  'club', 'evt-1', 'Alpha_Club'),
      makeAlbum('album-m',  'club', 'evt-1', 'Middle_Crew'),
    ]);
    mockListActiveClubs.mockReturnValue([
      makeClub('Zebra_Runners', 'Zebra Runners'),
      makeClub('Alpha_Club',    'Alpha Club'),
      makeClub('Middle_Crew',   'Middle Crew'),
    ]);

    const result = listPublicAlbumIndex();
    const displayNames = result[0].clubAlbums.map((c) => c.clubDisplayName);
    expect(displayNames).toEqual(['Alpha Club', 'Middle Crew', 'Zebra Runners']);
  });

  it('club albums with an empty clubName are dropped', () => {
    // Defensive: if the Photo_Albums row is malformed (club type but no club
    // name), we should not surface it as a nameless entry.
    setEvents([
      makeEvent('evt-1', 'Spring 5K', '2026-04-15'),
    ]);
    mockListAllAlbums.mockReturnValue([
      makeAlbum('album-evt',  'event', 'evt-1'),
      makeAlbum('album-bad',  'club',  'evt-1', ''),   // malformed: no clubName
      makeAlbum('album-good', 'club',  'evt-1', 'New_Bee'),
    ]);

    const result = listPublicAlbumIndex();
    expect(result[0].clubAlbums).toHaveLength(1);
    expect(result[0].clubAlbums[0].clubName).toBe('New_Bee');
  });

  it('skips album rows whose eventId does not match any event', () => {
    setEvents([
      makeEvent('evt-real', 'Real Event', '2026-04-15'),
    ]);
    mockListAllAlbums.mockReturnValue([
      makeAlbum('album-real',    'event', 'evt-real'),
      makeAlbum('album-orphan',  'event', 'evt-deleted'),  // dangling
    ]);

    const result = listPublicAlbumIndex();
    expect(result).toHaveLength(1);
    expect(result[0].eventId).toBe('evt-real');
  });

  it('skips album rows with a missing eventId entirely', () => {
    setEvents([
      makeEvent('evt-1', 'Spring 5K', '2026-04-15'),
    ]);
    mockListAllAlbums.mockReturnValue([
      makeAlbum('album-valid', 'event', 'evt-1'),
      // Malformed row: eventId is empty string
      makeAlbum('album-bad',   'club',  '', 'Orphan_Club'),
    ]);

    const result = listPublicAlbumIndex();
    expect(result).toHaveLength(1);
    expect(result[0].clubAlbums).toHaveLength(0); // orphan club album excluded
  });

  it('carries the full PhotosAlbumRecord through to the output entry', () => {
    setEvents([
      makeEvent('evt-1', 'Spring 5K', '2026-04-15'),
    ]);
    const eventAlbum = makeAlbum('album-evt', 'event', 'evt-1');
    const clubAlbum  = makeAlbum('album-nb',  'club',  'evt-1', 'New_Bee');
    mockListAllAlbums.mockReturnValue([eventAlbum, clubAlbum]);

    const result = listPublicAlbumIndex();
    const entry = result[0];

    // eventAlbum surfaces the full record
    expect(entry.eventAlbum).toEqual(eventAlbum);
    // clubAlbum nested under .album
    expect(entry.clubAlbums[0].album).toEqual(clubAlbum);
    // Event metadata also preserved
    expect(entry.eventName).toBe('Spring 5K');
    expect(entry.eventDate).toBe('2026-04-15');
  });

  it('requests events with pageSize=10000, desc sort (treat-as-full-fetch contract)', () => {
    setEvents([]);
    listPublicAlbumIndex();

    expect(mockListAllEvents).toHaveBeenCalledWith(1, 10000, 'desc');
  });

  it('sorts defensively even if upstream events are not date-ordered', () => {
    // Upstream returns in scrambled order; the service should still produce
    // newest-first output so the page contract is independent of upstream.
    setEvents([
      makeEvent('evt-mid',    'Mid',    '2025-06-01'),
      makeEvent('evt-newest', 'Newest', '2026-01-01'),
      makeEvent('evt-old',    'Old',    '2024-06-01'),
    ]);
    mockListAllAlbums.mockReturnValue([
      makeAlbum('album-mid',    'event', 'evt-mid'),
      makeAlbum('album-newest', 'event', 'evt-newest'),
      makeAlbum('album-old',    'event', 'evt-old'),
    ]);

    const result: PublicAlbumIndexEntry[] = listPublicAlbumIndex();
    expect(result.map((e) => e.eventDate)).toEqual([
      '2026-01-01',
      '2025-06-01',
      '2024-06-01',
    ]);
  });
});
