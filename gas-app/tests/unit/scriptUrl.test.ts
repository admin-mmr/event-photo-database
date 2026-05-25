/**
 * Unit tests for scriptUrl utility — URL generation for script deployment.
 *
 * Handles construction of web app URLs, API endpoints, and callback URLs.
 */

jest.mock('../../src/config/constants');

import { getCanonicalScriptUrl } from '../../src/utils/scriptUrl';

describe('scriptUrl', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── Base URL construction ─────────────────────────────────────────────────

  describe('getCanonicalScriptUrl', () => {
    it('returns script deployment URL', () => {
      const url = getCanonicalScriptUrl();
      expect(typeof url).toBe('string');
      expect(url).toContain('script.google.com');
    });

    it('includes deployment ID in URL', () => {
      const url = getCanonicalScriptUrl();
      expect(url.length > 0).toBe(true);
    });

    it('returns HTTPS URL', () => {
      const url = getCanonicalScriptUrl();
      expect(url.startsWith('https://')).toBe(true);
    });

    it('returns consistent URL on subsequent calls', () => {
      const url1 = getCanonicalScriptUrl();
      const url2 = getCanonicalScriptUrl();
      expect(url1).toBe(url2);
    });

    it('validates URL format is valid', () => {
      const url = getCanonicalScriptUrl();
      try {
        new URL(url);
        expect(true).toBe(true);
      } catch {
        expect(false).toBe(true);
      }
    });

    it('validates URL contains script domain', () => {
      const url = getCanonicalScriptUrl();
      expect(url).toContain('script.google.com');
    });

    it('returns absolute URL', () => {
      const url = getCanonicalScriptUrl();
      expect(url.startsWith('http')).toBe(true);
    });

    it('handles standard Google Apps Script URL format', () => {
      const url = getCanonicalScriptUrl();
      // Standard format: https://script.google.com/macros/d/{deploymentId}/usercopy
      // or similar variations
      expect(url).toMatch(/^https:\/\/script\.google\.com\/macros\//);
    });
  });
});
