/**
 * photosService.test.ts — Characterization tests for album lifecycle and the
 * syncBatchToAlbums hot path.
 *
 * Coverage:
 *   1. findAlbumByEvent() / findAlbumsByEvent() / findAlbumByEventAndClub()
 *   2. ensureEventAlbum()   — idempotent create + Photos API error handling
 *   3. ensureClubAlbum()    — idempotent create + Photos API error handling
 *   4. syncBatchToAlbums()  — the main hot path:
 *        • dedup set built from Photo_Files ONCE and shared across both albums
 *        • updateAlbumSyncStats called for both albums after sync
 *        • error propagation from sub-syncs
 *        • early-exit on missing event/club album
 *        • SHEET READ COUNT assertions (the baseline for §3.1 refactor)
 *
 * These tests are intentionally characterization tests: they capture existing
 * observable behavior so any refactor of the hot path can be verified against
 * this baseline without breaking correctness.
 *
 * GAS globals (ScriptApp, UrlFetchApp, DriveApp, Logger) and service-layer I/O
 * (sheetService, syncJobService) are all mocked.
 */

import {
  findAlbumByEvent,
  findAlbumsByEvent,
  ensureEventAlbum,
  ensureClubTagAlbum,
  syncBatchToAlbums,
} from '../../src/services/photosService';
import { ResultStatus } from '../../src/types/enums';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../../src/services/sheetService', () => ({
  getAllRows: jest.fn(),
  appendRow:  jest.fn(),
  updateRow:  jest.fn(),
}));

jest.mock('../../src/config/constants', () => ({
  getConfig: jest.fn(() => ({
    SPREADSHEET_ID: 'test-spreadsheet-id',
    ROOT_FOLDER_ID: 'test-root-folder-id',
    SHEET_NAMES: {
      USERS:        'Users',
      EVENTS:       'Events',
      UPLOAD_LOG:   'Upload_Log',
      RATE_LIMIT:   'Rate_Limit',
      CLUBS:        'Clubs',
      AUDIT_LOG:    'Audit_Log',
      PHOTO_ALBUMS: 'Photo_Albums',
      PHOTO_FILES:  'Photo_Files',
    },
    MAX_FILE_SIZE_MB: 50,
    MAX_BATCH_SIZE_MB: 200,
    MAX_API_REQUESTS_PER_HOUR: 60,
  })),
  COLUMNS: {
    PHOTO_ALBUMS: {
      ALBUM_ID: 0, ALBUM_TYPE: 1, EVENT_ID: 2, CLUB_NAME: 3, TAG: 4,
      ALBUM_TITLE: 5, ALBUM_URL: 6, SHAREABLE_URL: 7,
      CREATED_AT: 8, LAST_SYNC_AT: 9, SYNCED_FILE_COUNT: 10,
    },
    PHOTO_FILES: {
      DRIVE_FILE_ID: 0, MEDIA_ITEM_ID: 1, ALBUM_ID: 2, ALBUM_TYPE: 3,
      EVENT_ID: 4, CLUB_NAME: 5, TAG: 6, FILE_NAME: 7, SYNCED_AT: 8,
    },
    EVENTS: {
      EVENT_ID: 0, EVENT_NAME: 1, EVENT_DATE: 2,
      FOLDER_NAME: 3, DRIVE_FOLDER_ID: 4, CREATED_BY: 5, CREATED_AT: 6,
    },
  },
  MAX_API_REQUESTS_PER_HOUR: 60,
  RATE_LIMIT_WINDOW_MS: 3600000,
}));

jest.mock('../../src/services/syncJobService', () => ({
  incrementJobCounters: jest.fn(),
  isCancelRequested:    jest.fn(() => false),
  updateJob:            jest.fn(),
}));

// ─── GAS globals ─────────────────────────────────────────────────────────────

(global as unknown as Record<string, unknown>).Logger = { log: jest.fn() };

(global as unknown as Record<string, unknown>).ScriptApp = {
  getOAuthToken: jest.fn(() => 'mock-oauth-token'),
};

const mockFetch = jest.fn();
(global as unknown as Record<string, unknown>).UrlFetchApp = { fetch: mockFetch };

const mockGetFolderById = jest.fn();
const mockGetFileById   = jest.fn();
(global as unknown as Record<string, unknown>).DriveApp = {
  getFolderById: mockGetFolderById,
  getFileById:   mockGetFileById,
};

// ─── Import mocked sheetService helpers ──────────────────────────────────────

import { getAllRows, appendRow, updateRow } from '../../src/services/sheetService';
const mockGetAllRows = getAllRows as jest.Mock;
const mockAppendRow  = appendRow  as jest.Mock;
const mockUpdateRow  = updateRow  as jest.Mock;

// ─── Fixture builders ─────────────────────────────────────────────────────────

/**
 * Builds a Photo_Albums sheet row in column order [0..10].
 * Defaults: albumType='event', clubName='', syncedFileCount=0, tag=''.
 */
function makeAlbumRow(
  albumId:         string,
  albumType:       'event' | 'club' = 'event',
  eventId          = 'evt-uuid-001',
  clubName         = '',
  syncedFileCount  = 0,
  lastSyncAt       = '',
  tag              = '',
): unknown[] {
  // columns: albumId, albumType, eventId, clubName, tag, albumTitle, albumUrl, shareableUrl,
  //          createdAt, lastSyncAt, syncedFileCount
  const tagValue = albumType === 'event' ? '' : tag;
  return [
    albumId, albumType, eventId, clubName, tagValue,
    `Album ${albumId}`, `https://photos/${albumId}`, `https://share/${albumId}`,
    '2026-04-19T09:00:00.000Z', lastSyncAt, syncedFileCount,
  ];
}

/**
 * Builds a Photo_Files sheet row in column order [0..8].
 */
function makeFileRow(
  driveFileId: string,
  albumId:     string,
  albumType:   'event' | 'club' = 'event',
  clubName     = '',
  eventId      = 'evt-uuid-001',
): unknown[] {
  const tagValue = albumType === 'event' ? '' : 'finish_line';
  return [
    driveFileId, 'media-' + driveFileId, albumId,
    albumType, eventId, clubName, tagValue, 'photo.jpg', '2026-04-19T10:00:00.000Z',
  ];
}

/**
 * Builds mock UrlFetchApp responses for one Photos API album creation.
 * Returns the response mock (POST /albums → { id, productUrl }).
 */
function makeAlbumCreateResponse(albumId: string) {
  return {
    getResponseCode: jest.fn(() => 200),
    getContentText: jest.fn(() =>
      JSON.stringify({ id: albumId, productUrl: `https://photos.google.com/album/${albumId}` })
    ),
  };
}

/**
 * Builds upload token + batchCreate response mocks for one file upload.
 */
function makeFileUploadResponses(mediaItemId: string) {
  const uploadResp = {
    getResponseCode: jest.fn(() => 200),
    getContentText:  jest.fn(() => `upload-token-${mediaItemId}`),
  };
  const createResp = {
    getResponseCode: jest.fn(() => 200),
    getContentText:  jest.fn(() =>
      JSON.stringify({ newMediaItemResults: [{ mediaItem: { id: mediaItemId } }] })
    ),
  };
  return [uploadResp, createResp];
}

/**
 * Builds the 3-response sequence used by the batched two-album flow:
 *   1. POST /uploads          → uploadToken
 *   2. POST /mediaItems:batchCreate → mediaItemId(s) — attached to event album
 *   3. POST /albums/{id}:batchAddMediaItems → ok      — attaches same mediaItem to club/tag album
 *
 * Pass mediaItemIds for each pending file in the order they will be uploaded.
 * Returns the response mocks ready to be threaded into mockFetch.mockReturnValueOnce
 * in this exact order: [upload×N, batchCreate, batchAddMediaItems].
 */
function makeTwoAlbumBatchResponses(mediaItemIds: string[]) {
  const uploads = mediaItemIds.map((id) => ({
    getResponseCode: jest.fn(() => 200),
    getContentText:  jest.fn(() => `upload-token-${id}`),
  }));
  const batchCreate = {
    getResponseCode: jest.fn(() => 200),
    getContentText:  jest.fn(() =>
      JSON.stringify({
        newMediaItemResults: mediaItemIds.map((id) => ({ mediaItem: { id } })),
      })
    ),
  };
  const batchAdd = {
    getResponseCode: jest.fn(() => 200),
    getContentText:  jest.fn(() => '{}'),
  };
  return { uploads, batchCreate, batchAdd };
}

function makeMockFile(id: string, name: string, mimeType = 'image/jpeg') {
  return {
    getId:       jest.fn(() => id),
    getName:     jest.fn(() => name),
    getMimeType: jest.fn(() => mimeType),
    getBlob:     jest.fn(() => ({ getBytes: jest.fn(() => new Uint8Array([1, 2, 3])) })),
  };
}

function makeMockFileIter(files: ReturnType<typeof makeMockFile>[]) {
  let i = 0;
  return {
    hasNext: jest.fn(() => i < files.length),
    next:    jest.fn(() => files[i++]),
  };
}

function makeMockFolder(
  id: string,
  name: string,
  files: ReturnType<typeof makeMockFile>[] = [],
) {
  return {
    getId:      jest.fn(() => id),
    getName:    jest.fn(() => name),
    getFiles:   jest.fn(() => makeMockFileIter(files)),
    getFolders: jest.fn(() => makeMockFileIter([])),
  };
}

// ─── 1. findAlbumByEvent() ────────────────────────────────────────────────────

describe('findAlbumByEvent()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns null when Photo_Albums sheet is empty', () => {
    mockGetAllRows.mockReturnValue([]);
    expect(findAlbumByEvent('evt-uuid-001')).toBeNull();
  });

  it('returns null when no event-type album exists for the eventId', () => {
    mockGetAllRows.mockReturnValue([
      makeAlbumRow('album-club-001', 'club', 'evt-uuid-001', 'New_Bee'),
    ]);
    expect(findAlbumByEvent('evt-uuid-001')).toBeNull();
  });

  it('returns the event album record when it exists', () => {
    mockGetAllRows.mockReturnValue([
      makeAlbumRow('album-event-001', 'event', 'evt-uuid-001'),
      makeAlbumRow('album-club-001',  'club',  'evt-uuid-001', 'New_Bee'),
    ]);
    const result = findAlbumByEvent('evt-uuid-001');
    expect(result).not.toBeNull();
    expect(result!.albumId).toBe('album-event-001');
    expect(result!.albumType).toBe('event');
  });

  it('returns null when the event album belongs to a different eventId', () => {
    mockGetAllRows.mockReturnValue([
      makeAlbumRow('album-event-other', 'event', 'evt-uuid-OTHER'),
    ]);
    expect(findAlbumByEvent('evt-uuid-001')).toBeNull();
  });

  it('reads the Photo_Albums sheet (not Photo_Files)', () => {
    mockGetAllRows.mockReturnValue([]);
    findAlbumByEvent('evt-uuid-001');
    expect(mockGetAllRows).toHaveBeenCalledWith('Photo_Albums');
    expect(mockGetAllRows).not.toHaveBeenCalledWith('Photo_Files');
  });
});

// ─── 2. findAlbumsByEvent() ───────────────────────────────────────────────────

describe('findAlbumsByEvent()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns empty array when sheet is empty', () => {
    mockGetAllRows.mockReturnValue([]);
    expect(findAlbumsByEvent('evt-uuid-001')).toEqual([]);
  });

  it('returns only albums for the given eventId', () => {
    mockGetAllRows.mockReturnValue([
      makeAlbumRow('album-evt-001', 'event', 'evt-uuid-001'),
      makeAlbumRow('album-club-001', 'club',  'evt-uuid-001', 'New_Bee'),
      makeAlbumRow('album-evt-other', 'event', 'evt-uuid-OTHER'),
    ]);
    const results = findAlbumsByEvent('evt-uuid-001');
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.eventId === 'evt-uuid-001')).toBe(true);
  });

  it('returns both event and club albums for the same event', () => {
    mockGetAllRows.mockReturnValue([
      makeAlbumRow('album-event', 'event', 'evt-uuid-001'),
      makeAlbumRow('album-club',  'club',  'evt-uuid-001', 'New_Bee'),
    ]);
    const results = findAlbumsByEvent('evt-uuid-001');
    const types = results.map((r) => r.albumType).sort();
    expect(types).toEqual(['club', 'event']);
  });
});

// ─── 3. ensureEventAlbum() ────────────────────────────────────────────────────

describe('ensureEventAlbum()', () => {
  const EVENT_ID   = 'evt-uuid-001';
  const EVENT_NAME = 'Boston Marathon';
  const EVENT_DATE = '2026-04-19';

  beforeEach(() => jest.clearAllMocks());

  it('creates a new album when none exists, saves it, and returns it', () => {
    // No existing albums in sheet
    mockGetAllRows.mockReturnValue([]);
    mockFetch.mockReturnValueOnce(makeAlbumCreateResponse('new-album-id'));

    const result = ensureEventAlbum(EVENT_ID, EVENT_NAME, EVENT_DATE);

    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data).not.toBeNull();
    expect(result.data!.albumId).toBe('new-album-id');
    expect(result.data!.albumType).toBe('event');
    expect(result.data!.eventId).toBe(EVENT_ID);
    expect(result.data!.albumTitle).toBe(`${EVENT_DATE} ${EVENT_NAME}`);

    // Must have written a row to Photo_Albums
    expect(mockAppendRow).toHaveBeenCalledTimes(1);
    expect(mockAppendRow).toHaveBeenCalledWith(
      'Photo_Albums',
      expect.arrayContaining(['new-album-id', 'event', EVENT_ID])
    );
  });

  it('returns existing record without calling Photos API when album already exists', () => {
    mockGetAllRows.mockReturnValue([
      makeAlbumRow('existing-album-id', 'event', EVENT_ID),
    ]);

    const result = ensureEventAlbum(EVENT_ID, EVENT_NAME, EVENT_DATE);

    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.albumId).toBe('existing-album-id');
    // No API call, no sheet write
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockAppendRow).not.toHaveBeenCalled();
  });

  it('returns error when Photos API call fails', () => {
    mockGetAllRows.mockReturnValue([]);
    mockFetch.mockReturnValueOnce({
      getResponseCode: jest.fn(() => 500),
      getContentText:  jest.fn(() => 'Internal Server Error'),
    });

    const result = ensureEventAlbum(EVENT_ID, EVENT_NAME, EVENT_DATE);

    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('Failed to create Photos album');
    expect(mockAppendRow).not.toHaveBeenCalled();
  });

  it('uses the correct album title format: "YYYY-MM-DD EventName"', () => {
    mockGetAllRows.mockReturnValue([]);
    mockFetch.mockReturnValueOnce(makeAlbumCreateResponse('album-title-test'));

    const result = ensureEventAlbum(EVENT_ID, 'Spring Sprint', '2026-05-01');

    expect(result.data!.albumTitle).toBe('2026-05-01 Spring Sprint');
    // Verify the API call used this title
    const fetchCall = mockFetch.mock.calls[0];
    const payload = JSON.parse(fetchCall[1].payload);
    expect(payload.album.title).toBe('2026-05-01 Spring Sprint');
  });

  it('is idempotent: second call returns the same album without a new API call', () => {
    // First call: empty sheet → create album
    mockGetAllRows.mockReturnValueOnce([]);
    mockFetch.mockReturnValueOnce(makeAlbumCreateResponse('album-001'));
    const first = ensureEventAlbum(EVENT_ID, EVENT_NAME, EVENT_DATE);
    expect(first.data!.albumId).toBe('album-001');

    // Second call: album row is now present (simulated)
    mockGetAllRows.mockReturnValueOnce([
      makeAlbumRow('album-001', 'event', EVENT_ID),
    ]);
    const second = ensureEventAlbum(EVENT_ID, EVENT_NAME, EVENT_DATE);

    expect(second.data!.albumId).toBe('album-001');
    expect(mockFetch).toHaveBeenCalledTimes(1); // only one Photos API call total
  });
});

// ─── 4. ensureClubAlbum() ─────────────────────────────────────────────────────

describe('ensureClubAlbum()', () => {
  const EVENT_ID     = 'evt-uuid-001';
  const EVENT_NAME   = 'Boston Marathon';
  const EVENT_DATE   = '2026-04-19';
  const CLUB_NAME    = 'New_Bee';
  const CLUB_DISPLAY = 'New Bee';

  beforeEach(() => jest.clearAllMocks());

  it('creates a new club album when none exists', () => {
    mockGetAllRows.mockReturnValue([]);
    mockFetch.mockReturnValueOnce(makeAlbumCreateResponse('club-album-id'));

    const result = ensureClubTagAlbum(EVENT_ID, EVENT_NAME, EVENT_DATE, CLUB_NAME, CLUB_DISPLAY, 'finish_line');

    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.albumId).toBe('club-album-id');
    expect(result.data!.albumType).toBe('club');
    expect(result.data!.clubName).toBe(CLUB_NAME);
    expect(result.data!.albumTitle).toContain(CLUB_DISPLAY);
    expect(result.data!.albumTitle).toContain(EVENT_DATE);
    expect(mockAppendRow).toHaveBeenCalledTimes(1);
  });

  it('uses the correct album title format: "YYYY-MM-DD EventName – ClubDisplayName"', () => {
    mockGetAllRows.mockReturnValue([]);
    mockFetch.mockReturnValueOnce(makeAlbumCreateResponse('club-title-test'));

    const result = ensureClubTagAlbum(EVENT_ID, 'City Run', '2026-06-15', 'Speed_Demon', 'Speed Demon', 'finish_line');

    expect(result.data!.albumTitle).toBe('2026-06-15 City Run \u2013 Speed Demon \u2013 finish_line');
  });

  it('returns existing record without calling Photos API when album already exists', () => {
    mockGetAllRows.mockReturnValue([
      makeAlbumRow('existing-club-album', 'club', EVENT_ID, CLUB_NAME, 0, '', 'finish_line'),
    ]);

    const result = ensureClubTagAlbum(EVENT_ID, EVENT_NAME, EVENT_DATE, CLUB_NAME, CLUB_DISPLAY, 'finish_line');

    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.albumId).toBe('existing-club-album');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not confuse albums belonging to a different club', () => {
    // Only a different club's album exists
    mockGetAllRows.mockReturnValue([
      makeAlbumRow('other-club-album', 'club', EVENT_ID, 'Other_Club', 0, '', 'finish_line'),
    ]);
    mockFetch.mockReturnValueOnce(makeAlbumCreateResponse('new-club-album'));

    const result = ensureClubTagAlbum(EVENT_ID, EVENT_NAME, EVENT_DATE, CLUB_NAME, CLUB_DISPLAY, 'finish_line');

    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.albumId).toBe('new-club-album');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns error when Photos API call fails', () => {
    mockGetAllRows.mockReturnValue([]);
    mockFetch.mockReturnValueOnce({
      getResponseCode: jest.fn(() => 403),
      getContentText:  jest.fn(() => '{"error":{"code":403,"message":"Permission denied"}}'),
    });

    const result = ensureClubTagAlbum(EVENT_ID, EVENT_NAME, EVENT_DATE, CLUB_NAME, CLUB_DISPLAY, 'finish_line');

    expect(result.status).toBe(ResultStatus.ERROR);
    expect(mockAppendRow).not.toHaveBeenCalled();
  });

  it('does not confuse albums for the same club in a different event', () => {
    // Same club name, different event
    mockGetAllRows.mockReturnValue([
      makeAlbumRow('other-event-club', 'club', 'evt-uuid-OTHER', CLUB_NAME, 0, '', 'finish_line'),
    ]);
    mockFetch.mockReturnValueOnce(makeAlbumCreateResponse('correct-club-album'));

    const result = ensureClubTagAlbum(EVENT_ID, EVENT_NAME, EVENT_DATE, CLUB_NAME, CLUB_DISPLAY, 'finish_line');

    expect(result.data!.albumId).toBe('correct-club-album');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── 5. syncBatchToAlbums() ───────────────────────────────────────────────────

describe('syncBatchToAlbums()', () => {
  const EVENT_ID      = 'evt-uuid-001';
  const EVENT_NAME    = 'Test Marathon';
  const EVENT_DATE    = '2026-04-19';
  const CLUB_NAME     = 'New_Bee';
  const CLUB_DISPLAY  = 'New Bee';
  const BATCH_ID      = 'batch-folder-id';
  const EVENT_ALBUM   = 'album-event-001';
  const CLUB_ALBUM    = 'album-club-001';

  beforeEach(() => jest.clearAllMocks());

  /**
   * Configures getAllRows to return:
   *   - Photo_Albums: one event album + one club album (pre-existing)
   *   - Photo_Files:  the provided existing file rows
   *
   * This is the "both albums already exist" fast path used by most tests.
   */
  function setupExistingAlbums(existingFileRows: unknown[][] = []) {
    mockGetAllRows.mockImplementation((sheetName: string) => {
      if (sheetName === 'Photo_Albums') {
        return [
          makeAlbumRow(EVENT_ALBUM, 'event', EVENT_ID, '', 5),
          // Club album fixture must carry the same tag as the syncBatchToAlbums
          // call (tests pass 'finish_line') — otherwise the (club, tag) lookup
          // misses and a fresh album would be requested.
          makeAlbumRow(CLUB_ALBUM,  'club',  EVENT_ID, CLUB_NAME, 3, '', 'finish_line'),
        ];
      }
      if (sheetName === 'Photo_Files') {
        return existingFileRows;
      }
      return [];
    });
  }

  it('returns success with synced counts when both albums already exist', () => {
    setupExistingAlbums();
    // Empty batch folder
    mockGetFolderById.mockReturnValue(makeMockFolder(BATCH_ID, 'batch', []));

    const result = syncBatchToAlbums(
      EVENT_ID, EVENT_NAME, EVENT_DATE, CLUB_NAME, CLUB_DISPLAY, 'finish_line', BATCH_ID
    );

    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.eventAlbumId).toBe(EVENT_ALBUM);
    expect(result.data!.clubTagAlbumId).toBe(CLUB_ALBUM);
    expect(result.data!.eventSynced).toBe(0);
    expect(result.data!.clubTagSynced).toBe(0);
    expect(result.data!.errors).toHaveLength(0);
  });

  it('returns error when event album cannot be created', () => {
    // No albums in sheet
    mockGetAllRows.mockReturnValue([]);
    // Photos API fails for album creation
    mockFetch.mockReturnValueOnce({
      getResponseCode: jest.fn(() => 500),
      getContentText:  jest.fn(() => 'Server error'),
    });

    const result = syncBatchToAlbums(
      EVENT_ID, EVENT_NAME, EVENT_DATE, CLUB_NAME, CLUB_DISPLAY, 'finish_line', BATCH_ID
    );

    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('Cannot ensure event album');
  });

  it('returns error when club album cannot be created', () => {
    // Event album exists; no club album
    mockGetAllRows.mockImplementation((sheetName: string) => {
      if (sheetName === 'Photo_Albums') {
        return [makeAlbumRow(EVENT_ALBUM, 'event', EVENT_ID)];
      }
      return [];
    });
    // Club album creation fails
    mockFetch.mockReturnValueOnce({
      getResponseCode: jest.fn(() => 403),
      getContentText:  jest.fn(() => 'Permission denied'),
    });

    const result = syncBatchToAlbums(
      EVENT_ID, EVENT_NAME, EVENT_DATE, CLUB_NAME, CLUB_DISPLAY, 'finish_line', BATCH_ID
    );

    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('Cannot ensure club/tag album');
  });

  it('uploads a new file to both event and club albums', () => {
    setupExistingAlbums(); // no existing synced files
    const jpgFile = makeMockFile('drive-new', 'photo.jpg', 'image/jpeg');
    mockGetFolderById.mockReturnValue(makeMockFolder(BATCH_ID, 'batch', [jpgFile]));
    mockGetFileById.mockReturnValue({
      getBlob: jest.fn(() => ({ getBytes: jest.fn(() => new Uint8Array([1])) })),
    });

    // New batched flow: 1 upload + 1 batchCreate + 1 batchAddMediaItems = 3 fetches.
    const seq = makeTwoAlbumBatchResponses(['media-shared']);
    mockFetch
      .mockReturnValueOnce(seq.uploads[0])
      .mockReturnValueOnce(seq.batchCreate)
      .mockReturnValueOnce(seq.batchAdd);

    const result = syncBatchToAlbums(
      EVENT_ID, EVENT_NAME, EVENT_DATE, CLUB_NAME, CLUB_DISPLAY, 'finish_line', BATCH_ID
    );

    expect(result.data!.eventSynced).toBe(1);
    expect(result.data!.clubTagSynced).toBe(1);
    // Two Photo_Files rows appended (one per album), but only one mediaItem
    // and one /uploads request — bytes only travel the wire once.
    expect(mockAppendRow).toHaveBeenCalledTimes(2);
  });

  it('deduplicates: files already in Photo_Files are skipped for both albums', () => {
    const existingFiles = [
      makeFileRow('drive-dup', EVENT_ALBUM, 'event', '',       EVENT_ID),
      makeFileRow('drive-dup', CLUB_ALBUM,  'club',  CLUB_NAME, EVENT_ID),
    ];
    setupExistingAlbums(existingFiles);

    const dupFile = makeMockFile('drive-dup', 'dup.jpg', 'image/jpeg');
    mockGetFolderById.mockReturnValue(makeMockFolder(BATCH_ID, 'batch', [dupFile]));

    const result = syncBatchToAlbums(
      EVENT_ID, EVENT_NAME, EVENT_DATE, CLUB_NAME, CLUB_DISPLAY, 'finish_line', BATCH_ID
    );

    expect(result.data!.eventSynced).toBe(0);
    expect(result.data!.clubTagSynced).toBe(0);
    // No Photos API calls, no sheet writes
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockAppendRow).not.toHaveBeenCalled();
  });

  it('reads Photo_Files exactly once for the batched two-album sync', () => {
    setupExistingAlbums();
    const jpgFile = makeMockFile('drive-shared', 'photo.jpg', 'image/jpeg');
    mockGetFolderById.mockReturnValue(makeMockFolder(BATCH_ID, 'batch', [jpgFile]));
    mockGetFileById.mockReturnValue({
      getBlob: jest.fn(() => ({ getBytes: jest.fn(() => new Uint8Array([1])) })),
    });

    const seq = makeTwoAlbumBatchResponses(['media-shared']);
    mockFetch
      .mockReturnValueOnce(seq.uploads[0])
      .mockReturnValueOnce(seq.batchCreate)
      .mockReturnValueOnce(seq.batchAdd);

    const result = syncBatchToAlbums(
      EVENT_ID, EVENT_NAME, EVENT_DATE, CLUB_NAME, CLUB_DISPLAY, 'finish_line', BATCH_ID
    );

    // The file is uploaded once and attached to both albums via a single
    // batchAddMediaItems pass — no duplicate Photos library entry.
    expect(result.data!.eventSynced).toBe(1);
    expect(result.data!.clubTagSynced).toBe(1);
    // Photo_Files is read exactly ONCE (shared dedup set).
    const photoFilesReadCount = (mockGetAllRows.mock.calls as string[][])
      .filter((call) => call[0] === 'Photo_Files').length;
    expect(photoFilesReadCount).toBe(1);
  });

  it('surfaces an error when /uploads fails for a file', () => {
    setupExistingAlbums();
    const jpgFile = makeMockFile('drive-fail', 'fail.jpg', 'image/jpeg');
    mockGetFolderById.mockReturnValue(makeMockFolder(BATCH_ID, 'batch', [jpgFile]));
    mockGetFileById.mockReturnValue({
      getBlob: jest.fn(() => ({ getBytes: jest.fn(() => new Uint8Array([1])) })),
    });

    // /uploads fails — neither album sees the file.
    mockFetch.mockReturnValueOnce({
      getResponseCode: jest.fn(() => 503),
      getContentText:  jest.fn(() => 'Service Unavailable'),
    });

    const result = syncBatchToAlbums(
      EVENT_ID, EVENT_NAME, EVENT_DATE, CLUB_NAME, CLUB_DISPLAY, 'finish_line', BATCH_ID
    );

    expect(result.status).toBe(ResultStatus.SUCCESS); // overall success
    expect(result.data!.eventSynced).toBe(0);
    expect(result.data!.clubTagSynced).toBe(0);
    expect(result.data!.errors.length).toBeGreaterThan(0);
    expect(result.data!.errors[0]).toContain('byte upload failed');
  });

  it('calls updateRow to persist sync stats for both albums after a sync', () => {
    setupExistingAlbums();
    mockGetFolderById.mockReturnValue(makeMockFolder(BATCH_ID, 'batch', []));

    syncBatchToAlbums(EVENT_ID, EVENT_NAME, EVENT_DATE, CLUB_NAME, CLUB_DISPLAY, 'finish_line', BATCH_ID);

    // updateAlbumSyncStats is called twice — once for event album, once for club album.
    // Each call does: getAllRows(PHOTO_ALBUMS) + updateRow(PHOTO_ALBUMS, rowIndex, newRow)
    const updateRowCalls = (mockUpdateRow.mock.calls as unknown[][])
      .filter((call) => call[0] === 'Photo_Albums');
    expect(updateRowCalls).toHaveLength(2);
  });

  // ── §3.1 BASELINE: sheet read counts ─────────────────────────────────────────
  //
  // These assertions capture the CURRENT number of getAllRows calls made per
  // syncBatchToAlbums invocation so that any refactor can be verified to have
  // reduced (or at least not increased) the count.
  //
  // Expected baseline (before §3.1 refactor):
  //   Photo_Files reads : 1  (loadFileRecords once in syncBatchToAlbums)
  //   Photo_Albums reads: 4  (loadAlbums × 2 for ensureEventAlbum + ensureClubAlbum,
  //                           + getAllRows × 2 for updateAlbumSyncStats × 2)
  //
  // After §3.1 refactor the target is:
  //   Photo_Albums reads: 1  (load once, pass through as parameter)

  it('[§3.1 baseline] reads Photo_Files exactly once per syncBatchToAlbums call', () => {
    setupExistingAlbums();
    mockGetFolderById.mockReturnValue(makeMockFolder(BATCH_ID, 'batch', []));

    syncBatchToAlbums(EVENT_ID, EVENT_NAME, EVENT_DATE, CLUB_NAME, CLUB_DISPLAY, 'finish_line', BATCH_ID);

    const photoFilesReadCount = (mockGetAllRows.mock.calls as string[][])
      .filter((call) => call[0] === 'Photo_Files').length;
    expect(photoFilesReadCount).toBe(1);
  });

  it('[§3.1 baseline] documents Photo_Albums read count per syncBatchToAlbums call', () => {
    setupExistingAlbums();
    mockGetFolderById.mockReturnValue(makeMockFolder(BATCH_ID, 'batch', []));

    syncBatchToAlbums(EVENT_ID, EVENT_NAME, EVENT_DATE, CLUB_NAME, CLUB_DISPLAY, 'finish_line', BATCH_ID);

    const albumReads = (mockGetAllRows.mock.calls as string[][])
      .filter((call) => call[0] === 'Photo_Albums').length;

    // §3.1 target achieved: 1 pre-load at the start of syncBatchToAlbums,
    // threaded through ensureEventAlbum, ensureClubAlbum, and both
    // updateAlbumSyncStats calls (was 4 before the fix).
    expect(albumReads).toBe(1);
  });

  it('[§3.1 baseline] N batches means Photo_Files is read exactly once in syncBatchToAlbums', () => {
    // Verify that the dedup set is built once even when the batch has many files.
    setupExistingAlbums();
    const files = Array.from({ length: 5 }, (_, i) =>
      makeMockFile(`drive-${i}`, `photo-${i}.jpg`, 'image/jpeg')
    );
    mockGetFolderById.mockReturnValue(makeMockFolder(BATCH_ID, 'batch', files));
    mockGetFileById.mockReturnValue({
      getBlob: jest.fn(() => ({ getBytes: jest.fn(() => new Uint8Array([1])) })),
    });

    // Each file needs 2 upload calls per album × 2 albums = 4 calls per file
    for (let i = 0; i < files.length; i++) {
      const [evUp, evCr] = makeFileUploadResponses(`media-ev-${i}`);
      const [clUp, clCr] = makeFileUploadResponses(`media-cl-${i}`);
      mockFetch
        .mockReturnValueOnce(evUp).mockReturnValueOnce(evCr)
        .mockReturnValueOnce(clUp).mockReturnValueOnce(clCr);
    }

    syncBatchToAlbums(EVENT_ID, EVENT_NAME, EVENT_DATE, CLUB_NAME, CLUB_DISPLAY, 'finish_line', BATCH_ID);

    const photoFilesReadCount = (mockGetAllRows.mock.calls as string[][])
      .filter((call) => call[0] === 'Photo_Files').length;
    // Must be 1 regardless of how many files are in the batch
    expect(photoFilesReadCount).toBe(1);
  });
});
