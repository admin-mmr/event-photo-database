/**
 * Unit tests for photosHandlers — google.script.run handlers for photo management.
 */

jest.mock('../../src/middleware/authMiddleware');
jest.mock('../../src/services/photosService');
jest.mock('../../src/services/auditLogService');

import {
  serverListPhotos,
  serverGetPhoto,
  serverDeletePhoto,
  serverRestorePhoto,
  serverBulkDeletePhotos,
  serverEditPhotoMetadata,
  serverDownloadPhoto,
} from '../../src/routes/photosHandlers';
import { requireAdminOrFail, authenticateRequest } from '../../src/middleware/authMiddleware';
import { ResultStatus } from '../../src/types/enums';

const mockRequireAdminOrFail = requireAdminOrFail as jest.MockedFunction<typeof requireAdminOrFail>;
const mockAuthenticateRequest = authenticateRequest as jest.MockedFunction<typeof authenticateRequest>;

describe('photosHandlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── serverListPhotos ──────────────────────────────────────────────────────

  describe('serverListPhotos()', () => {
    it('returns error when not authenticated', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverListPhotos({
        sessionToken: 'invalid-token',
        eventId: 'evt-001',
      });

      expect(result.status).toBe('error');
    });

    it('requires eventId parameter', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverListPhotos({
        sessionToken: 'valid-token',
        eventId: '',
      });

      expect(result.status).toBe('error');
    });

    it('returns list of photos when authenticated and eventId provided', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverListPhotos({
        sessionToken: 'valid-token',
        eventId: 'evt-001',
      });

      expect(result).toBeDefined();
    });
  });

  // ─── serverGetPhoto ────────────────────────────────────────────────────────

  describe('serverGetPhoto()', () => {
    it('requires photoId parameter', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverGetPhoto({
        sessionToken: 'valid-token',
        photoId: '',
      });

      expect(result.status).toBe('error');
    });
  });

  // ─── serverDeletePhoto ────────────────────────────────────────────────────

  describe('serverDeletePhoto()', () => {
    it('returns error when not authenticated', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverDeletePhoto({
        sessionToken: 'invalid-token',
        photoId: 'photo-001',
      });

      expect(result.status).toBe('error');
    });

    it('returns error when photoId is missing', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverDeletePhoto({
        sessionToken: 'valid-token',
        photoId: '',
      });

      expect(result.status).toBe('error');
    });
  });

  // ─── serverRestorePhoto ────────────────────────────────────────────────────

  describe('serverRestorePhoto()', () => {
    it('requires admin authentication', () => {
      mockRequireAdminOrFail.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverRestorePhoto({
        sessionToken: 'invalid-token',
        photoId: 'photo-001',
      });

      expect(result.status).toBe('error');
    });
  });

  // ─── serverBulkDeletePhotos ────────────────────────────────────────────────

  describe('serverBulkDeletePhotos()', () => {
    it('requires array of photoIds', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverBulkDeletePhotos({
        sessionToken: 'valid-token',
        photoIds: [],
      });

      expect(result.status).toBe('error');
    });

    it('accepts multiple photo IDs', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverBulkDeletePhotos({
        sessionToken: 'valid-token',
        photoIds: ['photo-001', 'photo-002', 'photo-003'],
      });

      expect(result).toBeDefined();
    });
  });

  // ─── serverEditPhotoMetadata ───────────────────────────────────────────────

  describe('serverEditPhotoMetadata()', () => {
    it('returns error when not authenticated', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverEditPhotoMetadata({
        sessionToken: 'invalid-token',
        photoId: 'photo-001',
      });

      expect(result.status).toBe('error');
    });

    it('requires photoId parameter', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverEditPhotoMetadata({
        sessionToken: 'valid-token',
        photoId: '',
      });

      expect(result.status).toBe('error');
    });
  });

  // ─── serverDownloadPhoto ───────────────────────────────────────────────────

  describe('serverDownloadPhoto()', () => {
    it('requires photoId parameter', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverDownloadPhoto({
        sessionToken: 'valid-token',
        photoId: '',
      });

      expect(result.status).toBe('error');
    });
  });
});
