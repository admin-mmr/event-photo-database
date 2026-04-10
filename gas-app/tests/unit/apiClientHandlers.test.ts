/**
 * apiClientHandlers.test.ts — Phase 5 Cross-Org REST API handler tests.
 *
 * These tests exercise the three HTTP handler functions directly.
 * Rate limiting and auth are also mocked so tests focus on handler logic.
 */

// ─── Mock auth + rate limit (must precede imports) ────────────────────────────

jest.mock('../../src/middleware/authMiddleware', () => ({
  ...jest.requireActual('../../src/middleware/authMiddleware'),
  authenticateApiKey: jest.fn(),
}));

jest.mock('../../src/services/rateLimitService', () => ({
  checkAndIncrementRateLimit: jest.fn(),
}));

import { authenticateApiKey } from '../../src/middleware/authMiddleware';
import { checkAndIncrementRateLimit } from '../../src/services/rateLimitService';

import {
  handleApiCheckFolder,
  handleApiListFiles,
  handleApiUploadFile,
} from '../../src/routes/apiClientHandlers';
import {
  resetMockSheets,
  TEST_API_CLIENT_EMAIL,
} from '../mocks/gasGlobals';
import { ResultStatus, UserRole, UserStatus } from '../../src/types/enums';
import { UserRecord } from '../../src/types/models';

// ─── Typed mocks ──────────────────────────────────────────────────────────────

const mockAuthApiKey = authenticateApiKey as jest.MockedFunction<typeof authenticateApiKey>;
const mockRateLimit  = checkAndIncrementRateLimit as jest.MockedFunction<typeof checkAndIncrementRateLimit>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_USER: UserRecord = {
  email:       TEST_API_CLIENT_EMAIL,
  runningClub: 'New_Bee',
  role:        UserRole.API_CLIENT,
  status:      UserStatus.ACTIVE,
  addedDate:   '2025-06-01',
  addedBy:     'admin@mmrunners.org',
};

/** Sets up the auth + rate-limit mocks to allow the request through */
function allowGatekeep(): void {
  mockAuthApiKey.mockReturnValue({ status: ResultStatus.SUCCESS, message: 'OK', data: VALID_USER });
  mockRateLimit.mockReturnValue({
    status: ResultStatus.SUCCESS,
    message: '1/60',
    data: {
      allowed: true,
      requestCount: 1,
      limitPerHour: 60,
      windowStart: new Date().toISOString(),
      windowResetsAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  });
}

/** Parses the JSON body that was written to the mock ContentService */
function parseResponse(): Record<string, unknown> {
  const { mockContentService } = require('../mocks/gasGlobals');
  const lastCall = mockContentService.createTextOutput.mock.calls.slice(-1)[0];
  return JSON.parse(lastCall[0] as string) as Record<string, unknown>;
}

// ─── handleApiCheckFolder ─────────────────────────────────────────────────────

describe('handleApiCheckFolder()', () => {
  beforeEach(() => {
    resetMockSheets();
    allowGatekeep();
    const { mockContentService } = require('../mocks/gasGlobals');
    mockContentService.createTextOutput.mockClear();
  });

  it('returns found=true with folder details for a known event name', () => {
    handleApiCheckFolder({ api_key: TEST_API_CLIENT_EMAIL, event_name: 'NYC Marathon' });
    const res = parseResponse();
    expect(res['status']).toBe('success');
    expect((res['data'] as Record<string, unknown>)['found']).toBe(true);
    expect((res['data'] as Record<string, unknown>)['driveFolderId']).toBe('drive-folder-id-001');
  });

  it('is case-insensitive for event_name matching', () => {
    handleApiCheckFolder({ api_key: TEST_API_CLIENT_EMAIL, event_name: 'nyc marathon' });
    const res = parseResponse();
    expect((res['data'] as Record<string, unknown>)['found']).toBe(true);
  });

  it('returns found=false when the event does not exist', () => {
    handleApiCheckFolder({ api_key: TEST_API_CLIENT_EMAIL, event_name: 'Nonexistent Race' });
    const res = parseResponse();
    expect(res['status']).toBe('success');
    expect((res['data'] as Record<string, unknown>)['found']).toBe(false);
  });

  it('returns code=400 when event_name is missing', () => {
    handleApiCheckFolder({ api_key: TEST_API_CLIENT_EMAIL, event_name: '' });
    const res = parseResponse();
    expect(res['status']).toBe('error');
    expect(res['code']).toBe(400);
  });

  it('returns code=401 when auth fails', () => {
    mockAuthApiKey.mockReturnValueOnce({ status: ResultStatus.ERROR, message: 'Invalid API key' });
    handleApiCheckFolder({ api_key: 'bad-key', event_name: 'NYC Marathon' });
    const res = parseResponse();
    expect(res['status']).toBe('error');
    expect(res['code']).toBe(401);
  });

  it('returns code=429 when rate limit is exceeded', () => {
    mockRateLimit.mockReturnValueOnce({
      status: ResultStatus.SUCCESS,
      message: 'Rate limit exceeded',
      data: {
        allowed: false,
        requestCount: 60,
        limitPerHour: 60,
        windowStart: new Date().toISOString(),
        windowResetsAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    handleApiCheckFolder({ api_key: TEST_API_CLIENT_EMAIL, event_name: 'NYC Marathon' });
    const res = parseResponse();
    expect(res['code']).toBe(429);
  });

  it('returns eventId, eventName, and eventDate in the data payload', () => {
    handleApiCheckFolder({ api_key: TEST_API_CLIENT_EMAIL, event_name: 'Boston Marathon' });
    const res = parseResponse();
    const data = res['data'] as Record<string, unknown>;
    expect(data['eventId']).toBe('evt-uuid-002');
    expect(data['eventName']).toBe('Boston Marathon');
    expect(data['eventDate']).toBe('2025-04-21');
  });
});

// ─── handleApiListFiles ───────────────────────────────────────────────────────

describe('handleApiListFiles()', () => {
  beforeEach(() => {
    resetMockSheets();
    allowGatekeep();
    const { mockContentService } = require('../mocks/gasGlobals');
    mockContentService.createTextOutput.mockClear();
  });

  it('returns code=400 when folder_id is missing', () => {
    handleApiListFiles({ api_key: TEST_API_CLIENT_EMAIL, folder_id: '' });
    const res = parseResponse();
    expect(res['status']).toBe('error');
    expect(res['code']).toBe(400);
    expect(String(res['message'])).toMatch(/folder_id/i);
  });

  it('returns success with an empty files array when folder has no batch subfolders', () => {
    // mockDriveApp.getFolderById returns mockFolder, which has getFolders returning hasNext=false
    handleApiListFiles({ api_key: TEST_API_CLIENT_EMAIL, folder_id: 'some-folder-id' });
    const res = parseResponse();
    expect(res['status']).toBe('success');
    const data = res['data'] as Record<string, unknown>;
    expect(Array.isArray(data['files'])).toBe(true);
    expect(data['count']).toBe(0);
  });

  it('returns code=401 when auth fails', () => {
    mockAuthApiKey.mockReturnValueOnce({ status: ResultStatus.ERROR, message: 'Invalid API key' });
    handleApiListFiles({ api_key: 'bad', folder_id: 'folder-id' });
    const res = parseResponse();
    expect(res['code']).toBe(401);
  });
});

// ─── handleApiUploadFile ──────────────────────────────────────────────────────

describe('handleApiUploadFile()', () => {
  const VALID_BODY = {
    api_key:     TEST_API_CLIENT_EMAIL,
    event_name:  'NYC Marathon',
    club_name:   'New_Bee',
    file_name:   'photo_001.jpg',
    mime_type:   'image/jpeg',
    base64_data: 'AAABAAD/',  // minimal valid base64
  };

  beforeEach(() => {
    resetMockSheets();
    allowGatekeep();
    const { mockContentService } = require('../mocks/gasGlobals');
    mockContentService.createTextOutput.mockClear();
  });

  it('returns success with fileId, fileName, sizeBytes, batchFolderName', () => {
    handleApiUploadFile({ ...VALID_BODY });
    const res = parseResponse();
    expect(res['status']).toBe('success');
    const data = res['data'] as Record<string, unknown>;
    expect(data['fileId']).toBeDefined();
    expect(data['fileName']).toBe('photo_001.jpg');
    expect(data['batchFolderName']).toBeDefined();
    expect(typeof data['sizeBytes']).toBe('number');
  });

  it('returns code=400 when a required field is missing', () => {
    const { file_name: _, ...noFileName } = VALID_BODY;
    handleApiUploadFile(noFileName);
    const res = parseResponse();
    expect(res['status']).toBe('error');
    expect(res['code']).toBe(400);
    expect(String(res['message'])).toMatch(/file_name/i);
  });

  it('returns code=400 for an unsupported mime_type', () => {
    handleApiUploadFile({ ...VALID_BODY, mime_type: 'image/gif' });
    const res = parseResponse();
    expect(res['status']).toBe('error');
    expect(res['code']).toBe(400);
    expect(String(res['message'])).toMatch(/mime_type/i);
  });

  it('returns code=404 when the event_name does not exist', () => {
    handleApiUploadFile({ ...VALID_BODY, event_name: 'Unknown Race' });
    const res = parseResponse();
    expect(res['status']).toBe('error');
    expect(res['code']).toBe(404);
    expect(String(res['message'])).toMatch(/Event not found/i);
  });

  it('returns code=401 when auth fails', () => {
    mockAuthApiKey.mockReturnValueOnce({ status: ResultStatus.ERROR, message: 'Invalid key' });
    handleApiUploadFile({ ...VALID_BODY, api_key: 'bad-key' });
    const res = parseResponse();
    expect(res['code']).toBe(401);
  });

  it('returns code=429 when rate limit is exceeded', () => {
    mockRateLimit.mockReturnValueOnce({
      status: ResultStatus.SUCCESS,
      message: 'Rate limit exceeded',
      data: {
        allowed: false,
        requestCount: 60,
        limitPerHour: 60,
        windowStart: new Date().toISOString(),
        windowResetsAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    handleApiUploadFile({ ...VALID_BODY });
    const res = parseResponse();
    expect(res['code']).toBe(429);
  });

  it('includes the logId returned from appendUploadLog', () => {
    handleApiUploadFile({ ...VALID_BODY });
    const res = parseResponse();
    const data = res['data'] as Record<string, unknown>;
    // logId may be null if Upload_Log append has no rows, but key must exist
    expect('logId' in data).toBe(true);
  });

  it('accepts HEIC mime type', () => {
    handleApiUploadFile({ ...VALID_BODY, mime_type: 'image/heic', file_name: 'photo.heic' });
    const res = parseResponse();
    expect(res['status']).toBe('success');
  });
});
