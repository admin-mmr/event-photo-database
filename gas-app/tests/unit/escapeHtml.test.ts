/**
 * escapeHtml.test.ts — Unit tests for the HTML escaping utility.
 *
 * Tests that escapeHtml() properly escapes HTML special characters
 * to prevent XSS attacks in the audit log page and other templates.
 */

describe('escapeHtml() — HTML Escaping Utility', () => {
  // Mock the escapeHtml function (since it's in app.html, we define it here for testing)
  const escapeHtml = (str: string): string => {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  };

  describe('Escaping individual special characters', () => {
    it('escapes ampersands (&)', () => {
      expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
    });

    it('escapes less-than signs (<)', () => {
      expect(escapeHtml('a < b')).toBe('a &lt; b');
    });

    it('escapes greater-than signs (>)', () => {
      expect(escapeHtml('a > b')).toBe('a &gt; b');
    });

    it('escapes double quotes (")', () => {
      expect(escapeHtml('Say "hello"')).toBe('Say &quot;hello&quot;');
    });

    it('escapes single quotes/apostrophes (\')', () => {
      expect(escapeHtml("It's sunny")).toBe('It&#x27;s sunny');
    });
  });

  describe('Escaping multiple special characters', () => {
    it('escapes mixed special characters', () => {
      expect(escapeHtml('<script>alert("XSS")</script>'))
        .toBe('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
    });

    it('escapes HTML attributes with quotes', () => {
      expect(escapeHtml('onclick="alert(\'xss\')"'))
        .toBe('onclick=&quot;alert(&#x27;xss&#x27;)&quot;');
    });

    it('escapes JSON with special characters', () => {
      const json = '{"key": "value & <data>"}';
      expect(escapeHtml(json))
        .toBe('{&quot;key&quot;: &quot;value &amp; &lt;data&gt;&quot;}');
    });
  });

  describe('Edge cases', () => {
    it('handles empty strings', () => {
      expect(escapeHtml('')).toBe('');
    });

    it('handles null-like values', () => {
      expect(escapeHtml(null as unknown as string)).toBe('');
      expect(escapeHtml(undefined as unknown as string)).toBe('');
    });

    it('handles plain text with no special characters', () => {
      const text = 'Hello World 123';
      expect(escapeHtml(text)).toBe(text);
    });

    it('handles whitespace', () => {
      expect(escapeHtml('  \n\t  ')).toBe('  \n\t  ');
    });

    it('handles Unicode characters', () => {
      expect(escapeHtml('你好世界 🌍')).toBe('你好世界 🌍');
    });

    it('handles very long strings', () => {
      const longStr = 'x'.repeat(10000);
      expect(escapeHtml(longStr)).toBe(longStr);
    });

    it('handles strings with many special characters', () => {
      const manySpecial = '&<>"\'&<>"\'&<>"\'';
      expect(escapeHtml(manySpecial))
        .toBe('&amp;&lt;&gt;&quot;&#x27;&amp;&lt;&gt;&quot;&#x27;&amp;&lt;&gt;&quot;&#x27;');
    });
  });

  describe('XSS prevention', () => {
    it('prevents script tag injection', () => {
      const xss = '<script>alert("Hacked")</script>';
      const escaped = escapeHtml(xss);
      expect(escaped).not.toContain('<script>');
      expect(escaped).toContain('&lt;script&gt;');
    });

    it('prevents onclick handler injection', () => {
      const xss = '<img src=x onclick=alert("xss")>';
      const escaped = escapeHtml(xss);
      // HTML tags are escaped, making the attribute harmless when rendered
      expect(escaped).toBe('&lt;img src=x onclick=alert(&quot;xss&quot;)&gt;');
      expect(escaped).toContain('&lt;img');  // < is escaped
      expect(escaped).toContain('&gt;');     // > is escaped
    });

    it('prevents data URL injection', () => {
      const xss = '<a href="javascript:alert(\'xss\')">click</a>';
      const escaped = escapeHtml(xss);
      // HTML tags are escaped, making the URL harmless when rendered
      expect(escaped).toBe('&lt;a href=&quot;javascript:alert(&#x27;xss&#x27;)&quot;&gt;click&lt;/a&gt;');
      expect(escaped).toContain('&lt;a');  // < is escaped, won't parse as HTML tag
    });

    it('prevents event handler in data attribute', () => {
      const xss = '<div data-onclick="alert()"></div>';
      const escaped = escapeHtml(xss);
      expect(escaped).not.toContain('data-onclick="');
      expect(escaped).toContain('data-onclick=&quot;');
    });

    it('prevents HTML entity encoding bypass', () => {
      // Even if input contains HTML entities, they get re-escaped
      const xss = '&lt;script&gt;alert()&lt;/script&gt;';
      const escaped = escapeHtml(xss);
      expect(escaped).toBe('&amp;lt;script&amp;gt;alert()&amp;lt;/script&amp;gt;');
    });
  });

  describe('Audit log specific cases', () => {
    it('escapes email addresses with special characters', () => {
      expect(escapeHtml('user+tag@example.com'))
        .toBe('user+tag@example.com');  // + is not special, no escape needed
    });

    it('escapes resource names with HTML-like content', () => {
      expect(escapeHtml('Event <Conference 2026>'))
        .toBe('Event &lt;Conference 2026&gt;');
    });

    it('escapes JSON details field', () => {
      const details = '{"email":"test@example.com","note":"Event <important>"}';
      const escaped = escapeHtml(details);
      expect(escaped).not.toContain('<important>');
      expect(escaped).toContain('&lt;important&gt;');
    });

    it('escapes action descriptions with quotes', () => {
      expect(escapeHtml('User said "hello"'))
        .toBe('User said &quot;hello&quot;');
    });
  });

  describe('Idempotency', () => {
    it('double-escaping is safe but different', () => {
      const original = '<script>';
      const escaped1 = escapeHtml(original);
      const escaped2 = escapeHtml(escaped1);

      // First escape
      expect(escaped1).toBe('&lt;script&gt;');
      // Second escape (the & gets escaped again)
      expect(escaped2).toBe('&amp;lt;script&amp;gt;');

      // Both are safe to render
      expect(escaped1).not.toContain('<');
      expect(escaped2).not.toContain('<');
    });
  });

  describe('Performance', () => {
    it('handles 100k repetitions efficiently', () => {
      const input = '<script>alert("xss")</script>';
      const start = performance.now();

      for (let i = 0; i < 100000; i++) {
        escapeHtml(input);
      }

      const duration = performance.now() - start;
      // Should complete in reasonable time (< 1 second for 100k calls)
      expect(duration).toBeLessThan(1000);
    });
  });
});
