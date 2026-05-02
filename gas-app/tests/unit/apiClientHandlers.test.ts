/**
 * Unit tests for apiClientHandlers — REST API handlers for deprecated api_key auth.
 *
 * The API key authentication method has been deprecated as part of Phase 1 redesign.
 * All machine-to-machine uploads now flow through upload links. These tests verify
 * that handlers gracefully return 410 Gone and document the deprecation.
 */

jest.mock('../../src/services/sheetService');
jest.mock('../../src/services/driveService');
jest.mock('../../src/services/uploadLogService');
jest.mock('../../src/config/constants');

import {
  handleApiCheckFolder,
  handleApiListFiles,
  handleApiUploadFile,
} from '../../src/routes/apiClientHandlers';
import { mockContentService } from '../mocks/gasGlobals';

describe('apiClientHandlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── Helper ───────────────────────────────────────────────────────────────

  function extractJsonBody(_output: GoogleAppsScript.Content.TextOutput): Record<string, unknown> {
    const calls = mockContentService.createTextOutput.mock.calls;
    const lastArg = calls[calls.length - 1][0] as string;
    return JSON.parse(lastArg) as Record<string, unknown>;
  }

  // ─── handleApiCheckFolder ─────────────────────────────────────────────────

  describe('handleApiCheckFolder()', () => {
    it('returns 410 Gone with deprecation message', () => {
      const result = handleApiCheckFolder({
        api_key: 'some-key',
        event_name: 'NYC Marathon',
      });
      const body = extractJsonBody(result);
      expect(body['status']).toBe('error');
      expect(body['code']).toBe(410);
      expect(body['message']).toContain('API key authentication method has been removed');
    });

    it('returns 410 Gone even with missing event_name', () => {
      const result = handleApiCheckFolder({
        api_key: 'some-key',
      });
      const body = extractJsonBody(result);
      expect(body['code']).toBe(410);
    });

    it('returns 410 Gone even with empty api_key', () => {
      const result = handleApiCheckFolder({
        event_name: 'NYC Marathon',
      });
      const body = extractJsonBody(result);
      expect(body['code']).toBe(410);
    });
  });

  // ─── handleApiListFiles ───────────────────────────────────────────────────

  describe('handleApiListFiles()', () => {
    it('returns 410 Gone with deprecation message', () => {
      const result = handleApiListFiles({
        api_key: 'some-key',
        folder_id: 'drive-folder-id-123',
      });
      const body = extractJsonBody(result);
      expect(body['status']).toBe('error');
      expect(body['code']).toBe(410);
      expect(body['message']).toContain('API key authentication method has been removed');
    });

    it('returns 410 Gone even with missing folder_id', () => {
      const result = handleApiListFiles({
        api_key: 'some-key',
      });
      const body = extractJsonBody(result);
      expect(body['code']).toBe(410);
    });
  });

  // ─── handleApiUploadFile ──────────────────────────────────────────────────

  describe('handleApiUploadFile()', () => {
    it('returns 410 Gone with deprecation message', () => {
      const result = handleApiUploadFile({
        api_key: 'some-key',
        event_name: 'NYC Marathon',
        club_name: 'New_Bee',
        file_name: 'photo.jpg',
        mime_type: 'image/jpeg',
        base64_data: 'base64content',
      });
      const body = extractJsonBody(result);
      expect(body['status']).toBe('error');
      expect(body['code']).toBe(410);
      expect(body['message']).toContain('API key authentication method has been removed');
    });

    it('returns 410 Gone even with partial payload', () => {
      const result = handleApiUploadFile({
        api_key: 'some-key',
      });
      const body = extractJsonBody(result);
      expect(body['code']).toBe(410);
    });

    it('returns 410 Gone with empty payload', () => {
      const result = handleApiUploadFile({});
      const body = extractJsonBody(result);
      expect(body['code']).toBe(410);
    });
  });
});
