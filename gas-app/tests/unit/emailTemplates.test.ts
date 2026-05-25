/**
 * Unit tests for emailTemplates — Email template utilities and helper functions.
 *
 * These tests verify that template helper functions work correctly.
 */

jest.mock('../../src/services/emailService');
jest.mock('../../src/config/constants');

import {
  PRODUCT_NAME,
  PRODUCT_NAME_EN,
  mainPageUrl,
  esc,
  wrapHtml,
  toPlainText,
} from '../../src/services/emailTemplates';

describe('emailTemplates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── Product name constants ───────────────────────────────────────────────

  describe('Product name constants', () => {
    it('exports Chinese product name', () => {
      expect(PRODUCT_NAME).toBeDefined();
      expect(typeof PRODUCT_NAME).toBe('string');
    });

    it('exports English product name', () => {
      expect(PRODUCT_NAME_EN).toBeDefined();
      expect(typeof PRODUCT_NAME_EN).toBe('string');
    });
  });

  // ─── URL generation ───────────────────────────────────────────────────────

  describe('mainPageUrl()', () => {
    it('returns main page URL with default action', () => {
      const url = mainPageUrl();
      expect(typeof url).toBe('string');
      expect(url).toContain('script.google.com');
    });

    it('returns URL with specified action', () => {
      const url = mainPageUrl('upload');
      expect(typeof url).toBe('string');
      expect(url).toContain('upload');
    });

    it('handles different action parameters', () => {
      const dashboard = mainPageUrl('dashboard');
      const settings = mainPageUrl('settings');
      expect(dashboard).toContain('dashboard');
      expect(settings).toContain('settings');
    });
  });

  // ─── HTML escaping ────────────────────────────────────────────────────────

  describe('esc()', () => {
    it('escapes HTML special characters', () => {
      const result = esc('<script>alert("XSS")</script>');
      expect(result).not.toContain('<');
      expect(result).not.toContain('>');
    });

    it('escapes ampersands', () => {
      const result = esc('fish & chips');
      expect(result).toContain('&amp;');
    });

    it('escapes quotes', () => {
      const result = esc('He said "hello"');
      expect(result.includes('&quot;') || result.includes('&#')).toBe(true);
    });

    it('handles numbers and booleans', () => {
      expect(esc(42)).toBeDefined();
      expect(esc(true)).toBeDefined();
    });

    it('handles null and undefined', () => {
      expect(esc(null)).toBeDefined();
      expect(esc(undefined)).toBeDefined();
    });
  });

  // ─── HTML wrapping ────────────────────────────────────────────────────────

  describe('wrapHtml()', () => {
    it('wraps content in HTML structure', () => {
      const result = wrapHtml('Hello World', 'Test Title');
      expect(typeof result).toBe('string');
      expect(result).toContain('Hello World');
    });

    it('includes title when provided', () => {
      const result = wrapHtml('content', 'My Title');
      expect(result).toContain('My Title');
    });

    it('handles content with HTML tags', () => {
      const result = wrapHtml('<p>Paragraph</p>', 'Title');
      expect(typeof result).toBe('string');
    });

    it('includes proper HTML structure', () => {
      const result = wrapHtml('test', 'title');
      expect(result.includes('<html') || result.includes('<!DOCTYPE')).toBe(true);
    });
  });

  // ─── Plain text conversion ────────────────────────────────────────────────

  describe('toPlainText()', () => {
    it('converts HTML to plain text', () => {
      const result = toPlainText('<p>Hello</p><p>World</p>');
      expect(result).toContain('Hello');
      expect(result).toContain('World');
    });

    it('removes HTML tags', () => {
      const result = toPlainText('<div><p>Test</p></div>');
      expect(result).not.toContain('<');
      expect(result).not.toContain('>');
    });

    it('handles line breaks', () => {
      const result = toPlainText('<p>Line 1</p><p>Line 2</p>');
      expect(typeof result).toBe('string');
      expect(result.length > 0).toBe(true);
    });

    it('handles bold and italic tags', () => {
      const result = toPlainText('<b>bold</b> and <i>italic</i>');
      expect(result).toContain('bold');
      expect(result).toContain('italic');
    });

    it('preserves text content', () => {
      const input = '<p>Important message</p>';
      const result = toPlainText(input);
      expect(result).toContain('Important message');
    });
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  describe('Error handling', () => {
    it('handles empty strings', () => {
      expect(esc('')).toBeDefined();
      expect(wrapHtml('', '')).toBeDefined();
      expect(toPlainText('')).toBeDefined();
    });

    it('handles very long strings', () => {
      const longString = 'a'.repeat(10000);
      expect(esc(longString)).toBeDefined();
    });

    it('handles malformed HTML', () => {
      expect(() => {
        toPlainText('<p>Unclosed paragraph');
      }).not.toThrow();
    });
  });
});
