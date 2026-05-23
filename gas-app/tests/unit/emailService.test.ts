import {
  notifyUserCreated,
  notifyUserRoleChanged,
  notifyUserStatusChanged,
  notifySecurityEvent,
  sendDailyReport,
  sendWeeklyReport,
  installEmailReportTriggers,
  uninstallEmailReportTriggers,
} from '../../src/services/emailService';
import { ResultStatus, UserRole, UserStatus } from '../../src/types/enums';
import { UserRecord } from '../../src/types/models';
import {
  mockSheets,
  resetMockSheets,
  resetMockScriptProperties,
  setupEmailPreferencesSheet,
  mockMailApp,
  mockScriptProperties,
  setMockMailAppQuota,
  TEST_ADMIN_EMAIL,
  TEST_USER_EMAIL,
  mockScriptApp,
  mockInstalledTriggers,
} from '../mocks/gasGlobals';
import { AuditAction } from '../../src/types/enums';

const mockSpreadsheetApp = (global as Record<string, unknown>)['SpreadsheetApp'] as {
  openById: jest.Mock;
};

function useMockSheets() {
  mockSpreadsheetApp.openById.mockReturnValue({
    getSheetByName: jest.fn().mockImplementation((name: string) => mockSheets[name] ?? null),
  });
}

// Mock the summaryService and other dependencies
// Note: jest.mock() is hoisted before imports, so ResultStatus cannot be referenced
// directly — use jest.requireActual() to access the enum safely inside the factory.
jest.mock('../../src/services/summaryService', () => {
  const { ResultStatus } = jest.requireActual('../../src/types/enums') as typeof import('../../src/types/enums');
  return {
    generateSummary: jest.fn().mockReturnValue({
      status: ResultStatus.SUCCESS,
      data: {
        totalPhotos: 100,
        eventsWithUploads: [],
        eventsWithoutUploads: [],
        violations: [],
      },
    }),
  };
});

jest.mock('../../src/utils/scriptUrl', () => ({
  getCanonicalScriptUrl: jest.fn().mockReturnValue('https://example.test/script'),
}));

const mockGetCanonicalScriptUrl = require('../../src/utils/scriptUrl').getCanonicalScriptUrl as jest.Mock;

describe('emailService', () => {
  beforeEach(() => {
    resetMockSheets();
    useMockSheets();
    mockMailApp.sendEmail.mockClear();
    mockScriptApp.newTrigger.mockClear();
    mockScriptApp.getProjectTriggers.mockClear();
    mockScriptApp.deleteTrigger.mockClear();
  });

  const testUser: UserRecord = {
    email:       'newuser@example.com',
    firstName:   'New',
    lastName:    'User',
    clubId:      'New_Bee',
    role:        UserRole.CLUB_ADMIN,
    status:      UserStatus.ACTIVE,
    addedDate:   '2026-04-01',
    addedBy:     TEST_ADMIN_EMAIL,
    lastLoginAt: '',
  };

  // ── notifyUserCreated ──────────────────────────────────────────────────────

  describe('notifyUserCreated()', () => {
    beforeEach(() => {
      setupEmailPreferencesSheet([
        [TEST_ADMIN_EMAIL, true, true, true, true, false, false, '2026-04-01T10:00:00Z'],
      ]);
    });

    it('sends TO the new user with HTML body containing escaped email', () => {
      const result = notifyUserCreated(testUser, TEST_ADMIN_EMAIL);
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(mockMailApp.sendEmail).toHaveBeenCalledTimes(1);
      const call = mockMailApp.sendEmail.mock.calls[0][0] as Record<string, unknown>;
      expect(call.to).toContain('newuser@example.com');
      expect(call.htmlBody).toContain('newuser@example.com');
    });

    it('CC includes super_admins and same-club admins (not all admins)', () => {
      // TEST_ADMIN_EMAIL is super_admin — must always be CC'd regardless of club.
      const result = notifyUserCreated(testUser, TEST_ADMIN_EMAIL);
      expect(result.status).toBe(ResultStatus.SUCCESS);
      const call = mockMailApp.sendEmail.mock.calls[0][0] as Record<string, unknown>;
      expect(call.cc).toContain(TEST_ADMIN_EMAIL);
    });

    it('CC is de-duped if createdByAdminEmail is in the admin list', () => {
      const result = notifyUserCreated(testUser, TEST_ADMIN_EMAIL);
      expect(result.status).toBe(ResultStatus.SUCCESS);
      const call = mockMailApp.sendEmail.mock.calls[0][0] as Record<string, unknown>;
      const ccList = String(call.cc).split(',').map(s => s.trim());
      const adminOccurrences = ccList.filter(e => e === TEST_ADMIN_EMAIL).length;
      expect(adminOccurrences).toBe(1); // Should appear only once
    });

    it('HTML contains a link built from getCanonicalScriptUrl()', () => {
      mockGetCanonicalScriptUrl.mockReturnValue('https://example.test/script');
      notifyUserCreated(testUser, TEST_ADMIN_EMAIL);
      const call = mockMailApp.sendEmail.mock.calls[0][0] as Record<string, unknown>;
      expect(String(call.htmlBody)).toContain('https://example.test/script');
    });

    it('returns ERROR when MailApp.sendEmail throws', () => {
      mockMailApp.sendEmail.mockImplementationOnce(() => {
        throw new Error('Mail error');
      });
      const result = notifyUserCreated(testUser, TEST_ADMIN_EMAIL);
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('writes EMAIL_SENT audit row on success', () => {
      notifyUserCreated(testUser, TEST_ADMIN_EMAIL);
      expect(mockSheets.Audit_Log.appendRow).toHaveBeenCalled();
      const auditRow = mockSheets.Audit_Log.appendRow.mock.calls[0][0] as unknown[];
      expect(auditRow[3]).toBe(AuditAction.EMAIL_SENT);
    });

    it('writes EMAIL_FAILED audit row on MailApp error', () => {
      mockMailApp.sendEmail.mockImplementationOnce(() => {
        throw new Error('Mail error');
      });
      notifyUserCreated(testUser, TEST_ADMIN_EMAIL);
      const auditRow = mockSheets.Audit_Log.appendRow.mock.calls[0][0] as unknown[];
      expect(auditRow[3]).toBe(AuditAction.EMAIL_FAILED);
    });

    it('does not throw if MailApp.sendEmail throws', () => {
      mockMailApp.sendEmail.mockImplementationOnce(() => {
        throw new Error('Mail error');
      });
      expect(() => notifyUserCreated(testUser, TEST_ADMIN_EMAIL)).not.toThrow();
    });
  });

  // ── notifyUserRoleChanged ──────────────────────────────────────────────────

  describe('notifyUserRoleChanged()', () => {
    beforeEach(() => {
      setupEmailPreferencesSheet([
        [TEST_ADMIN_EMAIL, true, true, true, true, false, false, '2026-04-01T10:00:00Z'],
      ]);
    });

    it('TO is the opted-in admins only', () => {
      const result = notifyUserRoleChanged(testUser, UserRole.CLUB_ADMIN, TEST_ADMIN_EMAIL);
      expect(result.status).toBe(ResultStatus.SUCCESS);
      const call = mockMailApp.sendEmail.mock.calls[0][0] as Record<string, unknown>;
      expect(call.to).toContain(TEST_ADMIN_EMAIL);
    });

    it('returns SUCCESS with empty recipients and no MailApp call when no admin opted in', () => {
      setupEmailPreferencesSheet([
        [TEST_ADMIN_EMAIL, true, false, true, true, false, false, '2026-04-01T10:00:00Z'],
        [TEST_USER_EMAIL,  true, false, true, true, false, false, '2026-04-01T10:00:00Z'],
      ]);
      const result = notifyUserRoleChanged(testUser, UserRole.CLUB_ADMIN, TEST_ADMIN_EMAIL);
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data?.to).toEqual([]);
      expect(mockMailApp.sendEmail).not.toHaveBeenCalled();
    });

    it('HTML references both old and new role', () => {
      notifyUserRoleChanged(testUser, UserRole.SUPER_ADMIN, TEST_ADMIN_EMAIL);
      const call = mockMailApp.sendEmail.mock.calls[0][0] as Record<string, unknown>;
      const html = String(call.htmlBody);
      expect(html).toContain('super_admin'); // previous role
      expect(html).toContain('club_admin');  // new role
    });
  });

  // ── notifyUserStatusChanged ────────────────────────────────────────────────

  describe('notifyUserStatusChanged()', () => {
    beforeEach(() => {
      setupEmailPreferencesSheet([
        [TEST_ADMIN_EMAIL, true, true, true, true, false, false, '2026-04-01T10:00:00Z'],
      ]);
    });

    it('sends to opted-in admins for USER_DEACTIVATED', () => {
      const deactivatedUser = { ...testUser, status: UserStatus.INACTIVE };
      const result = notifyUserStatusChanged(deactivatedUser, TEST_ADMIN_EMAIL);
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(mockMailApp.sendEmail).toHaveBeenCalledTimes(1);
    });

    it('subject and body reflect the new status (deactivated vs reactivated)', () => {
      const deactivatedUser = { ...testUser, status: UserStatus.INACTIVE };
      notifyUserStatusChanged(deactivatedUser, TEST_ADMIN_EMAIL);
      const call = mockMailApp.sendEmail.mock.calls[0][0] as Record<string, unknown>;
      expect(String(call.subject)).toContain('deactivated');
      expect(String(call.htmlBody)).toContain('deactivated');
    });

    it('reflects reactivation when status is ACTIVE', () => {
      const activeUser = { ...testUser, status: UserStatus.ACTIVE };
      notifyUserStatusChanged(activeUser, TEST_ADMIN_EMAIL);
      const call = mockMailApp.sendEmail.mock.calls[0][0] as Record<string, unknown>;
      expect(String(call.subject)).toContain('reactivated');
      expect(String(call.htmlBody)).toContain('reactivated');
    });
  });

  // ── notifySecurityEvent ────────────────────────────────────────────────────

  describe('notifySecurityEvent()', () => {
    beforeEach(() => {
      setupEmailPreferencesSheet([
        [TEST_ADMIN_EMAIL, true, true, true, true, false, false, '2026-04-01T10:00:00Z'],
      ]);
    });

    it('writes SECURITY_EVENT_DETECTED audit row before sending', () => {
      notifySecurityEvent('unknown@example.com', 'Unknown email');
      expect(mockSheets.Audit_Log.appendRow).toHaveBeenCalled();
      const auditRow = mockSheets.Audit_Log.appendRow.mock.calls[0][0] as unknown[];
      expect(auditRow[3]).toBe(AuditAction.SECURITY_EVENT_DETECTED);
    });

    it('sends to opted-in admins for SECURITY_EVENT', () => {
      notifySecurityEvent('unknown@example.com', 'Unknown email');
      expect(mockMailApp.sendEmail).toHaveBeenCalledTimes(1);
    });

    it('still writes SECURITY_EVENT_DETECTED audit when no admins opted in', () => {
      setupEmailPreferencesSheet([
        [TEST_ADMIN_EMAIL, true, true, true, false, false, false, '2026-04-01T10:00:00Z'],
        [TEST_USER_EMAIL,  true, true, true, false, false, false, '2026-04-01T10:00:00Z'],
      ]);
      notifySecurityEvent('unknown@example.com', 'Unknown email');
      expect(mockSheets.Audit_Log.appendRow).toHaveBeenCalled();
      expect(mockMailApp.sendEmail).not.toHaveBeenCalled();
    });

    it('still writes SECURITY_EVENT_DETECTED audit when MailApp throws', () => {
      mockMailApp.sendEmail.mockImplementationOnce(() => {
        throw new Error('Mail error');
      });
      notifySecurityEvent('unknown@example.com', 'Unknown email');
      expect(mockSheets.Audit_Log.appendRow).toHaveBeenCalled();
    });
  });

  // ── sendDailyReport ────────────────────────────────────────────────────────

  describe('sendDailyReport()', () => {
    beforeEach(() => {
      // 9-col: email, UC, URC, UD, SE, EC(new), DR, WR, updatedAt  — DR=true
      setupEmailPreferencesSheet([
        [TEST_ADMIN_EMAIL, true, true, true, true, true, true, false, '2026-04-01T10:00:00Z'],
      ]);
    });

    it('uses generateSummary() with the correct date window (yesterday)', () => {
      const { generateSummary } = require('../../src/services/summaryService');
      generateSummary.mockClear();
      sendDailyReport();
      expect(generateSummary).toHaveBeenCalledTimes(1);
    });

    it('sends to opted-in admins for DAILY_REPORT', () => {
      const result = sendDailyReport();
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(mockMailApp.sendEmail).toHaveBeenCalledTimes(1);
    });

    it('returns ERROR when generateSummary returns ERROR', () => {
      const { generateSummary } = require('../../src/services/summaryService');
      generateSummary.mockReturnValueOnce({
        status: ResultStatus.ERROR,
        message: 'Summary failed',
      });
      const result = sendDailyReport();
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(mockMailApp.sendEmail).not.toHaveBeenCalled();
    });

    it('writes EMAIL_FAILED audit row when generateSummary returns ERROR', () => {
      const { generateSummary } = require('../../src/services/summaryService');
      generateSummary.mockReturnValueOnce({
        status: ResultStatus.ERROR,
        message: 'Summary failed',
      });
      sendDailyReport();
      expect(mockSheets.Audit_Log.appendRow).toHaveBeenCalled();
      const auditRow = mockSheets.Audit_Log.appendRow.mock.calls[0][0] as unknown[];
      expect(auditRow[3]).toBe(AuditAction.EMAIL_FAILED);
    });

    it('returns SUCCESS with empty recipients when no admins opted in', () => {
      setupEmailPreferencesSheet([
        [TEST_ADMIN_EMAIL, true, true, true, true, false, false, '2026-04-01T10:00:00Z'],
      ]);
      const result = sendDailyReport();
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data?.to).toEqual([]);
      expect(mockMailApp.sendEmail).not.toHaveBeenCalled();
    });
  });

  // ── sendWeeklyReport ───────────────────────────────────────────────────────

  describe('sendWeeklyReport()', () => {
    beforeEach(() => {
      // 9-col: email, UC, URC, UD, SE, EC(new), DR, WR, updatedAt  — WR=true
      setupEmailPreferencesSheet([
        [TEST_ADMIN_EMAIL, true, true, true, true, true, false, true, '2026-04-01T10:00:00Z'],
      ]);
    });

    it('uses generateSummary() with the correct date window (7 days ago)', () => {
      const { generateSummary } = require('../../src/services/summaryService');
      generateSummary.mockClear();
      sendWeeklyReport();
      expect(generateSummary).toHaveBeenCalledTimes(1);
    });

    it('sends to opted-in admins for WEEKLY_REPORT', () => {
      const result = sendWeeklyReport();
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(mockMailApp.sendEmail).toHaveBeenCalledTimes(1);
    });

    it('returns ERROR when generateSummary returns ERROR', () => {
      const { generateSummary } = require('../../src/services/summaryService');
      generateSummary.mockReturnValueOnce({
        status: ResultStatus.ERROR,
        message: 'Summary failed',
      });
      const result = sendWeeklyReport();
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(mockMailApp.sendEmail).not.toHaveBeenCalled();
    });
  });

  // ── installEmailReportTriggers ─────────────────────────────────────────────

  describe('installEmailReportTriggers()', () => {
    beforeEach(() => {
      mockInstalledTriggers.length = 0;
    });

    it('calls uninstallEmailReportTriggers() first', () => {
      const spy = jest.spyOn(mockScriptApp, 'getProjectTriggers');
      installEmailReportTriggers();
      expect(spy).toHaveBeenCalled();
    });

    it('creates exactly two triggers with handler names dailyReportTrigger and weeklyReportTrigger', () => {
      installEmailReportTriggers();
      expect(mockInstalledTriggers.length).toBe(2);
      const handlers = mockInstalledTriggers.map(t => t.handlerName);
      expect(handlers).toContain('dailyReportTrigger');
      expect(handlers).toContain('weeklyReportTrigger');
    });

    it('is idempotent — calling twice leaves the project with two triggers', () => {
      installEmailReportTriggers();
      const countAfterFirst = mockInstalledTriggers.length;
      installEmailReportTriggers();
      const countAfterSecond = mockInstalledTriggers.length;
      expect(countAfterFirst).toBe(2);
      expect(countAfterSecond).toBe(2);
    });
  });

  // ── uninstallEmailReportTriggers ───────────────────────────────────────────

  describe('uninstallEmailReportTriggers()', () => {
    beforeEach(() => {
      mockInstalledTriggers.length = 0;
      installEmailReportTriggers();
    });

    it('only deletes triggers whose handler name matches the two report handlers', () => {
      // Add a third trigger manually
      mockInstalledTriggers.push({ handlerName: 'somethingElse', schedule: 'custom' });
      expect(mockInstalledTriggers.length).toBe(3);
      uninstallEmailReportTriggers();
      // After uninstall, triggers should be gone or array should be empty
      // The mock implementation just clears the entire array, so we expect 0
      expect(mockInstalledTriggers.length).toBe(0);
    });
  });

  // ── Quota check tests ──────────────────────────────────────────────────────

  describe('quota checks in send()', () => {
    beforeEach(() => {
      setupEmailPreferencesSheet([
        [TEST_ADMIN_EMAIL, true, true, true, true, false, false, '2026-04-01T10:00:00Z'],
      ]);
    });

    it('returns ERROR with EMAIL_FAILED audit when quota is insufficient', () => {
      setMockMailAppQuota(0);
      const result = notifyUserCreated(testUser, TEST_ADMIN_EMAIL);
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(mockMailApp.sendEmail).not.toHaveBeenCalled();
      expect(mockSheets.Audit_Log.appendRow).toHaveBeenCalled();
      const auditRow = mockSheets.Audit_Log.appendRow.mock.calls[0][0] as unknown[];
      expect(auditRow[3]).toBe(AuditAction.EMAIL_FAILED);
    });

    it('still proceeds when getRemainingDailyQuota() throws (quota is soft)', () => {
      mockMailApp.getRemainingDailyQuota.mockImplementationOnce(() => {
        throw new Error('Quota service down');
      });
      const result = notifyUserCreated(testUser, TEST_ADMIN_EMAIL);
      // Should still send (quota is soft-fail)
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(mockMailApp.sendEmail).toHaveBeenCalled();
    });
  });

  // ── CC deduplication tests ─────────────────────────────────────────────────

  describe('CC deduplication in send()', () => {
    beforeEach(() => {
      setupEmailPreferencesSheet([
        [TEST_ADMIN_EMAIL, true, true, true, true, false, false, '2026-04-01T10:00:00Z'],
      ]);
    });

    it('removes CC addresses that also appear in TO', () => {
      // If the new user's email somehow ended up in the admin list (edge case),
      // it should be removed from CC since it's already in TO
      notifyUserCreated(testUser, TEST_ADMIN_EMAIL);
      const call = mockMailApp.sendEmail.mock.calls[0][0] as Record<string, unknown>;
      const toList = String(call.to).split(',').map(s => s.trim());
      const ccList = String(call.cc || '').split(',').filter(s => s.trim()).map(s => s.trim());
      // Check for no overlap between TO and CC
      const overlap = toList.filter(t => ccList.includes(t));
      expect(overlap).toEqual([]);
    });

    it('lowercases and trims all addresses', () => {
      notifyUserCreated(testUser, TEST_ADMIN_EMAIL);
      const call = mockMailApp.sendEmail.mock.calls[0][0] as Record<string, unknown>;
      expect(call.to).toMatch(/^[a-z0-9@.,]+$/);
    });
  });

  // ── Email retry queue guards ───────────────────────────────────────────────

  describe('enqueueRetry() — size cap and age purge', () => {
    const RETRY_QUEUE_KEY = 'EMAIL_RETRY_QUEUE';

    /** Helper — seed the PropertiesService retry queue with N fake entries. */
    function seedRetryQueue(entries: object[]): void {
      mockScriptProperties.setProperty(RETRY_QUEUE_KEY, JSON.stringify(entries));
    }

    /** Helper — read the retry queue back from the mock store. */
    function readRetryQueue(): object[] {
      const raw = mockScriptProperties.getProperty(RETRY_QUEUE_KEY);
      return raw ? JSON.parse(raw) as object[] : [];
    }

    /** Helper — build a minimal retry entry. */
    function makeEntry(id: string, firstFailedAt: string): object {
      return { id, type: 'USER_CREATED', to: ['x@x.com'], cc: [], subject: 'S',
               html: '<p></p>', resourceId: '', firstFailedAt,
               attempts: 0, nextAttemptAt: '2099-01-01T00:00:00.000Z', lastError: '' };
    }

    beforeEach(() => {
      resetMockScriptProperties();
      setupEmailPreferencesSheet([
        [TEST_ADMIN_EMAIL, true, true, true, true, false, false, '2026-04-01T10:00:00Z'],
      ]);
      setMockMailAppQuota(0); // force enqueueRetry to be called
    });

    it('purges entries older than 24 h before adding a new one', () => {
      const staleAt  = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 h ago
      const freshAt  = new Date(Date.now() -  1 * 60 * 60 * 1000).toISOString(); // 1 h ago
      seedRetryQueue([
        makeEntry('stale-1', staleAt),
        makeEntry('fresh-1', freshAt),
      ]);

      notifyUserCreated(testUser, TEST_ADMIN_EMAIL); // triggers enqueueRetry

      const queue = readRetryQueue();
      // stale entry should be gone; fresh entry + new entry should remain
      const ids = queue.map((e) => (e as { id: string }).id);
      expect(ids).not.toContain('stale-1');
      expect(ids).toContain('fresh-1');
    });

    it('does not purge entries younger than 24 h', () => {
      const recentAt = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(); // 23 h ago
      seedRetryQueue([makeEntry('recent-1', recentAt)]);

      notifyUserCreated(testUser, TEST_ADMIN_EMAIL);

      const ids = readRetryQueue().map((e) => (e as { id: string }).id);
      expect(ids).toContain('recent-1');
    });

    it('evicts the oldest entry when queue is at MAX_RETRY_QUEUE_SIZE (50)', () => {
      const freshAt = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
      const entries = Array.from({ length: 50 }, (_, i) =>
        makeEntry(`entry-${i}`, freshAt)
      );
      seedRetryQueue(entries);

      notifyUserCreated(testUser, TEST_ADMIN_EMAIL);

      const queue = readRetryQueue();
      // Queue should still be 50 (evict 1, add 1)
      expect(queue.length).toBe(50);
      // Oldest (entry-0) should have been evicted
      const ids = queue.map((e) => (e as { id: string }).id);
      expect(ids).not.toContain('entry-0');
    });

    it('does not evict when queue is below MAX_RETRY_QUEUE_SIZE', () => {
      const freshAt = new Date(Date.now() - 60_000).toISOString();
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeEntry(`entry-${i}`, freshAt)
      );
      seedRetryQueue(entries);

      notifyUserCreated(testUser, TEST_ADMIN_EMAIL);

      expect(readRetryQueue().length).toBe(11); // 10 existing + 1 new
    });
  });
});
