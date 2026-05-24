/**
 * Unit tests for buildEventPhotosFolderUrlIndex — the pure helper that joins
 * Special_Folders records into the eventId → Photos_001 URL map used by the
 * Albums tab's new "Drive Folder" column.
 *
 * The function is pure (no GAS API calls), so the tests don't need to mock
 * sheet/drive services; we feed in plain typed records.
 */

jest.mock('../../src/services/sheetService');
jest.mock('../../src/services/driveService');
jest.mock('../../src/services/specialFoldersService');
jest.mock('../../src/services/eventService');
jest.mock('../../src/services/clubService');

import { buildEventPhotosFolderUrlIndex } from '../../src/services/publicSpreadsheetService';
import { SpecialFolderRecord } from '../../src/types/models';

function makePhotoFolder(
  overrides: Partial<SpecialFolderRecord> = {}
): SpecialFolderRecord {
  return {
    folderId:        'drv-photos-default',
    eventId:         'evt-001',
    scope:           'photos',
    clubName:        '',
    tag:             '',
    folderName:      'Photos_001',
    folderIndex:     1,
    folderUrl:       'https://drive.google.com/drive/folders/drv-photos-default',
    fileCount:       1,
    lastRefreshedAt: '2026-05-23T00:00:00.000Z',
    ...overrides,
  };
}

function makeVideoFolder(
  overrides: Partial<SpecialFolderRecord> = {}
): SpecialFolderRecord {
  return {
    folderId:        'drv-videos-default',
    eventId:         'evt-001',
    scope:           'videos',
    clubName:        'New_Bee',
    tag:             'finish_line',
    folderName:      'Videos',
    folderIndex:     1,
    folderUrl:       'https://drive.google.com/drive/folders/drv-videos-default',
    fileCount:       1,
    lastRefreshedAt: '2026-05-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('publicSpreadsheetService — buildEventPhotosFolderUrlIndex()', () => {
  it('returns an empty map for empty input', () => {
    expect(buildEventPhotosFolderUrlIndex([])).toEqual(new Map());
  });

  it('maps each event to the URL of its single Photos_001 bucket', () => {
    const records = [
      makePhotoFolder({
        eventId: 'evt-001',
        folderUrl: 'https://drive.google.com/drive/folders/aaa',
      }),
      makePhotoFolder({
        eventId: 'evt-002',
        folderUrl: 'https://drive.google.com/drive/folders/bbb',
      }),
    ];
    const result = buildEventPhotosFolderUrlIndex(records);
    expect(result.size).toBe(2);
    expect(result.get('evt-001')).toBe('https://drive.google.com/drive/folders/aaa');
    expect(result.get('evt-002')).toBe('https://drive.google.com/drive/folders/bbb');
  });

  it('prefers the lowest-folderIndex bucket when an event has overflow folders', () => {
    // The function exists to give visitors the natural "first page" link.
    // If Photos_002 is materialised in the records list before Photos_001
    // (out-of-order rebuild), the result must still point to Photos_001.
    const records = [
      makePhotoFolder({
        eventId:     'evt-001',
        folderName:  'Photos_002',
        folderIndex: 2,
        folderUrl:   'https://drive.google.com/drive/folders/page2',
      }),
      makePhotoFolder({
        eventId:     'evt-001',
        folderName:  'Photos_001',
        folderIndex: 1,
        folderUrl:   'https://drive.google.com/drive/folders/page1',
      }),
      makePhotoFolder({
        eventId:     'evt-001',
        folderName:  'Photos_003',
        folderIndex: 3,
        folderUrl:   'https://drive.google.com/drive/folders/page3',
      }),
    ];
    const result = buildEventPhotosFolderUrlIndex(records);
    expect(result.size).toBe(1);
    expect(result.get('evt-001')).toBe('https://drive.google.com/drive/folders/page1');
  });

  it('skips video-scope rows entirely', () => {
    const records = [
      makeVideoFolder({ eventId: 'evt-001' }),
      makeVideoFolder({ eventId: 'evt-002' }),
    ];
    expect(buildEventPhotosFolderUrlIndex(records)).toEqual(new Map());
  });

  it('mixes scopes correctly — photos contribute, videos are ignored', () => {
    const records = [
      makePhotoFolder({
        eventId:   'evt-001',
        folderUrl: 'https://drive.google.com/drive/folders/photos-1',
      }),
      makeVideoFolder({ eventId: 'evt-001' }), // ignored
      makeVideoFolder({ eventId: 'evt-002' }), // ignored — no entry for evt-002
    ];
    const result = buildEventPhotosFolderUrlIndex(records);
    expect(result.size).toBe(1);
    expect(result.get('evt-001')).toBe('https://drive.google.com/drive/folders/photos-1');
    expect(result.has('evt-002')).toBe(false);
  });

  it('drops rows with blank eventId or blank folderUrl defensively', () => {
    // Bad sheet data shouldn't poison the map. Empty eventId means we can't
    // join it to an album row anyway, and empty folderUrl means we have
    // nothing to render.
    const records = [
      makePhotoFolder({ eventId: '', folderUrl: 'https://example.com/x' }),
      makePhotoFolder({ eventId: 'evt-good', folderUrl: '' }),
      makePhotoFolder({
        eventId:   'evt-good',
        folderUrl: 'https://drive.google.com/drive/folders/keepme',
      }),
    ];
    const result = buildEventPhotosFolderUrlIndex(records);
    expect(result.size).toBe(1);
    expect(result.get('evt-good')).toBe(
      'https://drive.google.com/drive/folders/keepme'
    );
  });
});
