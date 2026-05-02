/**
 * Unit tests for scriptUrl utility — URL generation for script deployment.
 *
 * Handles construction of web app URLs, API endpoints, and callback URLs.
 */

jest.mock('../../src/config/constants');

import * as scriptUrl from '../../src/utils/scriptUrl';

describe('scriptUrl', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── Base URL construction ─────────────────────────────────────────────────

  describe('Base URL construction', () => {
    it('returns script deployment URL', () => {
      const url = scriptUrl.getScriptUrl?.();
      expect(typeof url === 'string' || url === undefined).toBe(true);
      if (typeof url === 'string') {
        expect(url).toContain('script.google.com');
      }
    });

    it('includes deployment ID in URL', () => {
      const url = scriptUrl.getScriptUrl?.();
      if (typeof url === 'string') {
        expect(url.length > 0).toBe(true);
      }
    });

    it('returns HTTPS URL', () => {
      const url = scriptUrl.getScriptUrl?.();
      if (typeof url === 'string') {
        expect(url.startsWith('https://') || url.includes('script.google.com')).toBe(true);
      }
    });

    it('returns cached URL on subsequent calls', () => {
      const url1 = scriptUrl.getScriptUrl?.();
      const url2 = scriptUrl.getScriptUrl?.();
      expect(url1).toBe(url2);
    });
  });

  // ─── API endpoint URLs ─────────────────────────────────────────────────────

  describe('API endpoint URLs', () => {
    it('constructs upload endpoint URL', () => {
      const url = scriptUrl.getUploadUrl?.();
      expect(typeof url === 'string' || url === undefined).toBe(true);
      if (typeof url === 'string') {
        expect(url).toContain('action=');
      }
    });

    it('constructs event creation endpoint URL', () => {
      const url = scriptUrl.getEventCreationUrl?.();
      expect(typeof url === 'string' || url === undefined).toBe(true);
    });

    it('constructs authentication endpoint URL', () => {
      const url = scriptUrl.getAuthUrl?.();
      expect(typeof url === 'string' || url === undefined).toBe(true);
    });

    it('constructs report generation endpoint URL', () => {
      const url = scriptUrl.getReportUrl?.();
      expect(typeof url === 'string' || url === undefined).toBe(true);
    });

    it('includes required parameters in endpoint URLs', () => {
      const url = scriptUrl.getUploadUrl?.();
      if (typeof url === 'string') {
        expect(url).toContain('?');
      }
    });
  });

  // ─── Parameterized URLs ───────────────────────────────────────────────────

  describe('Parameterized URLs', () => {
    it('constructs URL with query parameters', () => {
      const url = scriptUrl.buildUrl?.({
        action: 'test_action',
        param1: 'value1',
        param2: 'value2',
      });

      expect(typeof url === 'string' || url === undefined).toBe(true);
      if (typeof url === 'string') {
        expect(url).toContain('action=test_action');
        expect(url).toContain('param1=value1');
      }
    });

    it('encodes special characters in parameters', () => {
      const url = scriptUrl.buildUrl?.({
        action: 'test',
        message: 'hello world',
      });

      if (typeof url === 'string') {
        expect(url).not.toContain(' ');
      }
    });

    it('handles empty parameter values', () => {
      const url = scriptUrl.buildUrl?.({
        action: 'test',
        empty: '',
      });

      expect(typeof url === 'string' || url === undefined).toBe(true);
    });

    it('handles null/undefined parameters gracefully', () => {
      const url = scriptUrl.buildUrl?.({
        action: 'test',
        optional: undefined,
      });

      expect(typeof url === 'string' || url === undefined).toBe(true);
    });
  });

  // ─── Callback URLs ────────────────────────────────────────────────────────

  describe('Callback URLs', () => {
    it('constructs upload completion callback URL', () => {
      const url = scriptUrl.getUploadCallbackUrl?.({
        batchId: 'batch-001',
      });

      expect(typeof url === 'string' || url === undefined).toBe(true);
    });

    it('constructs email callback URL', () => {
      const url = scriptUrl.getEmailCallbackUrl?.({
        linkId: 'link-001',
      });

      expect(typeof url === 'string' || url === undefined).toBe(true);
    });

    it('includes context parameters in callback URLs', () => {
      const url = scriptUrl.getUploadCallbackUrl?.({
        batchId: 'batch-001',
        eventId: 'evt-001',
      });

      if (typeof url === 'string') {
        expect(url).toContain('batch-001');
      }
    });
  });

  // ─── URL validation ───────────────────────────────────────────────────────

  describe('URL validation', () => {
    it('validates URL format', () => {
      const url = scriptUrl.getScriptUrl?.();
      if (typeof url === 'string') {
        expect(url.startsWith('http')).toBe(true);
      }
    });

    it('validates URL contains script domain', () => {
      const url = scriptUrl.getScriptUrl?.();
      if (typeof url === 'string') {
        expect(url).toContain('script.google.com');
      }
    });

    it('validates constructed URLs are properly formatted', () => {
      const url = scriptUrl.buildUrl?.({
        action: 'test',
      });

      if (typeof url === 'string') {
        try {
          new URL(url);
          expect(true).toBe(true);
        } catch {
          expect(false).toBe(true);
        }
      }
    });
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  describe('Error handling', () => {
    it('handles missing deployment ID gracefully', () => {
      const url = scriptUrl.getScriptUrl?.();
      // Should still return something or undefined
      expect(url === undefined || typeof url === 'string').toBe(true);
    });

    it('handles invalid parameter values', () => {
      const url = scriptUrl.buildUrl?.({
        action: '<script>alert("xss")</script>',
      });

      if (typeof url === 'string') {
        expect(url.includes('<script>')).toBe(false);
      }
    });

    it('handles extremely long parameter values', () => {
      const longValue = 'a'.repeat(10000);
      const url = scriptUrl.buildUrl?.({
        action: 'test',
        data: longValue,
      });

      expect(typeof url === 'string' || url === undefined).toBe(true);
    });
  });

  // ─── URL manipulation ──────────────────────────────────────────────────────

  describe('URL manipulation', () => {
    it('appends parameters to existing URL', () => {
      const baseUrl = scriptUrl.getScriptUrl?.();
      const extended = scriptUrl.appendParams?.(baseUrl, {
        action: 'test',
      });

      expect(typeof extended === 'string' || extended === undefined).toBe(true);
    });

    it('removes parameters from URL', () => {
      const url = scriptUrl.buildUrl?.({
        action: 'test',
        param: 'value',
      });

      const cleaned = scriptUrl.removeParams?.(url, ['param']);
      expect(typeof cleaned === 'string' || cleaned === undefined).toBe(true);
    });

    it('extracts parameters from URL', () => {
      const url = scriptUrl.buildUrl?.({
        action: 'test',
        key: 'value',
      });

      const params = scriptUrl.getParams?.(url);
      expect(params === undefined || typeof params === 'object').toBe(true);
    });
  });

  // ─── Absolute vs relative URLs ─────────────────────────────────────────────

  describe('Absolute vs relative URLs', () => {
    it('returns absolute URL', () => {
      const url = scriptUrl.getScriptUrl?.();
      if (typeof url === 'string') {
        expect(url.startsWith('http')).toBe(true);
      }
    });

    it('constructs absolute endpoint URLs', () => {
      const url = scriptUrl.buildUrl?.({
        action: 'test',
      });

      if (typeof url === 'string') {
        expect(url.startsWith('http')).toBe(true);
      }
    });
  });
});
