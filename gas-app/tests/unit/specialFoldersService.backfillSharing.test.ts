/**
 * Unit tests for backfillSpecialFoldersSharing.
 *
 * The function walks every row in Special_Folders and calls
 * drivePermissionsService.grantAnyoneRead(folderId) for each one, then folds
 * the results into a BatchGrantSummary.
 *
 * Strategy:
 *   - Mock drivePermissionsService.grantAnyoneRead with a queue-able stub so
 *     we can drive every outcome (created / exists / error) and assert the
 *     summary counters.
 *   - Mock sheetService.getAllRows + ensureHeaders so we control what the
 *     Special_Folders sheet returns without touching GAS.
 *   - Mock config/constants.getConfig so the sheet-name lookup resolves
 *     without a real Script Properties read.
 *
 * We DO NOT mock the rest of drivePermissionsService — foldBatchGrantSummary
 * and EMPTY_BATCH_GRANT_SUMMARY come from jest.requireActual so the summary
 * math under test is the real implementation, not a fake.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  GrantPermissionResult,
} from '../../src/services/drivePermissionsService';

// ── Mocks ────────────────────────────────────────────────────────────────────
//
// Mock grantAnyoneRead with a configurable queue; keep the real
// foldBatchGrantSummary / EMPTY_BATCH_GRANT_SUMMARY so the summary math
// under test is what production will use.
const grantQueue: GrantPermissionResult[] = [];
const grantCalls: string[] = [];

jest.mock('../../src/services/drivePermissionsService', () => {
  const actual = jest.requireActual('../../src/services/drivePermissionsService');
  return {
    ...actual,
    grantAnyoneRead: jest.fn((folderId: string): GrantPermissionResult => {
      grantCalls.push(folderId);
      const next = grantQueue.shift();
      if (!next) {
        throw new Error(
          'grantAnyoneRead mock invoked but no queued response — ' +
          'test forgot to enqueueGrantResults() for this row'
        );
      }
      return next;
    }),
  };
});

// Mock sheetService so loadAllSpecialFolders() (private) can resolve.
const mockGetAllRows = jest.fn();
const mockEnsureHeaders = jest.fn();
jest.mock('../../src/services/sheetService', () => ({
  getAllRows: (...args: unknown[]) => mockGetAllRows(...args),
  ensureHeaders: (...args: unknown[]) => mockEnsureHeaders(...args),
  appendRow: jest.fn(),
  updateRow: jest.fn(),
}));

// Mock getConfig() to supply the SHEET_NAMES lookup specialFoldersService uses.
jest.mock('../../src/config/constants', () => {
  const actual = jest.requireActual('../../src/config/constants');
  return {
    ...actual,
    getConfig: () => ({
      ROOT_FOLDER_ID:  'mock-root',
      SPREADSHEET_ID:  'mock-sheet',
      SHEET_NAMES: {
        USERS: 'Users', EVENTS: 'Events', UPLOAD_LOG: 'Upload_Log',
        UPLOAD_LINKS: 'Upload_Links', RATE_LIMIT: 'Rate_Limit',
        CLUBS: 'Clubs', AUDIT_LOG: 'Audit_Log',
        PHOTO_ALBUMS: 'Photo_Albums', PHOTO_FILES: 'Photo_Files',
        EMAIL_PREFERENCES: 'Email_Preferences', SYNC_QUEUE: 'Sync_Queue',
        DELETED_FILES: 'Deleted_Files', SPECIAL_FOLDERS: 'Special_Folders',
      },
      PHOTO_MIME_TYPES: [], MAX_FILE_SIZE_MB: 50, MAX_BATCH_SIZE_MB: 200,
      MAX_API_REQUESTS_PER_HOUR: 60,
    }),
  };
});

// Mock event/club services — backfill doesn't need them but
// specialFoldersService imports them at module load time.
jest.mock('../../src/services/eventService', () => ({
  findById: jest.fn(),
  listAll: jest.fn(() => ({ items: [], total: 0 })),
}));
jest.mock('../../src/services/clubService', () => ({
  listActive: jest.fn(() => []),
}));
jest.mock('../../src/services/driveService', () => ({
  getFolderById: jest.fn(),
  findSubfolder: jest.fn(),
  getOrCreateSubfolder: jest.fn(),
}));
jest.mock('../../src/services/driveShortcutClient', () => ({
  createDriveShortcut: jest.fn(),
  listShortcutsInFolder: jest.fn(() => []),
  driveFolderUrl: (id: string) => `https://drive.google.com/drive/folders/${id}`,
  DRIVE_API_BASE: 'https://example.com/drive/v3',
  DRIVE_SHORTCUT_MIME: 'application/vnd.google-apps.shortcut',
  getDriveAuthToken: () => 'mock-token',
}));

// Logger global needs to exist before specialFoldersService is imported.
(globalThis as any).Logger = { log: jest.fn() };

// Now safe to import the system under test.
import { backfillSpecialFoldersSharing } from '../../src/services/specialFoldersService';

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Builds a Special_Folders raw row matching COLUMNS.SPECIAL_FOLDERS order. */
function row(opts: {
  folderId: string;
  eventId?: string;
  scope?: 'photos' | 'videos';
  clubName?: string;
  tag?: string;
  folderName?: string;
  folderIndex?: number;
  fileCount?: number;
}): unknown[] {
  return [
    opts.folderId,
    opts.eventId ?? 'evt-001',
    opts.scope ?? 'photos',
    opts.clubName ?? '',
    opts.tag ?? '',
    opts.folderName ?? 'Photos_001',
    opts.folderIndex ?? 1,
    `https://drive.google.com/drive/folders/${opts.folderId}`,
    opts.fileCount ?? 5,
    '2026-05-23T00:00:00.000Z',
  ];
}

function enqueueGrantResults(...results: GrantPermissionResult[]): void {
  for (const r of results) grantQueue.push(r);
}

beforeEach(() => {
  grantQueue.length = 0;
  grantCalls.length = 0;
  mockGetAllRows.mockReset();
  mockEnsureHeaders.mockReset();
  ((globalThis as any).Logger.log as jest.Mock).mockClear();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('backfillSpecialFoldersSharing()', () => {
  it('returns an empty summary when Special_Folders is empty', () => {
    mockGetAllRows.mockReturnValue([]);

    const summary = backfillSpecialFoldersSharing();

    expect(grantCalls).toEqual([]);
    expect(summary.created).toBe(0);
    expect(summary.alreadyShared).toBe(0);
    expect(summary.errors).toBe(0);
    expect(summary.errorSample).toEqual([]);
  });

  it('returns an empty summary if loading the sheet throws', () => {
    mockGetAllRows.mockImplementation(() => {
      throw new Error('sheet inaccessible');
    });

    const summary = backfillSpecialFoldersSharing();

    expect(grantCalls).toEqual([]);
    expect(summary.created).toBe(0);
    expect(summary.alreadyShared).toBe(0);
    expect(summary.errors).toBe(0);
  });

  it('calls grantAnyoneRead once per Special_Folders row', () => {
    mockGetAllRows.mockReturnValue([
      row({ folderId: 'drv-1' }),
      row({ folderId: 'drv-2', scope: 'videos', clubName: 'New_Bee', tag: 'finish' }),
      row({ folderId: 'drv-3', folderIndex: 2, folderName: 'Photos_002' }),
    ]);
    enqueueGrantResults(
      { ok: true,  outcome: 'created', status: 200, permissionId: 'p-1' },
      { ok: true,  outcome: 'created', status: 200, permissionId: 'p-2' },
      { ok: true,  outcome: 'created', status: 200, permissionId: 'p-3' },
    );

    const summary = backfillSpecialFoldersSharing();

    expect(grantCalls).toEqual(['drv-1', 'drv-2', 'drv-3']);
    expect(summary.created).toBe(3);
    expect(summary.alreadyShared).toBe(0);
    expect(summary.errors).toBe(0);
  });

  it('partitions outcomes between created / alreadyShared / errors', () => {
    mockGetAllRows.mockReturnValue([
      row({ folderId: 'drv-new' }),
      row({ folderId: 'drv-existing' }),
      row({ folderId: 'drv-bad' }),
      row({ folderId: 'drv-another-new' }),
    ]);
    enqueueGrantResults(
      { ok: true,  outcome: 'created', status: 200, permissionId: 'p-new' },
      { ok: true,  outcome: 'exists',  status: 400 },
      { ok: false, outcome: 'error',   status: 500, error: 'server boom' },
      { ok: true,  outcome: 'created', status: 200, permissionId: 'p-another' },
    );

    const summary = backfillSpecialFoldersSharing();

    expect(summary.created).toBe(2);
    expect(summary.alreadyShared).toBe(1);
    expect(summary.errors).toBe(1);
    // The error sample should preserve the row context so admins can find
    // and fix the offending folder.
    expect(summary.errorSample).toHaveLength(1);
    expect(summary.errorSample[0]).toContain('drv-bad');
    expect(summary.errorSample[0]).toContain('server boom');
  });

  it('skips rows whose folderId is blank without calling the API', () => {
    mockGetAllRows.mockReturnValue([
      row({ folderId: 'drv-1' }),
      row({ folderId: '' }),         // skipped
      row({ folderId: 'drv-3' }),
    ]);
    enqueueGrantResults(
      { ok: true, outcome: 'created', status: 200, permissionId: 'p-1' },
      { ok: true, outcome: 'created', status: 200, permissionId: 'p-3' },
    );

    const summary = backfillSpecialFoldersSharing();

    expect(grantCalls).toEqual(['drv-1', 'drv-3']);
    expect(summary.created).toBe(2);
  });

  it('caps errorSample at 20 entries even when every row fails', () => {
    const rows: unknown[][] = [];
    const results: GrantPermissionResult[] = [];
    for (let i = 0; i < 25; i++) {
      rows.push(row({ folderId: `drv-${i}` }));
      results.push({ ok: false, outcome: 'error', status: 500, error: `boom-${i}` });
    }
    mockGetAllRows.mockReturnValue(rows);
    enqueueGrantResults(...results);

    const summary = backfillSpecialFoldersSharing();

    expect(summary.errors).toBe(25);
    expect(summary.errorSample.length).toBe(20);
  });

  it('drops rows that fail to map (malformed Special_Folders entries)', () => {
    // toSpecialFolderRecord returns null when required fields are missing or
    // scope is invalid. A row with scope='garbage' fails the enum check and
    // is silently filtered out — grantAnyoneRead should never be called for
    // that row.
    mockGetAllRows.mockReturnValue([
      row({ folderId: 'drv-good' }),
      [
        'drv-malformed', 'evt-001', 'garbage-scope', '', '', 'Photos_001', 1,
        'https://drive.google.com/drive/folders/drv-malformed', 5,
        '2026-05-23T00:00:00.000Z',
      ],
    ]);
    enqueueGrantResults(
      { ok: true, outcome: 'created', status: 200, permissionId: 'p-good' },
    );

    const summary = backfillSpecialFoldersSharing();

    expect(grantCalls).toEqual(['drv-good']);
    expect(summary.created).toBe(1);
    expect(summary.errors).toBe(0);
  });

  it('uses grantAnyoneRead (strict), not tryGrantAnyoneRead, so logging is single-source', () => {
    // The implementation comment says it uses the non-try variant so the
    // summary can distinguish created vs exists without double-logging.
    // Confirm by counting calls — every row in the input must produce exactly
    // one grantAnyoneRead call (no wrapper indirection that calls it twice).
    mockGetAllRows.mockReturnValue([
      row({ folderId: 'drv-1' }),
      row({ folderId: 'drv-2' }),
    ]);
    enqueueGrantResults(
      { ok: true, outcome: 'exists', status: 400 },
      { ok: true, outcome: 'exists', status: 400 },
    );

    backfillSpecialFoldersSharing();

    expect(grantCalls.length).toBe(2);
  });
});
