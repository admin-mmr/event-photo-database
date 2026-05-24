/**
 * Unit tests for the Photo Folders + Video Folders row builders in
 * publicSpreadsheetService.
 *
 * Both functions are pure — given Special_Folders records plus Events and
 * Clubs lookups, they produce the 2D row layout that the respective tab
 * will write. We mock the sheetService / driveService modules at the
 * module boundary the same way publicSpreadsheetService.test.ts does, so
 * this file's tests don't try to hit the GAS APIs.
 */

jest.mock('../../src/services/sheetService');
jest.mock('../../src/services/driveService');
jest.mock('../../src/services/specialFoldersService');
jest.mock('../../src/services/eventService');
jest.mock('../../src/services/clubService');

import {
  buildPhotoFolderRows,
  buildVideoFolderRows,
} from '../../src/services/publicSpreadsheetService';
import {
  EventRecord,
  ClubRecord,
  SpecialFolderRecord,
} from '../../src/types/models';

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    eventId: 'evt-001',
    eventName: 'NYC Marathon',
    eventDate: '2026-04-19',
    folderName: '2026-04-19_NYC_Marathon',
    driveFolderId: 'drv-evt-001',
    createdBy: 'admin@mmrunners.org',
    createdAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeClub(overrides: Partial<ClubRecord> = {}): ClubRecord {
  return {
    displayName: 'New Bee',
    normalizedName: 'New_Bee',
    status: 'active',
    addedDate: '2025-01-01',
    addedBy: 'admin@mmrunners.org',
    ...overrides,
  };
}

function makePhotoFolder(
  overrides: Partial<SpecialFolderRecord> = {}
): SpecialFolderRecord {
  return {
    folderId: 'drv-photos-001',
    eventId: 'evt-001',
    scope: 'photos',
    clubName: '',
    tag: '',
    folderName: 'Photos_001',
    folderIndex: 1,
    folderUrl: 'https://drive.google.com/drive/folders/drv-photos-001',
    fileCount: 800,
    lastRefreshedAt: '2026-04-20T10:00:00.000Z',
    ...overrides,
  };
}

function makeVideoFolder(
  overrides: Partial<SpecialFolderRecord> = {}
): SpecialFolderRecord {
  return {
    folderId: 'drv-videos-001',
    eventId: 'evt-001',
    scope: 'videos',
    clubName: 'New_Bee',
    tag: 'finish_line',
    folderName: 'Videos',
    folderIndex: 1,
    folderUrl: 'https://drive.google.com/drive/folders/drv-videos-001',
    fileCount: 12,
    lastRefreshedAt: '2026-04-20T10:00:00.000Z',
    ...overrides,
  };
}

// ─── buildPhotoFolderRows ────────────────────────────────────────────────────

describe('publicSpreadsheetService — buildPhotoFolderRows()', () => {
  it('returns an empty array when no records are passed', () => {
    expect(buildPhotoFolderRows([], [makeEvent()])).toEqual([]);
  });

  it('ignores video-scope records — Photo Folders tab is photos only', () => {
    const rows = buildPhotoFolderRows([makeVideoFolder()], [makeEvent()]);
    expect(rows).toEqual([]);
  });

  it('drops rows whose eventId is unknown to the Events list', () => {
    const orphan = makePhotoFolder({ eventId: 'evt-deleted-999' });
    const rows = buildPhotoFolderRows([orphan], [makeEvent()]);
    expect(rows).toEqual([]);
  });

  it('emits one row per Photos_NNN bucket with the expected column order', () => {
    const photo = makePhotoFolder();
    const rows = buildPhotoFolderRows([photo], [makeEvent()]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // [Event Date, Event Name, Folder Name, Folder Index, File Count,
    //  Folder Link, Last Refreshed]
    expect(row[0]).toBe('2026-04-19');
    expect(row[1]).toBe('NYC Marathon');
    expect(row[2]).toBe('Photos_001');
    expect(row[3]).toBe(1);
    expect(row[4]).toBe(800);
    expect(row[5]).toBe(
      'https://drive.google.com/drive/folders/drv-photos-001'
    );
    expect(row[6]).toBe('2026-04-20T10:00:00.000Z');
  });

  it('sorts events newest-first and bucket index ascending within an event', () => {
    const oldEvent = makeEvent({
      eventId: 'evt-old',
      eventDate: '2025-01-01',
      eventName: 'Old',
    });
    const newEvent = makeEvent({
      eventId: 'evt-new',
      eventDate: '2026-12-31',
      eventName: 'New',
    });
    const records: SpecialFolderRecord[] = [
      makePhotoFolder({
        folderId: 'old-photos-002',
        eventId: 'evt-old',
        folderName: 'Photos_002',
        folderIndex: 2,
      }),
      makePhotoFolder({
        folderId: 'old-photos-001',
        eventId: 'evt-old',
        folderName: 'Photos_001',
        folderIndex: 1,
      }),
      makePhotoFolder({
        folderId: 'new-photos-001',
        eventId: 'evt-new',
        folderName: 'Photos_001',
        folderIndex: 1,
      }),
    ];
    const rows = buildPhotoFolderRows(records, [oldEvent, newEvent]);

    // Newest event first.
    expect(rows[0][1]).toBe('New');
    expect(rows[0][2]).toBe('Photos_001');

    // Then the old event's two photo buckets in ascending index order.
    expect(rows[1][1]).toBe('Old');
    expect(rows[1][3]).toBe(1);
    expect(rows[2][1]).toBe('Old');
    expect(rows[2][3]).toBe(2);
  });
});

// ─── buildVideoFolderRows ────────────────────────────────────────────────────

describe('publicSpreadsheetService — buildVideoFolderRows()', () => {
  it('returns an empty array when no records are passed', () => {
    expect(buildVideoFolderRows([], [makeEvent()], [makeClub()])).toEqual([]);
  });

  it('ignores photo-scope records — Video Folders tab is videos only', () => {
    const rows = buildVideoFolderRows(
      [makePhotoFolder()],
      [makeEvent()],
      [makeClub()]
    );
    expect(rows).toEqual([]);
  });

  it('drops rows whose eventId is unknown to the Events list', () => {
    const orphan = makeVideoFolder({ eventId: 'evt-deleted-999' });
    const rows = buildVideoFolderRows([orphan], [makeEvent()], [makeClub()]);
    expect(rows).toEqual([]);
  });

  it('emits one row per Videos folder with club display name, tag, and link', () => {
    const video = makeVideoFolder();
    const rows = buildVideoFolderRows([video], [makeEvent()], [makeClub()]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // [Event Date, Event Name, Club, Tag, Folder Name, File Count,
    //  Folder Link, Last Refreshed]
    expect(row[0]).toBe('2026-04-19');
    expect(row[1]).toBe('NYC Marathon');
    expect(row[2]).toBe('New Bee');       // displayName, not normalizedName
    expect(row[3]).toBe('finish_line');
    expect(row[4]).toBe('Videos');
    expect(row[5]).toBe(12);
    expect(row[6]).toBe(
      'https://drive.google.com/drive/folders/drv-videos-001'
    );
    expect(row[7]).toBe('2026-04-20T10:00:00.000Z');
  });

  it('falls back to the normalized club name when no club row matches', () => {
    const video = makeVideoFolder({ clubName: 'Unknown_Club' });
    const rows = buildVideoFolderRows([video], [makeEvent()], []);
    expect(rows[0][2]).toBe('Unknown_Club');
  });

  it('sorts video rows newest-first by event, then by club display name, then by tag', () => {
    const records: SpecialFolderRecord[] = [
      makeVideoFolder({
        folderId: 'v-zeta',
        clubName: 'Zeta_Club',
        tag: 'a',
      }),
      makeVideoFolder({
        folderId: 'v-alpha-b',
        clubName: 'Alpha_Club',
        tag: 'b',
      }),
      makeVideoFolder({
        folderId: 'v-alpha-a',
        clubName: 'Alpha_Club',
        tag: 'a',
      }),
    ];
    // No matching ClubRecord rows ⇒ falls back to normalizedName, so
    // sort order is "Alpha_Club" < "Zeta_Club" lexicographically.
    const rows = buildVideoFolderRows(records, [makeEvent()], []);
    expect(rows.map((r) => `${r[2]}|${r[3]}`)).toEqual([
      'Alpha_Club|a',
      'Alpha_Club|b',
      'Zeta_Club|a',
    ]);
  });
});
