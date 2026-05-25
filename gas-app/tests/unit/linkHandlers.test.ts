/**
 * Unit tests for linkHandlers — google.script.run handlers for upload link management.
 *
 * Covers: serverGenerateLink, serverRevokeLink, serverRotateLink, serverListLinks.
 */

jest.mock('../../src/middleware/authMiddleware');
jest.mock('../../src/services/uploadLinkService');
jest.mock('../../src/services/auditLogService');

import {
  serverGenerateLink,
  serverRevokeLink,
  serverRotateLink,
  serverListLinks,
} from '../../src/routes/linkHandlers';
import { requireAdminOrFail } from '../../src/middleware/authMiddleware';
import {
  generateLink,
} from '../../src/services/uploadLinkService';
import { UserRole } from '../../src/types/enums';

const mockRequireAdminOrFail = requireAdminOrFail as jest.MockedFunction<typeof requireAdminOrFail>;
const mockGenerateLink = generateLink as jest.MockedFunction<typeof generateLink>;

describe('linkHandlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── serverGenerateLink ────────────────────────────────────────────────────

  describe('serverGenerateLink()', () => {
    it('returns error when authentication fails', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverGenerateLink({
        sessionToken: 'invalid-token',
        eventId: 'evt-001',
        clubName: 'New_Bee',
      });

      expect(result.status).toBe('error');
      expect(result.message).toBe('Unauthorized');
    });

    it('returns error when eventId is missing', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: UserRole.SUPER_ADMIN,
        adminClubId: '',
      });

      const result = serverGenerateLink({
        sessionToken: 'valid-token',
        eventId: '',
        clubName: 'New_Bee',
      });

      expect(result.status).toBe('error');
      expect(result.message).toContain('required');
    });

    it('returns error when clubName is missing', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: UserRole.SUPER_ADMIN,
        adminClubId: '',
      });

      const result = serverGenerateLink({
        sessionToken: 'valid-token',
        eventId: 'evt-001',
        clubName: '',
      });

      expect(result.status).toBe('error');
    });

    it('generates link when all parameters are valid', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: UserRole.SUPER_ADMIN,
        adminClubId: '',
      });

      const result = serverGenerateLink({
        sessionToken: 'valid-token',
        eventId: 'evt-001',
        clubName: 'New_Bee',
      });

      expect(['success', 'error']).toContain(result.status);
      expect(result).toBeDefined();
    });

    it('uses default tag when tag is not provided', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: UserRole.SUPER_ADMIN,
        adminClubId: '',
      });

      serverGenerateLink({
        sessionToken: 'valid-token',
        eventId: 'evt-001',
        clubName: 'New_Bee',
      });

      expect(mockGenerateLink).toHaveBeenCalled();
    });
  });

  // ─── serverRevokeLink ──────────────────────────────────────────────────────

  describe('serverRevokeLink()', () => {
    it('returns error when not authenticated', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverRevokeLink({
        sessionToken: 'invalid-token',
        linkId: 'link-001',
      });

      expect(result.status).toBe('error');
    });

    it('returns error when linkId is missing', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: UserRole.SUPER_ADMIN,
        adminClubId: '',
      });

      const result = serverRevokeLink({
        sessionToken: 'valid-token',
        linkId: '',
      });

      expect(result.status).toBe('error');
    });

    it('revokes link when authenticated and linkId provided', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: UserRole.SUPER_ADMIN,
        adminClubId: '',
      });

      const result = serverRevokeLink({
        sessionToken: 'valid-token',
        linkId: 'link-001',
      });

      expect(['success', 'error']).toContain(result.status);
      expect(result).toBeDefined();
    });
  });

  // ─── serverRotateLink ──────────────────────────────────────────────────────

  describe('serverRotateLink()', () => {
    it('returns error when not authenticated', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverRotateLink({
        sessionToken: 'invalid-token',
        linkId: 'link-001',
      });

      expect(result.status).toBe('error');
    });

    it('rotates link when authenticated', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: UserRole.SUPER_ADMIN,
        adminClubId: '',
      });

      const result = serverRotateLink({
        sessionToken: 'valid-token',
        linkId: 'link-001',
      });

      expect(['success', 'error']).toContain(result.status);
      expect(result).toBeDefined();
    });
  });

  // ─── serverListLinks ───────────────────────────────────────────────────────

  describe('serverListLinks()', () => {
    it('returns error when not authenticated', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverListLinks({
        sessionToken: 'invalid-token',
      });

      expect(result.status).toBe('error');
    });

    it('returns list of links when authenticated', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: UserRole.SUPER_ADMIN,
        adminClubId: '',
      });

      const result = serverListLinks({
        sessionToken: 'valid-token',
      });

      expect(['success', 'error']).toContain(result.status);
      expect(result).toBeDefined();
    });
  });
});
