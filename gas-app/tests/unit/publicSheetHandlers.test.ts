/**
 * publicSheetHandlers.test.ts
 *
 * Covers the three google.script.run actions that back the Public Sheet page:
 *   - serverRefreshPublicSheet      (refresh only)
 *   - serverRebuildPhotoFolders     (loop events → rebuildEventPhotoFolders)
 *   - serverRebuildVideoFolders     (loop upload links → rebuildClubVideoFolder)
 *
 * Each handler must:
 *   1. Reject unauthenticated callers with a friendly error response.
 *   2. Succeed for ANY authenticated user (no role gate).
 *   3. Aggregate per-item failures into a status='warning' response rather
 *      than blowing up the whole call when one event/tuple fails.
 *   4. Always refresh the public sheet at the end of a rebuild, even if
 *      some items failed (so visible counts stay close to reality).
 */

jest.mock('../../src/middleware/authMiddleware', () => ({
  authenticateRequest: jest.fn(),
}));
jest.mock('../../src/services/eventService', () => ({
  listAll: jest.fn(),
}));
jest.mock('../../src/services/uploadLinkService', () => ({
  listAll: jest.fn(),
}));
jest.mock('../../src/services/specialFoldersService', () => ({
  rebuildEventPhotoFolders: jest.fn(),
  rebuildClubVideoFolder:   jest.fn(),
  rebuildClubAlbumFolder:   jest.fn(),
}));
jest.mock('../../src/services/publicSpreadsheetService', () => ({
  rebuildPublicFoldersIndex: jest.fn(),
}));

import {
  serverRefreshPublicSheet,
  serverRebuildPhotoFolders,
  serverRebuildVideoFolders,
} from '../../src/routes/publicSheetHandlers';
import { authenticateRequest } from '../../src/middleware/authMiddleware';
import { listAll as listAllEvents } from '../../src/services/eventService';
import { listAll as listAllUploadLinks } from '../../src/services/uploadLinkService';
import {
  rebuildEventPhotoFolders,
  rebuildClubVideoFolder,
  rebuildClubAlbumFolder,
} from '../../src/services/specialFoldersService';
import { rebuildPublicFoldersIndex } from '../../src/services/publicSpreadsheetService';
import { ResultStatus, UserRole, UserStatus } from '../../src/types/enums';

const mockAuthenticateRequest    = authenticateRequest    as jest.Mock;
const mockListAllEvents          = listAllEvents          as jest.Mock;
const mockListAllUploadLinks     = listAllUploadLinks     as jest.Mock;
const mockRebuildEventPhotos     = rebuildEventPhotoFolders as jest.Mock;
const mockRebuildClubVideo       = rebuildClubVideoFolder   as jest.Mock;
const mockRebuildClubAlbum       = rebuildClubAlbumFolder   as jest.Mock;
const mockRebuildPublicFolders   = rebuildPublicFoldersIndex as jest.Mock;

function authedUser() {
  return {
    status: ResultStatus.SUCCESS,
    data: {
      email:     'volunteer@example.com',
      firstName: 'V',
      lastName:  'Olunteer',
      role:      UserRole.CLUB_ADMIN,
      status:    UserStatus.ACTIVE,
      clubId:    'New_Bee',
      addedDate: '2025-01-01',
      addedBy:   'admin@mmrunners.org',
      lastLoginAt: '',
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Defaults — overridden per test where needed
  mockAuthenticateRequest.mockReturnValue(authedUser());
  mockRebuildPublicFolders.mockReturnValue(0);
  mockListAllEvents.mockReturnValue({ items: [], total: 0 });
  mockListAllUploadLinks.mockReturnValue([]);
  mockRebuildClubAlbum.mockReturnValue({ status: ResultStatus.SUCCESS });
});

// ═════════════════════════════════════════════════════════════════════════════
// serverRefreshPublicSheet
// ═════════════════════════════════════════════════════════════════════════════

describe('serverRefreshPublicSheet()', () => {
  it('rejects unauthenticated callers without invoking the service', () => {
    mockAuthenticateRequest.mockReturnValue({ status: ResultStatus.ERROR, message: 'no session' });

    const r = serverRefreshPublicSheet({ sessionToken: '' });

    expect(r.status).toBe('error');
    expect(r.message).toMatch(/Authentication required/i);
    expect(mockRebuildPublicFolders).not.toHaveBeenCalled();
  });

  it('refreshes the sheet for an authenticated club_admin', () => {
    mockRebuildPublicFolders.mockReturnValue(12);

    const r = serverRefreshPublicSheet({ sessionToken: 'valid' });

    expect(r.status).toBe('success');
    expect((r.data as Record<string, unknown>)['rowsWritten']).toBe(12);
    expect(mockRebuildPublicFolders).toHaveBeenCalledTimes(1);
  });

  it('returns error response when the underlying service throws', () => {
    mockRebuildPublicFolders.mockImplementation(() => { throw new Error('sheets down'); });

    const r = serverRefreshPublicSheet({ sessionToken: 'valid' });

    expect(r.status).toBe('error');
    expect(r.message).toMatch(/sheets down/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// serverRebuildPhotoFolders
// ═════════════════════════════════════════════════════════════════════════════

describe('serverRebuildPhotoFolders()', () => {
  it('rejects unauthenticated callers without touching any event', () => {
    mockAuthenticateRequest.mockReturnValue({ status: ResultStatus.ERROR, message: 'nope' });

    const r = serverRebuildPhotoFolders({ sessionToken: '' });

    expect(r.status).toBe('error');
    expect(mockListAllEvents).not.toHaveBeenCalled();
    expect(mockRebuildEventPhotos).not.toHaveBeenCalled();
  });

  it('loops every event and aggregates the result', () => {
    mockListAllEvents.mockReturnValue({
      items: [
        { eventId: 'e1', eventName: 'NYC' },
        { eventId: 'e2', eventName: 'Boston' },
      ],
      total: 2,
    });
    mockRebuildEventPhotos.mockReturnValue({ status: ResultStatus.SUCCESS });
    mockRebuildPublicFolders.mockReturnValue(7);

    const r = serverRebuildPhotoFolders({ sessionToken: 'valid' });

    expect(r.status).toBe('success');
    expect(mockRebuildEventPhotos).toHaveBeenCalledTimes(2);
    const data = r.data as { attempted: number; succeeded: number; failed: number; rowsWritten: number };
    expect(data.attempted).toBe(2);
    expect(data.succeeded).toBe(2);
    expect(data.failed).toBe(0);
    expect(data.rowsWritten).toBe(7);
  });

  it('downgrades to warning + collects samples when an event rebuild fails', () => {
    mockListAllEvents.mockReturnValue({
      items: [
        { eventId: 'good', eventName: 'OK Race' },
        { eventId: 'bad',  eventName: 'Broken Race' },
      ],
      total: 2,
    });
    mockRebuildEventPhotos
      .mockReturnValueOnce({ status: ResultStatus.SUCCESS })
      .mockReturnValueOnce({ status: ResultStatus.ERROR, message: 'no folder' });

    const r = serverRebuildPhotoFolders({ sessionToken: 'valid' });

    expect(r.status).toBe('warning');
    const data = r.data as { failed: number; errorSamples: string[] };
    expect(data.failed).toBe(1);
    expect(data.errorSamples[0]).toContain('Broken Race');
    expect(data.errorSamples[0]).toContain('no folder');
  });

  it('refreshes the public sheet even when an event rebuild throws', () => {
    mockListAllEvents.mockReturnValue({
      items: [{ eventId: 'e1', eventName: 'Throws' }],
      total: 1,
    });
    mockRebuildEventPhotos.mockImplementation(() => { throw new Error('drive 500'); });

    const r = serverRebuildPhotoFolders({ sessionToken: 'valid' });

    expect(r.status).toBe('warning');
    expect(mockRebuildPublicFolders).toHaveBeenCalledTimes(1);
    const samples = (r.data as { errorSamples: string[] }).errorSamples;
    expect(samples.some((s) => s.includes('drive 500'))).toBe(true);
  });

  it('caps the error sample at 5 entries to keep payloads small', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ eventId: 'e' + i, eventName: 'Evt ' + i }));
    mockListAllEvents.mockReturnValue({ items, total: items.length });
    mockRebuildEventPhotos.mockReturnValue({ status: ResultStatus.ERROR, message: 'boom' });

    const r = serverRebuildPhotoFolders({ sessionToken: 'valid' });

    const data = r.data as { failed: number; errorSamples: string[] };
    expect(data.failed).toBe(10);
    expect(data.errorSamples).toHaveLength(5);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// serverRebuildVideoFolders
// ═════════════════════════════════════════════════════════════════════════════

describe('serverRebuildVideoFolders()', () => {
  it('rejects unauthenticated callers', () => {
    mockAuthenticateRequest.mockReturnValue({ status: ResultStatus.ERROR, message: 'nope' });
    const r = serverRebuildVideoFolders({ sessionToken: '' });
    expect(r.status).toBe('error');
    expect(mockRebuildClubVideo).not.toHaveBeenCalled();
  });

  it('dedupes (eventId, clubName, tag) triples — multiple revoked link rows count as one', () => {
    mockListAllUploadLinks.mockReturnValue([
      { eventId: 'e1', clubName: 'New_Bee',  tag: 'ALL' },
      { eventId: 'e1', clubName: 'New_Bee',  tag: 'ALL' },        // duplicate
      { eventId: 'e1', clubName: 'New_Bee',  tag: 'finish_line' }, // different tag
      { eventId: 'e2', clubName: 'Old_Bird', tag: 'ALL' },
    ]);
    mockRebuildClubVideo.mockReturnValue({ status: ResultStatus.SUCCESS });

    const r = serverRebuildVideoFolders({ sessionToken: 'valid' });

    expect(r.status).toBe('success');
    expect(mockRebuildClubVideo).toHaveBeenCalledTimes(3); // not 4
    const data = r.data as { attempted: number; succeeded: number };
    expect(data.attempted).toBe(3);
    expect(data.succeeded).toBe(3);
  });

  it('reports a warning when one of many triples fails', () => {
    mockListAllUploadLinks.mockReturnValue([
      { eventId: 'e1', clubName: 'A', tag: 'ALL' },
      { eventId: 'e2', clubName: 'B', tag: 'ALL' },
    ]);
    mockRebuildClubVideo
      .mockReturnValueOnce({ status: ResultStatus.SUCCESS })
      .mockReturnValueOnce({ status: ResultStatus.ERROR, message: 'tag folder gone' });

    const r = serverRebuildVideoFolders({ sessionToken: 'valid' });

    expect(r.status).toBe('warning');
    const data = r.data as { failed: number; errorSamples: string[] };
    expect(data.failed).toBe(1);
    expect(data.errorSamples[0]).toContain('e2/B/ALL');
  });

  it('always refreshes the public sheet after the loop, even on a no-op (no links)', () => {
    mockListAllUploadLinks.mockReturnValue([]);
    const r = serverRebuildVideoFolders({ sessionToken: 'valid' });
    expect(r.status).toBe('success');
    expect(mockRebuildClubVideo).not.toHaveBeenCalled();
    expect(mockRebuildClubAlbum).not.toHaveBeenCalled();
    expect(mockRebuildPublicFolders).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the Album folder for every deduped tuple alongside Videos', () => {
    mockListAllUploadLinks.mockReturnValue([
      { eventId: 'e1', clubName: 'New_Bee',  tag: 'ALL' },
      { eventId: 'e1', clubName: 'New_Bee',  tag: 'ALL' }, // duplicate
      { eventId: 'e2', clubName: 'Old_Bird', tag: 'ALL' },
    ]);
    mockRebuildClubVideo.mockReturnValue({ status: ResultStatus.SUCCESS });

    const r = serverRebuildVideoFolders({ sessionToken: 'valid' });

    expect(r.status).toBe('success');
    expect(mockRebuildClubAlbum).toHaveBeenCalledTimes(2);
    expect(mockRebuildClubAlbum).toHaveBeenCalledWith('e1', 'New_Bee', 'ALL');
    expect(mockRebuildClubAlbum).toHaveBeenCalledWith('e2', 'Old_Bird', 'ALL');
  });

  it('marks a tuple failed when the Album rebuild fails even if Videos succeeded', () => {
    mockListAllUploadLinks.mockReturnValue([
      { eventId: 'e1', clubName: 'A', tag: 'ALL' },
    ]);
    mockRebuildClubVideo.mockReturnValue({ status: ResultStatus.SUCCESS });
    mockRebuildClubAlbum.mockReturnValue({ status: ResultStatus.ERROR, message: 'album boom' });

    const r = serverRebuildVideoFolders({ sessionToken: 'valid' });

    expect(r.status).toBe('warning');
    const data = r.data as { failed: number; errorSamples: string[] };
    expect(data.failed).toBe(1);
    expect(data.errorSamples[0]).toContain('[Album]');
    expect(data.errorSamples[0]).toContain('album boom');
  });
});
