/**
 * Unit tests for src/routes/volunteerRoutes.ts
 *
 * All external service calls (uploadLinkService, eventService, driveService,
 * sessionService, tokenService, uploadLogService, auditLogService, syncJobService)
 * are mocked. HtmlService and ScriptApp come from the global GAS mock.
 *
 * Test coverage:
 *   - volunteerConfirmPage:         valid token, revoked link, unknown token
 *   - handleVolunteerOAuthCallback: success path, code-exchange failure, revoked link
 *   - volunteerUploadPage:          valid session, expired session, revoked link post-auth
 *   - serverGetVolunteerDriveToken: success, expired session, missing event, Drive error
 *   - serverCompleteVolunteerUpload: success, expired session, link revoked mid-session
 *   - createVolunteerSession / lookupVolunteerSession: round-trip
 */

import {
  volunteerConfirmPage,
  handleVolunteerOAuthCallback,
  volunteerUploadPage,
  serverGetVolunteerDriveToken,
  serverCompleteVolunteerUpload,
  createVolunteerSession,
  lookupVolunteerSession,
  VOLUNTEER_CONSENT_LINE,
} from '../../src/routes/volunteerRoutes';
import { ResultStatus } from '../../src/types/enums';
import {
  mockHtmlTemplate,
  mockScriptCache,
  resetMockCache,
  mockSheets,
  resetMockSheets,
} from '../mocks/gasGlobals';

// ─── Service mocks ────────────────────────────────────────────────────────────

jest.mock('../../src/services/uploadLinkService', () => ({
  validateLink: jest.fn(),
  findByToken:  jest.fn(),
}));

jest.mock('../../src/services/eventService', () => ({
  findById: jest.fn(),
}));

jest.mock('../../src/services/tokenService', () => ({
  exchangeOAuthCode: jest.fn(),
}));

jest.mock('../../src/services/driveService', () => ({
  getOrCreateClubFolder: jest.fn(),
  createBatchFolder:     jest.fn(),
}));

jest.mock('../../src/services/uploadLogService', () => ({
  appendUploadLog: jest.fn(),
}));

jest.mock('../../src/services/auditLogService', () => ({
  appendAuditLog: jest.fn(),
}));

jest.mock('../../src/services/syncQueueService', () => ({
  enqueueBatchSync: jest.fn(),
}));

jest.mock('../../src/utils/scriptUrl', () => ({
  getCanonicalScriptUrl: jest.fn().mockReturnValue('https://script.google.com/macros/s/mock/exec'),
}));

// ─── Import mocked services ───────────────────────────────────────────────────

import { validateLink } from '../../src/services/uploadLinkService';
import { findById as findEventById } from '../../src/services/eventService';
import { exchangeOAuthCode } from '../../src/services/tokenService';
import { getOrCreateClubFolder, createBatchFolder } from '../../src/services/driveService';
import { appendUploadLog } from '../../src/services/uploadLogService';
import { appendAuditLog } from '../../src/services/auditLogService';
import { enqueueBatchSync } from '../../src/services/syncQueueService';

const mockValidateLink     = validateLink     as jest.Mock;
const mockFindEventById    = findEventById    as jest.Mock;
const mockExchangeOAuthCode = exchangeOAuthCode as jest.Mock;
const mockGetOrCreateClubFolder = getOrCreateClubFolder as jest.Mock;
const mockCreateBatchFolder     = createBatchFolder     as jest.Mock;
const mockAppendUploadLog  = appendUploadLog  as jest.Mock;
const mockAppendAuditLog   = appendAuditLog   as jest.Mock;
const mockEnqueueBatchSync = enqueueBatchSync  as jest.Mock;

// ─── Test fixtures ────────────────────────────────────────────────────────────

const VALID_TOKEN   = 'abc123token';
const VALID_LINK    = {
  linkId:        'link-uuid-001',
  eventId:       'evt-uuid-001',
  clubName:      'New_Bee',
  token:         VALID_TOKEN,
  version:       1,
  generatedBy:   'admin@mmrunners.org',
  generatedAt:   '2026-04-01T10:00:00Z',
  revokedAt:     '',
  revokedBy:     '',
  revokedReason: '',
};

const VALID_EVENT = {
  eventId:       'evt-uuid-001',
  eventName:     'NYC Marathon',
  eventDate:     '2025-11-03',
  folderName:    '2025-11-03_NYC_Marathon',
  driveFolderId: 'drive-folder-id-001',
  createdBy:     'admin@mmrunners.org',
  createdAt:     '2025-10-01T09:00:00Z',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockSpreadsheetApp() {
  const sApp = (global as Record<string, unknown>)['SpreadsheetApp'] as {
    openById: jest.Mock;
  };
  sApp.openById.mockReturnValue({
    getSheetByName: jest.fn().mockImplementation((name: string) => mockSheets[name] ?? null),
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetMockSheets();
  resetMockCache();
  mockSpreadsheetApp();
  jest.clearAllMocks();
  mockHtmlTemplate.evaluate.mockReturnValue({
    setTitle: jest.fn().mockReturnThis(),
    setXFrameOptionsMode: jest.fn().mockReturnThis(),
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// volunteerConfirmPage
// ═════════════════════════════════════════════════════════════════════════════

describe('volunteerConfirmPage()', () => {
  it('renders confirm template when token is valid', () => {
    mockValidateLink.mockReturnValue({ status: ResultStatus.SUCCESS, data: VALID_LINK });
    mockFindEventById.mockReturnValue(VALID_EVENT);

    const result = volunteerConfirmPage(VALID_TOKEN);

    expect(mockHtmlTemplate.evaluate).toHaveBeenCalled();
    // HtmlService.createTemplateFromFile should have been called with the confirm template
    const htmlService = (global as Record<string, unknown>)['HtmlService'] as {
      createTemplateFromFile: jest.Mock;
    };
    expect(htmlService.createTemplateFromFile).toHaveBeenCalledWith(
      expect.stringContaining('volunteer/confirm')
    );
    expect(result).toBeDefined();
  });

  it('injects eventName and clubName into the template', () => {
    mockValidateLink.mockReturnValue({ status: ResultStatus.SUCCESS, data: VALID_LINK });
    mockFindEventById.mockReturnValue(VALID_EVENT);

    const htmlService = (global as Record<string, unknown>)['HtmlService'] as {
      createTemplateFromFile: jest.Mock;
    };
    // Capture what gets assigned to the template
    let assignedData: Record<string, unknown> = {};
    htmlService.createTemplateFromFile.mockImplementation(() => {
      const tpl: Record<string, unknown> = {
        evaluate: jest.fn().mockReturnValue({
          setTitle: jest.fn().mockReturnThis(),
          setXFrameOptionsMode: jest.fn().mockReturnThis(),
        }),
      };
      // Object.assign will mutate tpl — capture it
      return new Proxy(tpl, {
        set(target, key, value) {
          target[key as string] = value;
          assignedData[key as string] = value;
          return true;
        },
      });
    });

    volunteerConfirmPage(VALID_TOKEN);

    expect(assignedData['eventName']).toBe('NYC Marathon');
    expect(assignedData['clubName']).toBe('New_Bee');
    expect(assignedData['consentLine']).toBe(VOLUNTEER_CONSENT_LINE);
    expect(assignedData['linkToken']).toBe(VALID_TOKEN);
  });

  it('falls back to eventId in template when event record not found', () => {
    mockValidateLink.mockReturnValue({ status: ResultStatus.SUCCESS, data: VALID_LINK });
    mockFindEventById.mockReturnValue(null);

    const htmlService = (global as Record<string, unknown>)['HtmlService'] as {
      createTemplateFromFile: jest.Mock;
    };
    let assignedData: Record<string, unknown> = {};
    htmlService.createTemplateFromFile.mockImplementation(() => {
      const tpl: Record<string, unknown> = {
        evaluate: jest.fn().mockReturnValue({
          setTitle: jest.fn().mockReturnThis(),
          setXFrameOptionsMode: jest.fn().mockReturnThis(),
        }),
      };
      return new Proxy(tpl, {
        set(target, key, value) { target[key as string] = value; assignedData[key as string] = value; return true; },
      });
    });

    volunteerConfirmPage(VALID_TOKEN);
    expect(assignedData['eventName']).toBe('evt-uuid-001'); // falls back to eventId
  });

  it('renders link_error template when token is unknown', () => {
    mockValidateLink.mockReturnValue({
      status: ResultStatus.ERROR,
      message: 'This link is not recognized.',
    });

    const htmlService = (global as Record<string, unknown>)['HtmlService'] as {
      createTemplateFromFile: jest.Mock;
    };

    volunteerConfirmPage('bad-token');

    expect(htmlService.createTemplateFromFile).toHaveBeenCalledWith(
      expect.stringContaining('volunteer/link_error')
    );
  });

  it('renders link_error template when link is revoked', () => {
    mockValidateLink.mockReturnValue({
      status: ResultStatus.ERROR,
      message: 'This link has been revoked.',
    });

    const htmlService = (global as Record<string, unknown>)['HtmlService'] as {
      createTemplateFromFile: jest.Mock;
    };

    volunteerConfirmPage('revoked-token');

    expect(htmlService.createTemplateFromFile).toHaveBeenCalledWith(
      expect.stringContaining('volunteer/link_error')
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// handleVolunteerOAuthCallback
// ═════════════════════════════════════════════════════════════════════════════

describe('handleVolunteerOAuthCallback()', () => {
  it('creates a volunteer session and returns a redirect page on success', () => {
    mockExchangeOAuthCode.mockReturnValue({
      status: ResultStatus.SUCCESS,
      data: { email: 'volunteer@example.com' },
    });
    mockValidateLink.mockReturnValue({ status: ResultStatus.SUCCESS, data: VALID_LINK });

    const result = handleVolunteerOAuthCallback('auth-code-xyz', VALID_TOKEN);

    // Should have created a session
    expect(mockScriptCache.put).toHaveBeenCalled();
    // Should return an HTML output (the continue-to-upload redirect page)
    expect(result).toBeDefined();
  });

  it('encodes the volunteer email in the session payload', () => {
    mockExchangeOAuthCode.mockReturnValue({
      status: ResultStatus.SUCCESS,
      data: { email: 'volunteer@example.com' },
    });
    mockValidateLink.mockReturnValue({ status: ResultStatus.SUCCESS, data: VALID_LINK });

    handleVolunteerOAuthCallback('auth-code-xyz', VALID_TOKEN);

    // Check that the cache was written with a payload containing the email and the link token
    const putCall = mockScriptCache.put.mock.calls[0];
    expect(putCall).toBeDefined();
    const cachedValue = JSON.parse(putCall[1] as string) as { email: string; role: string };
    expect(cachedValue.email).toBe('volunteer@example.com');
    expect(cachedValue.role).toContain('volunteer:');
    expect(cachedValue.role).toContain(VALID_TOKEN);
  });

  it('renders link_error when code exchange fails', () => {
    mockExchangeOAuthCode.mockReturnValue({
      status: ResultStatus.ERROR,
      message: 'Invalid authorization code',
    });

    const htmlService = (global as Record<string, unknown>)['HtmlService'] as {
      createTemplateFromFile: jest.Mock;
    };

    handleVolunteerOAuthCallback('bad-code', VALID_TOKEN);

    expect(htmlService.createTemplateFromFile).toHaveBeenCalledWith(
      expect.stringContaining('volunteer/link_error')
    );
  });

  it('renders link_error when link is revoked after OAuth flow starts', () => {
    mockExchangeOAuthCode.mockReturnValue({
      status: ResultStatus.SUCCESS,
      data: { email: 'volunteer@example.com' },
    });
    mockValidateLink.mockReturnValue({
      status: ResultStatus.ERROR,
      message: 'This link has been revoked.',
    });

    const htmlService = (global as Record<string, unknown>)['HtmlService'] as {
      createTemplateFromFile: jest.Mock;
    };

    handleVolunteerOAuthCallback('code-xyz', 'revoked-token');

    expect(htmlService.createTemplateFromFile).toHaveBeenCalledWith(
      expect.stringContaining('volunteer/link_error')
    );
    // No session should have been created
    expect(mockScriptCache.put).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// volunteerUploadPage
// ═════════════════════════════════════════════════════════════════════════════

describe('volunteerUploadPage()', () => {
  it('renders the upload template for a valid vsession', () => {
    // Create a real vsession via the session service (which uses the cache mock)
    const vsession = createVolunteerSession('volunteer@example.com', VALID_TOKEN);
    mockValidateLink.mockReturnValue({ status: ResultStatus.SUCCESS, data: VALID_LINK });
    mockFindEventById.mockReturnValue(VALID_EVENT);

    const htmlService = (global as Record<string, unknown>)['HtmlService'] as {
      createTemplateFromFile: jest.Mock;
    };

    volunteerUploadPage(vsession);

    expect(htmlService.createTemplateFromFile).toHaveBeenCalledWith(
      expect.stringContaining('volunteer/upload')
    );
  });

  it('renders link_error when vsession is expired or missing', () => {
    const htmlService = (global as Record<string, unknown>)['HtmlService'] as {
      createTemplateFromFile: jest.Mock;
    };

    volunteerUploadPage('nonexistent-session-token');

    expect(htmlService.createTemplateFromFile).toHaveBeenCalledWith(
      expect.stringContaining('volunteer/link_error')
    );
  });

  it('renders link_error when link is revoked after session was created', () => {
    const vsession = createVolunteerSession('volunteer@example.com', VALID_TOKEN);
    mockValidateLink.mockReturnValue({
      status: ResultStatus.ERROR,
      message: 'This link has been revoked.',
    });

    const htmlService = (global as Record<string, unknown>)['HtmlService'] as {
      createTemplateFromFile: jest.Mock;
    };

    volunteerUploadPage(vsession);

    expect(htmlService.createTemplateFromFile).toHaveBeenCalledWith(
      expect.stringContaining('volunteer/link_error')
    );
  });

  it('injects event and club info into upload template', () => {
    const vsession = createVolunteerSession('volunteer@example.com', VALID_TOKEN);
    mockValidateLink.mockReturnValue({ status: ResultStatus.SUCCESS, data: VALID_LINK });
    mockFindEventById.mockReturnValue(VALID_EVENT);

    const htmlService = (global as Record<string, unknown>)['HtmlService'] as {
      createTemplateFromFile: jest.Mock;
    };
    let assignedData: Record<string, unknown> = {};
    htmlService.createTemplateFromFile.mockImplementation(() => {
      const tpl: Record<string, unknown> = {
        evaluate: jest.fn().mockReturnValue({
          setTitle: jest.fn().mockReturnThis(),
          setXFrameOptionsMode: jest.fn().mockReturnThis(),
        }),
      };
      return new Proxy(tpl, {
        set(target, key, value) { target[key as string] = value; assignedData[key as string] = value; return true; },
      });
    });

    volunteerUploadPage(vsession);

    expect(assignedData['eventName']).toBe('NYC Marathon');
    expect(assignedData['clubName']).toBe('New_Bee');
    expect(assignedData['uploaderEmail']).toBe('volunteer@example.com');
    expect(assignedData['vsession']).toBe(vsession);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// serverGetVolunteerDriveToken
// ═════════════════════════════════════════════════════════════════════════════

describe('serverGetVolunteerDriveToken()', () => {
  it('returns accessToken, batchFolderId, batchFolderName, linkId on success', () => {
    const vsession = createVolunteerSession('volunteer@example.com', VALID_TOKEN);
    mockValidateLink.mockReturnValue({ status: ResultStatus.SUCCESS, data: VALID_LINK });
    mockFindEventById.mockReturnValue(VALID_EVENT);
    mockGetOrCreateClubFolder.mockReturnValue({
      status: ResultStatus.SUCCESS,
      data: { folderId: 'club-folder-id', folderName: 'New_Bee' },
    });
    mockCreateBatchFolder.mockReturnValue({
      status: ResultStatus.SUCCESS,
      data: { folderId: 'batch-folder-id', folderName: '20260422-120000_volunteerexample.com' },
    });

    const result = serverGetVolunteerDriveToken(vsession);

    expect(result).not.toHaveProperty('error');
    expect(result['accessToken']).toBe('mock-oauth-access-token');
    expect(result['batchFolderId']).toBe('batch-folder-id');
    expect(result['batchFolderName']).toMatch(/^\d{8}-\d{6}_/); // YYYYMMDD-HHMMSS_ prefix
    expect(result['linkId']).toBe('link-uuid-001');
  });

  it('returns error when vsession is expired', () => {
    const result = serverGetVolunteerDriveToken('expired-session');
    expect(result['error']).toBeDefined();
    expect(typeof result['error']).toBe('string');
  });

  it('returns error when link is no longer valid', () => {
    const vsession = createVolunteerSession('volunteer@example.com', VALID_TOKEN);
    mockValidateLink.mockReturnValue({
      status: ResultStatus.ERROR,
      message: 'Link revoked.',
    });

    const result = serverGetVolunteerDriveToken(vsession);
    expect(result['error']).toBeDefined();
  });

  it('returns error when event is not found', () => {
    const vsession = createVolunteerSession('volunteer@example.com', VALID_TOKEN);
    mockValidateLink.mockReturnValue({ status: ResultStatus.SUCCESS, data: VALID_LINK });
    mockFindEventById.mockReturnValue(null);

    const result = serverGetVolunteerDriveToken(vsession);
    expect(result['error']).toBeDefined();
    expect(result['error']).toContain('evt-uuid-001');
  });

  it('returns error when club folder creation fails', () => {
    const vsession = createVolunteerSession('volunteer@example.com', VALID_TOKEN);
    mockValidateLink.mockReturnValue({ status: ResultStatus.SUCCESS, data: VALID_LINK });
    mockFindEventById.mockReturnValue(VALID_EVENT);
    mockGetOrCreateClubFolder.mockReturnValue({
      status: ResultStatus.ERROR,
      message: 'Drive API error',
    });

    const result = serverGetVolunteerDriveToken(vsession);
    expect(result['error']).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// serverCompleteVolunteerUpload
// ═════════════════════════════════════════════════════════════════════════════

describe('serverCompleteVolunteerUpload()', () => {
  const basePayload = {
    vsession:          '',       // set per test
    batchFolderId:     'batch-folder-id',
    batchFolderName:   '20260422-120000_volunteerexample.com',
    linkId:            'link-uuid-001',
    fileCount:         12,
    totalSizeMb:       45.3,
    skippedDuplicates: 1,
    skippedNonMedia:   0,
  };

  it('returns ok:true and receipt data on success', () => {
    const vsession = createVolunteerSession('volunteer@example.com', VALID_TOKEN);
    mockValidateLink.mockReturnValue({ status: ResultStatus.SUCCESS, data: VALID_LINK });
    mockFindEventById.mockReturnValue(VALID_EVENT);
    mockAppendUploadLog.mockReturnValue({ status: ResultStatus.SUCCESS });
    mockAppendAuditLog.mockReturnValue(undefined);
    mockEnqueueBatchSync.mockReturnValue(undefined);

    const result = serverCompleteVolunteerUpload({ ...basePayload, vsession });

    expect(result['ok']).toBe(true);
    expect(result['receiptData']).toBeDefined();
    const receipt = result['receiptData'] as Record<string, unknown>;
    expect(receipt['fileCount']).toBe(12);
    expect(receipt['eventName']).toBe('NYC Marathon');
    expect(receipt['clubName']).toBe('New_Bee');
  });

  it('writes upload log on success', () => {
    const vsession = createVolunteerSession('volunteer@example.com', VALID_TOKEN);
    mockValidateLink.mockReturnValue({ status: ResultStatus.SUCCESS, data: VALID_LINK });
    mockFindEventById.mockReturnValue(VALID_EVENT);
    mockAppendUploadLog.mockReturnValue({ status: ResultStatus.SUCCESS });
    mockEnqueueBatchSync.mockReturnValue(undefined);

    serverCompleteVolunteerUpload({ ...basePayload, vsession });

    expect(mockAppendUploadLog).toHaveBeenCalledTimes(1);
    expect(mockAppendUploadLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId:   'evt-uuid-001',
        clubName:  'New_Bee',
        uploadedBy: 'volunteer@example.com',
        fileCount: 12,
        linkId:    'link-uuid-001',
      })
    );
  });

  it('writes audit log on success', () => {
    const vsession = createVolunteerSession('volunteer@example.com', VALID_TOKEN);
    mockValidateLink.mockReturnValue({ status: ResultStatus.SUCCESS, data: VALID_LINK });
    mockFindEventById.mockReturnValue(VALID_EVENT);
    mockAppendUploadLog.mockReturnValue({ status: ResultStatus.SUCCESS });
    mockEnqueueBatchSync.mockReturnValue(undefined);

    serverCompleteVolunteerUpload({ ...basePayload, vsession });

    expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorEmail: 'volunteer@example.com',
        action:     'UPLOAD_COMPLETED',
        linkId:     'link-uuid-001',
      })
    );
  });

  it('enqueues a sync job on success', () => {
    const vsession = createVolunteerSession('volunteer@example.com', VALID_TOKEN);
    mockValidateLink.mockReturnValue({ status: ResultStatus.SUCCESS, data: VALID_LINK });
    mockFindEventById.mockReturnValue(VALID_EVENT);
    mockAppendUploadLog.mockReturnValue({ status: ResultStatus.SUCCESS });
    mockEnqueueBatchSync.mockReturnValue(undefined);

    serverCompleteVolunteerUpload({ ...basePayload, vsession });

    expect(mockEnqueueBatchSync).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt-uuid-001', clubName: 'New_Bee' })
    );
  });

  it('returns error when vsession is expired', () => {
    const result = serverCompleteVolunteerUpload({ ...basePayload, vsession: 'bad-session' });
    expect(result['error']).toBeDefined();
    expect(mockAppendUploadLog).not.toHaveBeenCalled();
    expect(mockEnqueueBatchSync).not.toHaveBeenCalled();
  });

  it('returns error when link has been revoked mid-session', () => {
    const vsession = createVolunteerSession('volunteer@example.com', VALID_TOKEN);
    mockValidateLink.mockReturnValue({
      status: ResultStatus.ERROR,
      message: 'This link has been revoked.',
    });

    const result = serverCompleteVolunteerUpload({ ...basePayload, vsession });
    expect(result['error']).toBeDefined();
    expect(mockAppendUploadLog).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// createVolunteerSession / lookupVolunteerSession
// ═════════════════════════════════════════════════════════════════════════════

describe('createVolunteerSession() / lookupVolunteerSession()', () => {
  it('round-trips email and linkToken', () => {
    const vsession = createVolunteerSession('tester@example.com', 'my-link-token');
    const data = lookupVolunteerSession(vsession);

    expect(data).not.toBeNull();
    expect(data!.email).toBe('tester@example.com');
    expect(data!.linkToken).toBe('my-link-token');
  });

  it('returns null for an unknown vsession', () => {
    expect(lookupVolunteerSession('does-not-exist')).toBeNull();
  });

  it('returns null for an admin session (non-volunteer role)', () => {
    // Create an admin session with the standard createSession function
    // (which writes role='super_admin', not 'volunteer:...')
    const { createSession } = jest.requireActual('../../src/services/sessionService') as typeof import('../../src/services/sessionService');
    const adminSession = createSession('admin@example.com', 'super_admin');

    // lookupVolunteerSession should refuse to treat it as a volunteer session
    expect(lookupVolunteerSession(adminSession)).toBeNull();
  });

  it('returns null after cache is cleared (session expired)', () => {
    const vsession = createVolunteerSession('tester@example.com', 'my-link-token');
    resetMockCache(); // simulates TTL expiration
    expect(lookupVolunteerSession(vsession)).toBeNull();
  });
});
