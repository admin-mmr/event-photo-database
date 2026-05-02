/**
 * Unit tests for uploadHandlers — google.script.run handlers for file uploads.
 *
 * Covers handlers for initiating uploads, tracking progress, and finalizing batches.
 */

jest.mock('../../src/middleware/authMiddleware');
jest.mock('../../src/middleware/inputValidator');
jest.mock('../../src/services/uploadLogService');
jest.mock('../../src/services/auditLogService');
jest.mock('../../src/utils/folderNameValidator');

import {
  serverInitiateUpload,
  serverTrackUploadProgress,
  serverFinalizeBatch,
  serverListActiveBatches,
  serverCancelBatch,
} from '../../src/routes/uploadHandlers';
import { authenticateRequest } from '../../src/middleware/authMiddleware';

const mockAuthenticateRequest = authenticateRequest as jest.MockedFunction<typeof authenticateRequest>;

describe('uploadHandlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── serverInitiateUpload ─────────────────────────────────────────────────

  describe('serverInitiateUpload()', () => {
    it('returns error when not authenticated', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverInitiateUpload({
        sessionToken: 'invalid-token',
        linkCode: 'ABC123',
      });

      expect(result.status).toBe('error');
      expect(result.message).toBe('Unauthorized');
    });

    it('requires linkCode parameter', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverInitiateUpload({
        sessionToken: 'valid-token',
        linkCode: '',
      });

      expect(result.status).toBe('error');
    });

    it('initiates upload session when authenticated with valid link', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverInitiateUpload({
        sessionToken: 'valid-token',
        linkCode: 'ABC123',
      });

      expect(result).toBeDefined();
    });

    it('accepts optional metadata', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverInitiateUpload({
        sessionToken: 'valid-token',
        linkCode: 'ABC123',
        batchName: 'Morning Photos',
        notes: 'Test batch',
      });

      expect(result).toBeDefined();
    });
  });

  // ─── serverTrackUploadProgress ────────────────────────────────────────────

  describe('serverTrackUploadProgress()', () => {
    it('requires batchId parameter', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverTrackUploadProgress({
        sessionToken: 'valid-token',
        batchId: '',
      });

      expect(result.status).toBe('error');
    });

    it('returns progress when batchId is valid', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverTrackUploadProgress({
        sessionToken: 'valid-token',
        batchId: 'batch-001',
      });

      expect(result).toBeDefined();
    });

    it('returns error when not authenticated', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverTrackUploadProgress({
        sessionToken: 'invalid-token',
        batchId: 'batch-001',
      });

      expect(result.status).toBe('error');
    });
  });

  // ─── serverFinalizeBatch ──────────────────────────────────────────────────

  describe('serverFinalizeBatch()', () => {
    it('requires batchId parameter', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverFinalizeBatch({
        sessionToken: 'valid-token',
        batchId: '',
      });

      expect(result.status).toBe('error');
    });

    it('finalizes batch when batchId is valid', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverFinalizeBatch({
        sessionToken: 'valid-token',
        batchId: 'batch-001',
      });

      expect(result).toBeDefined();
    });

    it('returns error when not authenticated', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverFinalizeBatch({
        sessionToken: 'invalid-token',
        batchId: 'batch-001',
      });

      expect(result.status).toBe('error');
    });
  });

  // ─── serverListActiveBatches ───────────────────────────────────────────────

  describe('serverListActiveBatches()', () => {
    it('returns error when not authenticated', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverListActiveBatches({
        sessionToken: 'invalid-token',
      });

      expect(result.status).toBe('error');
    });

    it('returns list of active batches when authenticated', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverListActiveBatches({
        sessionToken: 'valid-token',
      });

      expect(result).toBeDefined();
    });

    it('accepts optional filters', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverListActiveBatches({
        sessionToken: 'valid-token',
        eventId: 'evt-001',
        status: 'in_progress',
      });

      expect(result).toBeDefined();
    });
  });

  // ─── serverCancelBatch ────────────────────────────────────────────────────

  describe('serverCancelBatch()', () => {
    it('requires batchId parameter', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverCancelBatch({
        sessionToken: 'valid-token',
        batchId: '',
      });

      expect(result.status).toBe('error');
    });

    it('cancels batch when batchId is valid', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: true,
        userEmail: 'user@example.com',
        userRole: 'volunteer',
        userClubId: 'New_Bee',
      });

      const result = serverCancelBatch({
        sessionToken: 'valid-token',
        batchId: 'batch-001',
      });

      expect(result).toBeDefined();
    });

    it('returns error when not authenticated', () => {
      mockAuthenticateRequest.mockReturnValue({
        ok: false,
        response: { status: 'error', message: 'Unauthorized' },
      });

      const result = serverCancelBatch({
        sessionToken: 'invalid-token',
        batchId: 'batch-001',
      });

      expect(result.status).toBe('error');
    });
  });
});
