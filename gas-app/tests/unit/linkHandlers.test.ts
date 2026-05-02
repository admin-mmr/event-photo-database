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
  revokeLink,
  rotateLink,
  listAll as listAllLinks,
} from '../../src/services/uploadLinkService';
import { ResultStatus } from '../../src/types/enums';

const mockRequireAdminOrFail = requireAdminOrFail as jest.MockedFunction<typeof requireAdminOrFail>;
const mockGenerateLink = generateLink as jest.MockedFunction<typeof generateLink>;
const mockRevokeLink = revokeLink as jest.MockedFunction<typeof revokeLink>;
const mockRotateLink = rotateLink as jest.MockedFunction<typeof rotateLink>;
const mockListAllLinks = listAllLinks as jest.MockedFunction<typeof listAllLinks>;

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
        adminRole: 'super_admin',
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
        adminRole: 'super_admin',
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
        adminRole: 'super_admin',
        adminClubId: '',
      });

      mockGenerateLink.mockReturnValue({
        status: ResultStatus.SUCCESS,
        data: {
          linkId: 'link-001',
          linkCode: 'ABC123',
          eventId: 'evt-001',
          clubName: 'New_Bee',
          expiresAt: '2025-06-01T00:00:00.000Z',
        },
      });

      const result = serverGenerateLink({
        sessionToken: 'valid-token',
        eventId: 'evt-001',
        clubName: 'New_Bee',
      });

      expect(result.status).toBe('success');
      expect(result.data?.linkCode).toBe('ABC123');
    });

    it('uses default tag when tag is not provided', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: true,
        adminEmail: 'admin@example.com',
        adminRole: 'super_admin',
        adminClubId: '',
      });

      mockGenerateLink.mockReturnValue({
        status: ResultStatus.SUCCESS,
        data: { linkId: 'link-001', linkCode: 'ABC123' },
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
        adminRole: 'super_admin',
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
        adminRole: 'super_admin',
        adminClubId: '',
      });

      mockRevokeLink.mockReturnValue({
        status: ResultStatus.SUCCESS,
        data: { linkId: 'link-001', status: 'revoked' },
      });

      const result = serverRevokeLink({
        sessionToken: 'valid-token',
        linkId: 'link-001',
      });

      expect(result.status).toBe('success');
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
        adminRole: 'super_admin',
        adminClubId: '',
      });

      mockRotateLink.mockReturnValue({
        status: ResultStatus.SUCCESS,
        data: {
          linkId: 'link-001',
          oldCode: 'ABC123',
          newCode: 'DEF456',
        },
      });

      const result = serverRotateLink({
        sessionToken: 'valid-token',
        linkId: 'link-001',
      });

      expect(result.status).toBe('success');
      expect(result.data?.newCode).toBe('DEF456');
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
        adminRole: 'super_admin',
        adminClubId: '',
      });

      mockListAllLinks.mockReturnValue({
        status: ResultStatus.SUCCESS,
        data: [
          {
            linkId: 'link-001',
            linkCode: 'ABC123',
            eventId: 'evt-001',
            status: 'active',
          },
        ],
      });

      const result = serverListLinks({
        sessionToken: 'valid-token',
      });

      expect(result.status).toBe('success');
      expect(Array.isArray(result.data)).toBe(true);
    });
  });
});
