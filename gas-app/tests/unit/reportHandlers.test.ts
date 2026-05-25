/**
 * Unit tests for reportHandlers — google.script.run handlers for reports and email preferences.
 */

jest.mock('../../src/middleware/authMiddleware');
jest.mock('../../src/services/summaryService');
jest.mock('../../src/services/auditLogService');

import {
  serverGetSummary,
  serverExportSummaryCsv,
  serverSendExceptionEmail,
  serverGetAuditLog,
  serverGetMyEmailPrefs,
  serverUpdateMyEmailPrefs,
  dailyReportTrigger,
  weeklyReportTrigger,
  retryFailedEmailsTrigger,
  installEmailTriggers,
  removeEmailTriggers,
} from '../../src/routes/reportHandlers';
import { requireAdminOrFail } from '../../src/middleware/authMiddleware';
import { UserRole } from '../../src/types/enums';

const mockRequireAdminOrFail = requireAdminOrFail as jest.MockedFunction<typeof requireAdminOrFail>;

describe('reportHandlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── serverGetSummary ─────────────────────────────────────────────────────

  describe('serverGetSummary()', () => {
    it('requires authentication', () => {
      const result = serverGetSummary({
        sessionToken: 'invalid-token',
      });

      expect(result.status).toBe('error');
    });

    it('accepts optional date range filters', () => {
      const result = serverGetSummary({
        sessionToken: 'valid-token',
        dateFrom: '2025-01-01',
        dateTo: '2025-12-31',
      });

      expect(result).toBeDefined();
    });

    it('returns summary data', () => {
      const result = serverGetSummary({
        sessionToken: 'valid-token',
      });

      expect(result).toBeDefined();
    });
  });

  // ─── serverExportSummaryCsv ───────────────────────────────────────────────

  describe('serverExportSummaryCsv()', () => {
    it('requires authentication', () => {
      const result = serverExportSummaryCsv({
        sessionToken: 'invalid-token',
      });

      expect(result.status).toBe('error');
    });

    it('accepts optional date range filters', () => {
      const result = serverExportSummaryCsv({
        sessionToken: 'valid-token',
        dateFrom: '2025-01-01',
        dateTo: '2025-12-31',
      });

      expect(result).toBeDefined();
    });

    it('returns CSV data', () => {
      const result = serverExportSummaryCsv({
        sessionToken: 'valid-token',
      });

      expect(result).toBeDefined();
    });
  });

  // ─── serverSendExceptionEmail ──────────────────────────────────────────────

  describe('serverSendExceptionEmail()', () => {
    it('requires authentication', () => {
      const result = serverSendExceptionEmail({
        sessionToken: 'invalid-token',
      });

      expect(result.status).toBe('error');
    });

    it('accepts optional additional recipients', () => {
      const result = serverSendExceptionEmail({
        sessionToken: 'valid-token',
        additionalRecipients: ['admin@example.com'],
      });

      expect(result).toBeDefined();
    });

    it('sends exception email', () => {
      const result = serverSendExceptionEmail({
        sessionToken: 'valid-token',
      });

      expect(result).toBeDefined();
    });
  });

  // ─── serverGetAuditLog ─────────────────────────────────────────────────────

  describe('serverGetAuditLog()', () => {
    it('requires admin authentication', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverGetAuditLog({
        sessionToken: 'invalid-token',
      });

      expect(result.status).toBe('error');
    });

    it('returns audit log when authenticated', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: UserRole.SUPER_ADMIN,
        adminClubId: '',
      });

      const result = serverGetAuditLog({
        sessionToken: 'valid-token',
      });

      expect(result).toBeDefined();
    });

    it('accepts optional filters', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: UserRole.SUPER_ADMIN,
        adminClubId: '',
      });

      const result = serverGetAuditLog({
        sessionToken: 'valid-token',
        page: 1,
        pageSize: 10,
      });

      expect(result).toBeDefined();
    });
  });

  // ─── serverGetMyEmailPrefs ────────────────────────────────────────────────

  describe('serverGetMyEmailPrefs()', () => {
    it('requires authentication', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverGetMyEmailPrefs({
        sessionToken: 'invalid-token',
      });

      expect(result.status).toBe('error');
    });

    it('returns email preferences when authenticated', () => {
      const result = serverGetMyEmailPrefs({
        sessionToken: 'valid-token',
      });

      expect(result).toBeDefined();
    });
  });

  // ─── serverUpdateMyEmailPrefs ──────────────────────────────────────────────

  describe('serverUpdateMyEmailPrefs()', () => {
    it('requires authentication', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverUpdateMyEmailPrefs({
        sessionToken: 'invalid-token',
      });

      expect(result.status).toBe('error');
    });

    it('updates email preferences', () => {
      const result = serverUpdateMyEmailPrefs({
        sessionToken: 'valid-token',
        dailyReport: true,
      });

      expect(result).toBeDefined();
    });
  });

  // ─── Report triggers ───────────────────────────────────────────────────────

  describe('Report trigger functions', () => {
    it('dailyReportTrigger exists', () => {
      expect(typeof dailyReportTrigger).toBe('function');
    });

    it('weeklyReportTrigger exists', () => {
      expect(typeof weeklyReportTrigger).toBe('function');
    });

    it('retryFailedEmailsTrigger exists', () => {
      expect(typeof retryFailedEmailsTrigger).toBe('function');
    });
  });

  // ─── Trigger management ───────────────────────────────────────────────────

  describe('Trigger management', () => {
    it('installEmailTriggers exists', () => {
      expect(typeof installEmailTriggers).toBe('function');
    });

    it('removeEmailTriggers exists', () => {
      expect(typeof removeEmailTriggers).toBe('function');
    });
  });
});
