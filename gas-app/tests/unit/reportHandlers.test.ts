/**
 * Unit tests for reportHandlers — google.script.run handlers for report generation.
 */

jest.mock('../../src/middleware/authMiddleware');
jest.mock('../../src/services/summaryService');
jest.mock('../../src/services/auditLogService');

import {
  serverGenerateEventReport,
  serverGenerateClubReport,
  serverGenerateAuditReport,
  serverDownloadReport,
} from '../../src/routes/reportHandlers';
import { requireAdminOrFail } from '../../src/middleware/authMiddleware';

const mockRequireAdminOrFail = requireAdminOrFail as jest.MockedFunction<typeof requireAdminOrFail>;

describe('reportHandlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── serverGenerateEventReport ─────────────────────────────────────────────

  describe('serverGenerateEventReport()', () => {
    it('returns error when not authenticated as admin', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverGenerateEventReport({
        sessionToken: 'invalid-token',
        eventId: 'evt-001',
      });

      expect(result.status).toBe('error');
      expect(result.message).toBe('Unauthorized');
    });

    it('requires eventId parameter', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: 'super_admin',
        adminClubId: '',
      });

      const result = serverGenerateEventReport({
        sessionToken: 'valid-token',
        eventId: '',
      });

      expect(result.status).toBe('error');
      expect(result.message).toContain('required');
    });

    it('generates report when authenticated and eventId provided', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: 'super_admin',
        adminClubId: '',
      });

      const result = serverGenerateEventReport({
        sessionToken: 'valid-token',
        eventId: 'evt-001',
      });

      expect(result).toBeDefined();
    });
  });

  // ─── serverGenerateClubReport ──────────────────────────────────────────────

  describe('serverGenerateClubReport()', () => {
    it('returns error when not authenticated as admin', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverGenerateClubReport({
        sessionToken: 'invalid-token',
        clubId: 'club-001',
      });

      expect(result.status).toBe('error');
    });

    it('requires clubId parameter', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: 'super_admin',
        adminClubId: '',
      });

      const result = serverGenerateClubReport({
        sessionToken: 'valid-token',
        clubId: '',
      });

      expect(result.status).toBe('error');
    });

    it('generates report when authenticated and clubId provided', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: 'super_admin',
        adminClubId: '',
      });

      const result = serverGenerateClubReport({
        sessionToken: 'valid-token',
        clubId: 'club-001',
      });

      expect(result).toBeDefined();
    });
  });

  // ─── serverGenerateAuditReport ────────────────────────────────────────────

  describe('serverGenerateAuditReport()', () => {
    it('returns error when not authenticated as admin', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverGenerateAuditReport({
        sessionToken: 'invalid-token',
      });

      expect(result.status).toBe('error');
    });

    it('generates audit report when authenticated', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: 'super_admin',
        adminClubId: '',
      });

      const result = serverGenerateAuditReport({
        sessionToken: 'valid-token',
      });

      expect(result).toBeDefined();
    });

    it('accepts optional date range filters', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: 'super_admin',
        adminClubId: '',
      });

      const result = serverGenerateAuditReport({
        sessionToken: 'valid-token',
        startDate: '2025-01-01',
        endDate: '2025-12-31',
      });

      expect(result).toBeDefined();
    });
  });

  // ─── serverDownloadReport ──────────────────────────────────────────────────

  describe('serverDownloadReport()', () => {
    it('requires reportId parameter', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: 'super_admin',
        adminClubId: '',
      });

      const result = serverDownloadReport({
        sessionToken: 'valid-token',
        reportId: '',
      });

      expect(result.status).toBe('error');
    });
  });
});
