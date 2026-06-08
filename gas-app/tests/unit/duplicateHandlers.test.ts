/**
 * duplicateHandlers.test.ts
 *
 * Covers the two google.script.run actions behind the Duplicate Cleanup page:
 *   - serverScanDuplicateFiles  (read-only scan; club-admin scoped)
 *   - serverTrashDuplicateFiles (review-confirmed bulk soft-delete + sweep)
 */

jest.mock('../../src/middleware/authMiddleware', () => ({
  authenticateRequest: jest.fn(),
}));
jest.mock('../../src/services/duplicateCleanupService', () => ({
  scanEventForDuplicates: jest.fn(),
}));
jest.mock('../../src/services/deleteService', () => ({
  softDeleteFile: jest.fn(),
}));
jest.mock('../../src/services/specialFoldersService', () => ({
  removeShortcutsForTargets: jest.fn(),
}));
jest.mock('../../src/services/publicSpreadsheetService', () => ({
  tryRebuildPublicFoldersIndex: jest.fn(),
}));

import {
  serverScanDuplicateFiles,
  serverTrashDuplicateFiles,
} from '../../src/routes/duplicateHandlers';
import { authenticateRequest } from '../../src/middleware/authMiddleware';
import { scanEventForDuplicates } from '../../src/services/duplicateCleanupService';
import { softDeleteFile } from '../../src/services/deleteService';
import { removeShortcutsForTargets } from '../../src/services/specialFoldersService';
import { tryRebuildPublicFoldersIndex } from '../../src/services/publicSpreadsheetService';
import { ResultStatus, UserRole, UserStatus } from '../../src/types/enums';

const mockAuth          = authenticateRequest        as jest.Mock;
const mockScan          = scanEventForDuplicates     as jest.Mock;
const mockSoftDelete    = softDeleteFile             as jest.Mock;
const mockSweep         = removeShortcutsForTargets  as jest.Mock;
const mockRefreshPublic = tryRebuildPublicFoldersIndex as jest.Mock;

function user(role: UserRole, clubId = 'Misty_Mountain') {
  return {
    status: ResultStatus.SUCCESS,
    data: {
      email: 'admin@mmrunners.org',
      firstName: 'A', lastName: 'Dmin',
      role, status: UserStatus.ACTIVE, clubId,
      addedDate: '2025-01-01', addedBy: 'root@mmrunners.org', lastLoginAt: '',
    },
  };
}

function group(clubName: string) {
  return {
    clubName,
    reason: 'md5',
    keeper: { fileId: 'k1', fileName: 'a.jpeg', sizeBytes: 10, createdTime: '', tag: '', batchFolderName: '' },
    duplicates: [
      { fileId: 'd1', fileName: 'a (1).jpeg', sizeBytes: 10, createdTime: '', tag: '', batchFolderName: 'b1' },
    ],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockReturnValue(user(UserRole.SUPER_ADMIN));
  mockSweep.mockReturnValue({ shortcutsRemoved: 0, foldersTouched: 0, errors: [] });
  mockSoftDelete.mockReturnValue({ status: ResultStatus.SUCCESS, message: 'ok', deleteId: 'x' });
});

// ─── serverScanDuplicateFiles ────────────────────────────────────────────────

describe('serverScanDuplicateFiles()', () => {
  it('rejects unauthenticated callers without scanning', () => {
    mockAuth.mockReturnValue({ status: ResultStatus.ERROR, message: 'no' });
    const r = serverScanDuplicateFiles({ sessionToken: '', eventId: 'e1' });
    expect(r.status).toBe('error');
    expect(mockScan).not.toHaveBeenCalled();
  });

  it('requires an eventId', () => {
    const r = serverScanDuplicateFiles({ sessionToken: 'v' });
    expect(r.status).toBe('error');
    expect(r.message).toMatch(/eventId/);
  });

  it('returns the full report for super admins', () => {
    mockScan.mockReturnValue({
      status: ResultStatus.SUCCESS,
      message: 'scanned',
      data: {
        eventId: 'e1', filesScanned: 10,
        groups: [group('Misty_Mountain'), group('CHI')],
        duplicateFileCount: 2, duplicateBytes: 20,
      },
    });
    const r = serverScanDuplicateFiles({ sessionToken: 'v', eventId: 'e1' });
    expect(r.status).toBe('success');
    expect((r.data as { groups: unknown[] }).groups).toHaveLength(2);
  });

  it('filters groups to the club admin\'s own club and recomputes totals', () => {
    mockAuth.mockReturnValue(user(UserRole.CLUB_ADMIN, 'CHI'));
    mockScan.mockReturnValue({
      status: ResultStatus.SUCCESS,
      message: 'scanned',
      data: {
        eventId: 'e1', filesScanned: 10,
        groups: [group('Misty_Mountain'), group('CHI')],
        duplicateFileCount: 2, duplicateBytes: 20,
      },
    });
    const r = serverScanDuplicateFiles({ sessionToken: 'v', eventId: 'e1' });
    const data = r.data as { groups: Array<{ clubName: string }>; duplicateFileCount: number; duplicateBytes: number };
    expect(data.groups).toHaveLength(1);
    expect(data.groups[0].clubName).toBe('CHI');
    expect(data.duplicateFileCount).toBe(1);
    expect(data.duplicateBytes).toBe(10);
  });

  it('propagates scan errors', () => {
    mockScan.mockReturnValue({ status: ResultStatus.ERROR, message: 'event not found' });
    const r = serverScanDuplicateFiles({ sessionToken: 'v', eventId: 'bad' });
    expect(r.status).toBe('error');
    expect(r.message).toMatch(/event not found/);
  });
});

// ─── serverTrashDuplicateFiles ───────────────────────────────────────────────

describe('serverTrashDuplicateFiles()', () => {
  const items = [
    { fileId: 'd1', fileName: 'a (1).jpeg', clubName: 'CHI', batchFolderName: 'b1' },
    { fileId: 'd2', fileName: 'Copy of b.jpeg', clubName: 'CHI', batchFolderName: 'b2' },
  ];

  it('rejects unauthenticated callers', () => {
    mockAuth.mockReturnValue({ status: ResultStatus.ERROR, message: 'no' });
    const r = serverTrashDuplicateFiles({ sessionToken: '', eventId: 'e1', items });
    expect(r.status).toBe('error');
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it('requires eventId and a non-empty items list', () => {
    expect(serverTrashDuplicateFiles({ sessionToken: 'v', eventId: 'e1', items: [] }).status).toBe('error');
    expect(serverTrashDuplicateFiles({ sessionToken: 'v', items }).status).toBe('error');
  });

  it('rejects club admins deleting another club\'s files', () => {
    mockAuth.mockReturnValue(user(UserRole.CLUB_ADMIN, 'Misty_Mountain'));
    const r = serverTrashDuplicateFiles({ sessionToken: 'v', eventId: 'e1', items });
    expect(r.status).toBe('error');
    expect(r.message).toMatch(/cannot delete files for/);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it('soft-deletes every item, sweeps shortcuts and refreshes the public sheet', () => {
    mockSweep.mockReturnValue({ shortcutsRemoved: 5, foldersTouched: 3, errors: [] });
    const r = serverTrashDuplicateFiles({ sessionToken: 'v', eventId: 'e1', items });

    expect(r.status).toBe('success');
    expect(mockSoftDelete).toHaveBeenCalledTimes(2);
    expect(mockSoftDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        driveFileId: 'd1',
        reason: 'Duplicate cleanup',
        actorEmail: 'admin@mmrunners.org',
      })
    );
    expect(mockSweep).toHaveBeenCalledWith(['d1', 'd2']);
    expect(mockRefreshPublic).toHaveBeenCalledTimes(1);
    const data = r.data as { deleted: number; shortcutsRemoved: number };
    expect(data.deleted).toBe(2);
    expect(data.shortcutsRemoved).toBe(5);
  });

  it('downgrades to warning and keeps going when one delete fails', () => {
    mockSoftDelete
      .mockReturnValueOnce({ status: ResultStatus.SUCCESS, message: 'ok', deleteId: 'x' })
      .mockReturnValueOnce({ status: ResultStatus.ERROR, message: 'drive 403' });

    const r = serverTrashDuplicateFiles({ sessionToken: 'v', eventId: 'e1', items });

    expect(r.status).toBe('warning');
    const data = r.data as { deleted: number; failed: number; errorSamples: string[] };
    expect(data.deleted).toBe(1);
    expect(data.failed).toBe(1);
    expect(data.errorSamples[0]).toMatch(/drive 403/);
    // Sweep still runs for the file that WAS deleted.
    expect(mockSweep).toHaveBeenCalledWith(['d1']);
  });

  it('skips the sweep and refresh entirely when nothing was deleted', () => {
    mockSoftDelete.mockReturnValue({ status: ResultStatus.ERROR, message: 'boom' });
    const r = serverTrashDuplicateFiles({ sessionToken: 'v', eventId: 'e1', items });
    expect(r.status).toBe('warning');
    expect(mockSweep).not.toHaveBeenCalled();
    expect(mockRefreshPublic).not.toHaveBeenCalled();
  });
});
