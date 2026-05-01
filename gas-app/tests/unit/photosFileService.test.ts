/**
 * Tests for the Photo_Files deduplication and reconciliation logic.
 *
 * What we test here:
 *   1. findSyncedFile() — correctly identifies already-synced (driveFileId, albumId) pairs
 *   2. syncBatchFolderToAlbum() — skips files already in the existingSyncedKeys Set,
 *      uploads new ones, and persists a Photo_Files row on success
 *   3. reconcileEventPhotos() — correctly computes Drive vs synced counts and
 *      surfaces gaps per club
 *
 * GAS-specific globals (DriveApp, Logger, UrlFetchApp, ScriptApp, etc.) and
 * service-layer I/O (sheetService, photosService HTTP calls) are all mocked.
 */

import {
  findSyncedFile,
  syncBatchFolderToAlbum,
  reconcileEventPhotos,
  EventInfo,
  EventReconciliationResult,
} from '../../src/services/photosService';
import { PhotosFileRecord, PhotosAlbumRecord } from '../../src/types/models';

// ─── Module mocks ─────────────────────────────────────────────────────────────

// Mock sheetService so no real Google Sheets calls are made
jest.mock('../../src/services/sheetService', () => ({
  getAllRows: jest.fn(),
  appendRow:  jest.fn(),
  updateRow:  jest.fn(),
}));

// Mock constants so getConfig() returns a predictable value
jest.mock('../../src/config/constants', () => ({
  getConfig: jest.fn(() => ({
    SPREADSHEET_ID: 'test-spreadsheet-id',
    ROOT_FOLDER_ID: 'test-root-folder-id',
    SHEET_NAMES: {
      USERS:          'Users',
      EVENTS:         'Events',
      UPLOAD_LOG:     'Upload_Log',
      RATE_LIMIT:     'Rate_Limit',
      CLUBS:          'Clubs',
      AUDIT_LOG:      'Audit_Log',
      PHOTO_ALBUMS:  'Photo_Albums',
      PHOTO_FILES:   'Photo_Files',
    },
    PHOTO_MIME_TYPES: ['image/jpeg', 'image/png', 'image/heic'],
    MAX_FILE_SIZE_MB: 50,
    MAX_BATCH_SIZE_MB: 200,
    MAX_API_REQUESTS_PER_HOUR: 60,
  })),
  COLUMNS: {
    PHOTO_FILES: {
      DRIVE_FILE_ID: 0,
      MEDIA_ITEM_ID: 1,
      ALBUM_ID:      2,
      ALBUM_TYPE:    3,
      EVENT_ID:      4,
      CLUB_NAME:     5,
      TAG:           6,
      FILE_NAME:     7,
      SYNCED_AT:     8,
    },
    PHOTO_ALBUMS: {
      ALBUM_ID:          0,
      ALBUM_TYPE:        1,
      EVENT_ID:          2,
      CLUB_NAME:         3,
      TAG:               4,
      ALBUM_TITLE:       5,
      ALBUM_URL:         6,
      SHAREABLE_URL:     7,
      CREATED_AT:        8,
      LAST_SYNC_AT:      9,
      SYNCED_FILE_COUNT: 10,
    },
    EVENTS: {
      EVENT_ID: 0, EVENT_NAME: 1, EVENT_DATE: 2,
      FOLDER_NAME: 3, DRIVE_FOLDER_ID: 4, CREATED_BY: 5, CREATED_AT: 6,
    },
  },
  MAX_API_REQUESTS_PER_HOUR: 60,
  RATE_LIMIT_WINDOW_MS: 3600000,
}));

// Mock Logger (GAS global)
const mockLogger = { log: jest.fn() };
(global as unknown as Record<string, unknown>).Logger = mockLogger;

// Mock ScriptApp (used by getAuthToken)
(global as unknown as Record<string, unknown>).ScriptApp = {
  getOAuthToken: jest.fn(() => 'mock-token'),
};

// Mock UrlFetchApp (used by photosPost / uploadToken calls)
const mockFetch = jest.fn();
(global as unknown as Record<string, unknown>).UrlFetchApp = {
  fetch: mockFetch,
};

// Helpers to build mock Drive file iterators
function makeMockFile(
  id: string,
  name: string,
  mimeType: string
): Record<string, jest.Mock> {
  return {
    getId:       jest.fn(() => id),
    getName:     jest.fn(() => name),
    getMimeType: jest.fn(() => mimeType),
    getBlob:     jest.fn(() => ({
      getBytes: jest.fn(() => new Uint8Array([1, 2, 3])),
    })),
  };
}

function makeMockFileIter(files: ReturnType<typeof makeMockFile>[]) {
  let idx = 0;
  return {
    hasNext: jest.fn(() => idx < files.length),
    next:    jest.fn(() => files[idx++]),
  };
}

function makeMockFolder(
  id: string,
  name: string,
  files: ReturnType<typeof makeMockFile>[] = [],
  subFolders: Record<string, jest.Mock>[] = []
): Record<string, jest.Mock> {
  const fileIter = makeMockFileIter(files);
  let folderIdx = 0;
  const folderIter = {
    hasNext: jest.fn(() => folderIdx < subFolders.length),
    next:    jest.fn(() => subFolders[folderIdx++]),
  };
  return {
    getId:       jest.fn(() => id),
    getName:     jest.fn(() => name),
    getFiles:    jest.fn(() => fileIter),
    getFolders:  jest.fn(() => folderIter),
  };
}

// Mock DriveApp (GAS global)
const mockGetFolderById = jest.fn();
const mockGetFileById   = jest.fn();
(global as unknown as Record<string, unknown>).DriveApp = {
  getFolderById: mockGetFolderById,
  getFileById:   mockGetFileById,
};

// ─── Import sheetService mock AFTER mocks are set up ─────────────────────────
import { getAllRows, appendRow } from '../../src/services/sheetService';
const mockGetAllRows = getAllRows as jest.Mock;
const mockAppendRow  = appendRow  as jest.Mock;

// ─── Fixture data ─────────────────────────────────────────────────────────────

/** Minimal valid Photo_Files sheet row (9 columns including TAG) */
function makeFileRow(
  driveFileId: string,
  albumId: string,
  albumType: 'event' | 'club' = 'event',
  clubName = '',
  eventId = 'evt-uuid-001',
  fileName = 'photo.jpg',
  tag      = ''
): unknown[] {
  const tagValue = albumType === 'club' ? (tag || 'finish_line') : '';
  return [driveFileId, 'media-item-' + driveFileId, albumId, albumType, eventId, clubName, tagValue, fileName, '2026-04-19T10:00:00.000Z'];
}

// ─── findSyncedFile() ─────────────────────────────────────────────────────────

describe('findSyncedFile()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when Photo_Files sheet is empty', () => {
    mockGetAllRows.mockImplementation((sheetName: string) =>
      sheetName === 'Photo_Files' ? [] : []
    );
    const result = findSyncedFile('drive-file-001', 'album-001');
    expect(result).toBeNull();
  });

  it('returns the matching record when (driveFileId, albumId) exists', () => {
    mockGetAllRows.mockImplementation((sheetName: string) =>
      sheetName === 'Photo_Files'
        ? [makeFileRow('drive-file-001', 'album-001', 'event')]
        : []
    );
    const result = findSyncedFile('drive-file-001', 'album-001');
    expect(result).not.toBeNull();
    expect(result!.driveFileId).toBe('drive-file-001');
    expect(result!.albumId).toBe('album-001');
  });

  it('returns null when driveFileId matches but albumId differs', () => {
    mockGetAllRows.mockImplementation((sheetName: string) =>
      sheetName === 'Photo_Files'
        ? [makeFileRow('drive-file-001', 'album-001')]
        : []
    );
    const result = findSyncedFile('drive-file-001', 'album-999');
    expect(result).toBeNull();
  });

  it('returns null when albumId matches but driveFileId differs', () => {
    mockGetAllRows.mockImplementation((sheetName: string) =>
      sheetName === 'Photo_Files'
        ? [makeFileRow('drive-file-001', 'album-001')]
        : []
    );
    const result = findSyncedFile('drive-file-999', 'album-001');
    expect(result).toBeNull();
  });

  it('returns the correct record when multiple records exist', () => {
    mockGetAllRows.mockImplementation((sheetName: string) =>
      sheetName === 'Photo_Files'
        ? [
            makeFileRow('drive-file-001', 'album-event', 'event'),
            makeFileRow('drive-file-001', 'album-club',  'club', 'New_Bee'),
            makeFileRow('drive-file-002', 'album-event', 'event'),
          ]
        : []
    );
    const result = findSyncedFile('drive-file-001', 'album-club');
    expect(result).not.toBeNull();
    expect(result!.albumType).toBe('club');
    expect(result!.clubName).toBe('New_Bee');
  });

  it('filters out malformed rows gracefully', () => {
    mockGetAllRows.mockImplementation((sheetName: string) =>
      sheetName === 'Photo_Files'
        ? [
            [],                                           // too short → null
            ['', 'media', 'album-001', 'event', 'evt', '', 'f.jpg', 'ts'], // empty driveFileId → null
            makeFileRow('drive-file-001', 'album-001'),   // valid
          ]
        : []
    );
    const result = findSyncedFile('drive-file-001', 'album-001');
    expect(result).not.toBeNull();
  });
});

// ─── syncBatchFolderToAlbum() ─────────────────────────────────────────────────

describe('syncBatchFolderToAlbum()', () => {
  const ALBUM_ID  = 'album-event-001';
  const EVENT_ID  = 'evt-uuid-001';
  const BATCH_ID  = 'batch-folder-id';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns error when batch folder cannot be accessed', () => {
    mockGetFolderById.mockImplementation(() => { throw new Error('Folder not found'); });

    const result = syncBatchFolderToAlbum(
      ALBUM_ID, 'event', EVENT_ID, '', '', BATCH_ID, new Set()
    );
    expect(result.status).toBe('error');
    expect(result.message).toContain('Cannot access batch folder');
  });

  it('skips non-photo files (wrong MIME type)', () => {
    const pdfFile = makeMockFile('file-001', 'doc.pdf', 'application/pdf');
    const folder = makeMockFolder(BATCH_ID, 'batch', [pdfFile]);
    mockGetFolderById.mockReturnValue(folder);

    const result = syncBatchFolderToAlbum(
      ALBUM_ID, 'event', EVENT_ID, '', '', BATCH_ID, new Set()
    );
    expect(result.status).toBe('success');
    expect(result.data!.skipped).toBe(1);
    expect(result.data!.synced).toBe(0);
    expect(mockAppendRow).not.toHaveBeenCalled();
  });

  it('skips files already in the existingSyncedKeys Set (deduplication)', () => {
    const jpgFile = makeMockFile('drive-file-001', 'photo.jpg', 'image/jpeg');
    const folder  = makeMockFolder(BATCH_ID, 'batch', [jpgFile]);
    mockGetFolderById.mockReturnValue(folder);

    // Pre-populate the set with this file+album combination
    const existingKeys = new Set(['drive-file-001|album-event-001']);

    const result = syncBatchFolderToAlbum(
      ALBUM_ID, 'event', EVENT_ID, '', '', BATCH_ID, existingKeys
    );
    expect(result.status).toBe('success');
    expect(result.data!.deduplicated).toBe(1);
    expect(result.data!.synced).toBe(0);
    // No Photos API call, no sheet write
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockAppendRow).not.toHaveBeenCalled();
  });

  it('uploads new photo file, saves file record, and adds key to syncedKeys Set', () => {
    const jpgFile = makeMockFile('drive-file-new', 'photo.jpg', 'image/jpeg');
    const folder  = makeMockFolder(BATCH_ID, 'batch', [jpgFile]);
    mockGetFolderById.mockReturnValue(folder);
    mockGetFileById.mockReturnValue({ getBlob: jest.fn(() => ({ getBytes: jest.fn(() => new Uint8Array([1])) })) });

    // Mock upload token response
    const mockUploadResp = {
      getResponseCode: jest.fn(() => 200),
      getContentText:  jest.fn(() => 'upload-token-abc'),
    };
    // Mock batchCreate response
    const mockCreateResp = {
      getResponseCode: jest.fn(() => 200),
      getContentText:  jest.fn(() => JSON.stringify({
        newMediaItemResults: [{ mediaItem: { id: 'media-item-new' } }],
      })),
    };
    mockFetch
      .mockReturnValueOnce(mockUploadResp)   // upload token call
      .mockReturnValueOnce(mockCreateResp);   // batchCreate call

    const existingKeys = new Set<string>();

    const result = syncBatchFolderToAlbum(
      ALBUM_ID, 'event', EVENT_ID, '', '', BATCH_ID, existingKeys
    );
    expect(result.status).toBe('success');
    expect(result.data!.synced).toBe(1);
    expect(result.data!.deduplicated).toBe(0);

    // Should have written a row to Photo_Files
    expect(mockAppendRow).toHaveBeenCalledTimes(1);
    const appendedRow = mockAppendRow.mock.calls[0][1] as unknown[];
    expect(appendedRow[0]).toBe('drive-file-new');  // driveFileId
    expect(appendedRow[1]).toBe('media-item-new');  // mediaItemId
    expect(appendedRow[2]).toBe(ALBUM_ID);           // albumId
    expect(appendedRow[3]).toBe('event');            // albumType
    expect(appendedRow[4]).toBe(EVENT_ID);           // eventId
    expect(appendedRow[5]).toBe('');                 // clubName (empty for event)
    expect(appendedRow[6]).toBe('');                 // tag (empty for event)
    expect(appendedRow[7]).toBe('photo.jpg');        // fileName

    // Key should be added to the in-memory set
    expect(existingKeys.has('drive-file-new|album-event-001')).toBe(true);
  });

  it('saves club name for club-type album sync', () => {
    const jpgFile = makeMockFile('drive-file-club', 'photo.jpg', 'image/jpeg');
    const folder  = makeMockFolder(BATCH_ID, 'batch', [jpgFile]);
    mockGetFolderById.mockReturnValue(folder);
    mockGetFileById.mockReturnValue({ getBlob: jest.fn(() => ({ getBytes: jest.fn(() => new Uint8Array([1])) })) });

    const mockUploadResp = {
      getResponseCode: jest.fn(() => 200),
      getContentText:  jest.fn(() => 'upload-token-club'),
    };
    const mockCreateResp = {
      getResponseCode: jest.fn(() => 200),
      getContentText:  jest.fn(() => JSON.stringify({
        newMediaItemResults: [{ mediaItem: { id: 'media-item-club' } }],
      })),
    };
    mockFetch
      .mockReturnValueOnce(mockUploadResp)
      .mockReturnValueOnce(mockCreateResp);

    syncBatchFolderToAlbum(
      'album-club-001', 'club', EVENT_ID, 'New_Bee', 'finish_line', BATCH_ID, new Set()
    );

    const appendedRow = mockAppendRow.mock.calls[0][1] as unknown[];
    expect(appendedRow[3]).toBe('club');     // albumType
    expect(appendedRow[5]).toBe('New_Bee'); // clubName
  });

  it('collects errors for failed uploads without aborting the whole batch', () => {
    const file1 = makeMockFile('drive-file-ok',   'good.jpg',  'image/jpeg');
    const file2 = makeMockFile('drive-file-fail', 'broken.jpg', 'image/jpeg');
    const folder = makeMockFolder(BATCH_ID, 'batch', [file1, file2]);
    mockGetFolderById.mockReturnValue(folder);
    mockGetFileById.mockReturnValue({ getBlob: jest.fn(() => ({ getBytes: jest.fn(() => new Uint8Array([1])) })) });

    // First file: success
    const okUpload = { getResponseCode: jest.fn(() => 200), getContentText: jest.fn(() => 'token-ok') };
    const okCreate = {
      getResponseCode: jest.fn(() => 200),
      getContentText:  jest.fn(() => JSON.stringify({ newMediaItemResults: [{ mediaItem: { id: 'media-ok' } }] })),
    };
    // Second file: upload fails with 500
    const failUpload = { getResponseCode: jest.fn(() => 500), getContentText: jest.fn(() => 'Internal error') };

    mockFetch
      .mockReturnValueOnce(okUpload)
      .mockReturnValueOnce(okCreate)
      .mockReturnValueOnce(failUpload);

    const result = syncBatchFolderToAlbum(
      ALBUM_ID, 'event', EVENT_ID, '', '', BATCH_ID, new Set()
    );
    expect(result.status).toBe('success');  // overall status still success
    expect(result.data!.synced).toBe(1);
    expect(result.data!.errors).toHaveLength(1);
    expect(result.data!.errors[0]).toContain('broken.jpg');
    // Only one row should be saved (the successful one)
    expect(mockAppendRow).toHaveBeenCalledTimes(1);
  });

  it('handles empty batch folder gracefully', () => {
    const folder = makeMockFolder(BATCH_ID, 'batch', []);
    mockGetFolderById.mockReturnValue(folder);

    const result = syncBatchFolderToAlbum(
      ALBUM_ID, 'event', EVENT_ID, '', '', BATCH_ID, new Set()
    );
    expect(result.status).toBe('success');
    expect(result.data!.synced).toBe(0);
    expect(result.data!.skipped).toBe(0);
    expect(result.data!.deduplicated).toBe(0);
    expect(result.data!.errors).toHaveLength(0);
  });

  it('deduplicates across mixed batch: one new, one already synced', () => {
    const newFile  = makeMockFile('drive-new',  'new.jpg',  'image/jpeg');
    const dupFile  = makeMockFile('drive-dup',  'dup.jpg',  'image/jpeg');
    const folder   = makeMockFolder(BATCH_ID, 'batch', [newFile, dupFile]);
    mockGetFolderById.mockReturnValue(folder);
    mockGetFileById.mockReturnValue({ getBlob: jest.fn(() => ({ getBytes: jest.fn(() => new Uint8Array([1])) })) });

    const mockUploadResp = { getResponseCode: jest.fn(() => 200), getContentText: jest.fn(() => 'token') };
    const mockCreateResp = {
      getResponseCode: jest.fn(() => 200),
      getContentText:  jest.fn(() => JSON.stringify({ newMediaItemResults: [{ mediaItem: { id: 'media-new' } }] })),
    };
    mockFetch
      .mockReturnValueOnce(mockUploadResp)
      .mockReturnValueOnce(mockCreateResp);

    const existingKeys = new Set([`drive-dup|${ALBUM_ID}`]);

    const result = syncBatchFolderToAlbum(
      ALBUM_ID, 'event', EVENT_ID, '', '', BATCH_ID, existingKeys
    );
    expect(result.data!.synced).toBe(1);
    expect(result.data!.deduplicated).toBe(1);
    expect(mockAppendRow).toHaveBeenCalledTimes(1);
  });
});

// ─── reconcileEventPhotos() ───────────────────────────────────────────────────

describe('reconcileEventPhotos()', () => {
  const EVENT: EventInfo = {
    eventId:       'evt-uuid-001',
    eventName:     'Test Marathon',
    eventDate:     '2026-04-19',
    driveFolderId: 'event-folder-id',
  };

  function makeAlbumRecord(
    albumId: string,
    albumType: 'event' | 'club',
    clubName = '',
    tag = ''
  ): PhotosAlbumRecord {
    return {
      albumId, albumType,
      eventId:         EVENT.eventId,
      clubName,
      tag:             albumType === 'club' ? (tag || 'finish_line') : '',
      albumTitle:      'Test Album',
      albumUrl:        'http://photos.url',
      shareableUrl:    'http://share.url',
      createdAt:       '2026-04-19T09:00:00.000Z',
      lastSyncAt:      '',
      syncedFileCount: 0,
    };
  }

  function makeFileRecord(driveFileId: string, albumId: string, albumType: 'event' | 'club' = 'event', clubName = '', tag = ''): PhotosFileRecord {
    return {
      driveFileId, mediaItemId: 'media-' + driveFileId,
      albumId, albumType,
      eventId:  EVENT.eventId,
      clubName,
      tag:      albumType === 'club' ? (tag || 'finish_line') : '',
      fileName: 'photo.jpg',
      syncedAt: '2026-04-19T10:00:00.000Z',
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports no Drive files and no albums for empty event folder', () => {
    const eventFolder = makeMockFolder('event-folder-id', 'event', [], []);
    mockGetFolderById.mockReturnValue(eventFolder);

    const albumsByEvent = new Map<string, PhotosAlbumRecord[]>();
    const result: EventReconciliationResult = reconcileEventPhotos(EVENT, albumsByEvent, []);

    expect(result.eventId).toBe('evt-uuid-001');
    expect(result.eventName).toBe('Test Marathon');
    expect(result.hasEventAlbum).toBe(false);
    expect(result.driveTotal).toBe(0);
    expect(result.eventSyncedCount).toBe(0);
    expect(result.clubTags).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('detects a missing event album (hasEventAlbum = false)', () => {
    const eventFolder = makeMockFolder('event-folder-id', 'event', [], []);
    mockGetFolderById.mockReturnValue(eventFolder);

    const albumsByEvent = new Map<string, PhotosAlbumRecord[]>([
      // Only a club album, no event album
      [EVENT.eventId, [makeAlbumRecord('album-club', 'club', 'New_Bee')]],
    ]);

    const result = reconcileEventPhotos(EVENT, albumsByEvent, []);
    expect(result.hasEventAlbum).toBe(false);
    expect(result.eventAlbumId).toBe('');
  });

  it('detects an existing event album and counts its synced files', () => {
    const eventFolder = makeMockFolder('event-folder-id', 'event', [], []);
    mockGetFolderById.mockReturnValue(eventFolder);

    const albumsByEvent = new Map<string, PhotosAlbumRecord[]>([
      [EVENT.eventId, [makeAlbumRecord('album-event-001', 'event')]],
    ]);
    const fileRecords: PhotosFileRecord[] = [
      makeFileRecord('file-A', 'album-event-001', 'event'),
      makeFileRecord('file-B', 'album-event-001', 'event'),
    ];

    const result = reconcileEventPhotos(EVENT, albumsByEvent, fileRecords);
    expect(result.hasEventAlbum).toBe(true);
    expect(result.eventAlbumId).toBe('album-event-001');
    expect(result.eventSyncedCount).toBe(2);
  });

  it('counts Drive photo files correctly per (club, tag) folder', () => {
    const batchFolder = makeMockFolder('batch-id', '20260419-100000_alice', [
      makeMockFile('f1', 'photo1.jpg',  'image/jpeg'),
      makeMockFile('f2', 'photo2.png',  'image/png'),
      makeMockFile('f3', 'doc.pdf',     'application/pdf'), // should be ignored
    ]);
    const tagFolder   = makeMockFolder('tag-id', 'finish_line', [], [batchFolder]);
    const clubFolder  = makeMockFolder('club-id', 'New_Bee', [], [tagFolder]);
    const eventFolder = makeMockFolder('event-folder-id', 'event', [], [clubFolder]);
    mockGetFolderById.mockReturnValue(eventFolder);

    const albumsByEvent = new Map<string, PhotosAlbumRecord[]>([
      [EVENT.eventId, [
        makeAlbumRecord('album-event', 'event'),
        makeAlbumRecord('album-club',  'club', 'New_Bee', 'finish_line'),
      ]],
    ]);

    const result = reconcileEventPhotos(EVENT, albumsByEvent, []);
    expect(result.driveTotal).toBe(2);           // JPEG + PNG only
    expect(result.clubTags).toHaveLength(1);
    expect(result.clubTags[0].clubName).toBe('New_Bee');
    expect(result.clubTags[0].tag).toBe('finish_line');
    expect(result.clubTags[0].driveCount).toBe(2);
    expect(result.clubTags[0].syncedCount).toBe(0);
    expect(result.clubTags[0].missingCount).toBe(2);
  });

  it('reports missingCount = 0 when all Drive files are synced', () => {
    const batchFolder = makeMockFolder('batch-id', '20260419-100000_alice', [
      makeMockFile('f1', 'photo1.jpg', 'image/jpeg'),
      makeMockFile('f2', 'photo2.jpg', 'image/jpeg'),
    ]);
    const tagFolder   = makeMockFolder('tag-id', 'finish_line', [], [batchFolder]);
    const clubFolder  = makeMockFolder('club-id', 'New_Bee', [], [tagFolder]);
    const eventFolder = makeMockFolder('event-folder-id', 'event', [], [clubFolder]);
    mockGetFolderById.mockReturnValue(eventFolder);

    const albumsByEvent = new Map<string, PhotosAlbumRecord[]>([
      [EVENT.eventId, [
        makeAlbumRecord('album-event', 'event'),
        makeAlbumRecord('album-club',  'club', 'New_Bee', 'finish_line'),
      ]],
    ]);
    const fileRecords: PhotosFileRecord[] = [
      makeFileRecord('f1', 'album-club', 'club', 'New_Bee', 'finish_line'),
      makeFileRecord('f2', 'album-club', 'club', 'New_Bee', 'finish_line'),
    ];

    const result = reconcileEventPhotos(EVENT, albumsByEvent, fileRecords);
    expect(result.clubTags[0].missingCount).toBe(0);
    expect(result.clubTags[0].driveCount).toBe(2);
    expect(result.clubTags[0].syncedCount).toBe(2);
  });

  it('reports missingCount for partial sync', () => {
    const batchFolder = makeMockFolder('batch-id', '20260419-100000_alice', [
      makeMockFile('f1', 'p1.jpg', 'image/jpeg'),
      makeMockFile('f2', 'p2.jpg', 'image/jpeg'),
      makeMockFile('f3', 'p3.jpg', 'image/jpeg'),
    ]);
    const tagFolder   = makeMockFolder('tag-id', 'finish_line', [], [batchFolder]);
    const clubFolder  = makeMockFolder('club-id', 'New_Bee', [], [tagFolder]);
    const eventFolder = makeMockFolder('event-folder-id', 'event', [], [clubFolder]);
    mockGetFolderById.mockReturnValue(eventFolder);

    const albumsByEvent = new Map<string, PhotosAlbumRecord[]>([
      [EVENT.eventId, [makeAlbumRecord('album-club', 'club', 'New_Bee', 'finish_line')]],
    ]);
    // Only 1 of 3 files synced
    const fileRecords: PhotosFileRecord[] = [
      makeFileRecord('f1', 'album-club', 'club', 'New_Bee', 'finish_line'),
    ];

    const result = reconcileEventPhotos(EVENT, albumsByEvent, fileRecords);
    expect(result.clubTags[0].driveCount).toBe(3);
    expect(result.clubTags[0].syncedCount).toBe(1);
    expect(result.clubTags[0].missingCount).toBe(2);
  });

  it('reports Drive error when event folder is inaccessible', () => {
    mockGetFolderById.mockImplementation(() => { throw new Error('Access denied'); });

    const albumsByEvent = new Map<string, PhotosAlbumRecord[]>();
    const result = reconcileEventPhotos(EVENT, albumsByEvent, []);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Cannot access Drive folder');
    expect(result.driveTotal).toBe(0);
  });

  it('handles multiple clubs and accumulates driveTotal correctly', () => {
    const batch1 = makeMockFolder('batch-new-bee', '20260419-100000_alice', [
      makeMockFile('f1', 'p1.jpg', 'image/jpeg'),
      makeMockFile('f2', 'p2.jpg', 'image/jpeg'),
    ]);
    const batch2 = makeMockFolder('batch-chi', '20260419-110000_bob', [
      makeMockFile('f3', 'p3.heic', 'image/heic'),
    ]);
    const tag1 = makeMockFolder('tag-new-bee', 'finish_line', [], [batch1]);
    const tag2 = makeMockFolder('tag-chi',     'finish_line', [], [batch2]);
    const clubNewBee  = makeMockFolder('club-new-bee', 'New_Bee', [], [tag1]);
    const clubCHI     = makeMockFolder('club-chi',     'CHI',     [], [tag2]);
    const eventFolder = makeMockFolder('event-folder-id', 'event', [], [clubNewBee, clubCHI]);
    mockGetFolderById.mockReturnValue(eventFolder);

    const albumsByEvent = new Map<string, PhotosAlbumRecord[]>([
      [EVENT.eventId, [
        makeAlbumRecord('album-event',   'event'),
        makeAlbumRecord('album-new-bee', 'club', 'New_Bee', 'finish_line'),
        makeAlbumRecord('album-chi',     'club', 'CHI',     'finish_line'),
      ]],
    ]);

    const result = reconcileEventPhotos(EVENT, albumsByEvent, []);
    expect(result.driveTotal).toBe(3);
    expect(result.clubTags).toHaveLength(2);

    const newBeeResult = result.clubTags.find((c) => c.clubName === 'New_Bee')!;
    const chiResult    = result.clubTags.find((c) => c.clubName === 'CHI')!;
    expect(newBeeResult.driveCount).toBe(2);
    expect(chiResult.driveCount).toBe(1);
  });

  it('sets clubTagAlbumId to empty string when no (club, tag) album exists', () => {
    const batchFolder = makeMockFolder('batch-id', '20260419-100000_alice', [
      makeMockFile('f1', 'photo.jpg', 'image/jpeg'),
    ]);
    const tagFolder   = makeMockFolder('tag-id', 'finish_line', [], [batchFolder]);
    const clubFolder  = makeMockFolder('club-id', 'New_Bee', [], [tagFolder]);
    const eventFolder = makeMockFolder('event-folder-id', 'event', [], [clubFolder]);
    mockGetFolderById.mockReturnValue(eventFolder);

    // No album records at all for this event
    const albumsByEvent = new Map<string, PhotosAlbumRecord[]>();

    const result = reconcileEventPhotos(EVENT, albumsByEvent, []);
    expect(result.clubTags[0].clubTagAlbumId).toBe('');
    expect(result.clubTags[0].syncedCount).toBe(0);
  });

  it('ignores file records from other events when counting synced files', () => {
    const eventFolder = makeMockFolder('event-folder-id', 'event', [], []);
    mockGetFolderById.mockReturnValue(eventFolder);

    const albumsByEvent = new Map<string, PhotosAlbumRecord[]>([
      [EVENT.eventId, [makeAlbumRecord('album-event-001', 'event')]],
    ]);
    // File records for a DIFFERENT event's album
    const fileRecords: PhotosFileRecord[] = [
      {
        driveFileId: 'file-other', mediaItemId: 'media-other',
        albumId: 'album-other-event', albumType: 'event',
        eventId: 'evt-uuid-OTHER', clubName: '', tag: '',
        fileName: 'other.jpg', syncedAt: '2026-04-19T10:00:00.000Z',
      },
    ];

    const result = reconcileEventPhotos(EVENT, albumsByEvent, fileRecords);
    // Our event album 'album-event-001' has no matching file records
    expect(result.eventSyncedCount).toBe(0);
  });
});
