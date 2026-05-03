/**
 * Unit tests for the Folders-tab row builder in publicSpreadsheetService.
 *
 * buildFolderRows() is a pure function — given Special_Folders records plus
 * Events and Clubs lookups, it produces the 2D row layout that the Folders
 * tab will write. We mock the sheetService and driveService modules at the
 * module boundary the same way publicSpreadsheetService.test.ts does, so
 * this file's tests don't try to hit the GAS APIs.
 */

jest.mock('../../src/services/sheetService');
jest.mock('../../src/services/driveService');
jest.mock('../../src/services/specialFoldersService');
jest.mock('../../src/services/eventService');
jest.mock('../../src/services/clubService');

import { buildFolderRows } from '../../src/services/publicSpreadsheetService';
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

describe('publicSpreadsheetService — buildFolderRows()', () => {
  it('returns an empty array when no records are passed', () => {
    expect(buildFolderRows([], [makeEvent()], [makeClub()])).toEqual([]);
  });

  it('drops rows whose eventId is unknown to the Events list', () => {
    const orphan = makePhotoFolder({ eventId: 'evt-deleted-999' });
    const rows = buildFolderRows([orphan], [makeEvent()], [makeClub()]);
    expect(rows).toEqual([]);
  });

  it('emits one row per folder record with the expected column order', () => {
    const photo = makePhotoFolder();
    const rows = buildFolderRows([photo], [makeEvent()], [makeClub()]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // [Event Date, Event Name, Scope, Club, Tag, Folder Name,
    //  Folder Index, File Count, Folder Link, Last Refreshed]
    expect(row[0]).toBe('2026-04-19');
    expect(row[1]).toBe('NYC Marathon');
    expect(row[2]).toBe('Photos');
    expect(row[3]).toBe('');                    // photos rows have empty Club
    expect(row[4]).toBe('');                    // photos rows have empty Tag
    expect(row[5]).toBe('Photos_001');
    expect(row[6]).toBe(1);
    expect(row[7]).toBe(800);
    expect(row[8]).toBe(
      'https://drive.google.com/drive/folders/drv-photos-001'
    );
    expect(row[9]).toBe('2026-04-20T10:00:00.000Z');
  });

  it('renders Videos rows with the club display name and tag', () => {
    const video = makeVideoFolder();
    const rows = buildFolderRows([video], [makeEvent()], [makeClub()]);
    expect(rows).toHaveLength(1);
    expect(rows[0][2]).toBe('Videos');
    expect(rows[0][3]).toBe('New Bee');         // displayName, not normalizedName
    expect(rows[0][4]).toBe('finish_line');
  });

  it('falls back to the normalized club name when no club row matches', () => {
    const video = makeVideoFolder({ clubName: 'Unknown_Club' });
    const rows = buildFolderRows([video], [makeEvent()], []);
    expect(rows[0][3]).toBe('Unknown_Club');
  });

  it('sorts events newest-first, photos before videos within each event, and bucket index ascending', () => {
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
      makeVideoFolder({
        folderId: 'old-videos-1',
        eventId: 'evt-old',
        clubName: 'New_Bee',
        tag: 'a',
      }),
      makePhotoFolder({
        folderId: 'new-photos-001',
        eventId: 'evt-new',
        folderName: 'Photos_001',
        folderIndex: 1,
      }),
    ];
    const rows = buildFolderRows(records, [oldEvent, newEvent], [makeClub()]);

    // The newest event's photos row comes first.
    expect(rows[0][1]).toBe('New');
    expect(rows[0][2]).toBe('Photos');

    // Then the old event's two photo buckets in ascending index order…
    expect(rows[1][1]).toBe('Old');
    expect(rows[1][2]).toBe('Photos');
    expect(rows[1][6]).toBe(1);

    expect(rows[2][1]).toBe('Old');
    expect(rows[2][2]).toBe('Photos');
    expect(rows[2][6]).toBe(2);

    // …followed by the videos row.
    expect(rows[3][1]).toBe('Old');
    expect(rows[3][2]).toBe('Videos');
  });

  it('sorts video rows within an event by club display name then tag', () => {
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
    const rows = buildFolderRows(records, [makeEvent()], []);
    expect(rows.map((r) => `${r[3]}|${r[4]}`)).toEqual([
      'Alpha_Club|a',
      'Alpha_Club|b',
      'Zeta_Club|a',
    ]);
  });
});
