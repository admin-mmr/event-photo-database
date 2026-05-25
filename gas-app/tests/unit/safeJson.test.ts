/**
 * Unit tests for safeJsonForScript.
 *
 * These cover the three failure modes the helper exists to prevent:
 *   • literal "</script>" inside a value closing the surrounding tag
 *   • U+2028 (LINE SEPARATOR) inside a string crashing the JS parser
 *   • U+2029 (PARAGRAPH SEPARATOR) ditto
 *
 * Plus the "happy path": output must round-trip through JSON.parse to the
 * original value so callers can swap in the helper without changing the
 * client-side parse logic.
 *
 * The test source file uses '\uXXXX' string escapes (not literal code
 * points) so the file contains no invisible control characters of its own.
 */

import { safeJsonForScript } from '../../src/utils/safeJson';

const U2028 = '\u2028';
const U2029 = '\u2029';

describe('safeJsonForScript', () => {
  it('round-trips primitive values through JSON.parse', () => {
    expect(JSON.parse(safeJsonForScript(null))).toBeNull();
    expect(JSON.parse(safeJsonForScript('hello'))).toBe('hello');
    expect(JSON.parse(safeJsonForScript(42))).toBe(42);
    expect(JSON.parse(safeJsonForScript(true))).toBe(true);
  });

  it('round-trips arrays and objects through JSON.parse', () => {
    const obj = {
      a: 1,
      b: 'two',
      c: [3, 4, { d: 'five' }],
      e: { nested: { deep: true } },
    };
    expect(JSON.parse(safeJsonForScript(obj))).toEqual(obj);
  });

  it('escapes the "<" character so "</script>" cannot close the tag', () => {
    const out = safeJsonForScript({ msg: 'oops </script><script>alert(1)</script>' });
    // No raw "<" left in the output.
    expect(out).not.toContain('<');
    // The escape sequence is present.
    expect(out).toContain('\\u003c');
    // It still parses back to the original string.
    expect(JSON.parse(out)).toEqual({
      msg: 'oops </script><script>alert(1)</script>',
    });
  });

  it("escapes U+2028 LINE SEPARATOR so JS won't see a line break", () => {
    const out = safeJsonForScript({ msg: `line1${U2028}line2` });
    expect(out).not.toContain(U2028);
    expect(out).toContain('\\u2028');
    expect(JSON.parse(out)).toEqual({ msg: `line1${U2028}line2` });
  });

  it("escapes U+2029 PARAGRAPH SEPARATOR so JS won't see a line break", () => {
    const out = safeJsonForScript({ msg: `para1${U2029}para2` });
    expect(out).not.toContain(U2029);
    expect(out).toContain('\\u2029');
    expect(JSON.parse(out)).toEqual({ msg: `para1${U2029}para2` });
  });

  it('handles all three problem characters at once', () => {
    const value = {
      a: '</script>',
      b: U2028,
      c: U2029,
      d: 'plain',
    };
    const out = safeJsonForScript(value);
    expect(out).not.toContain('<');
    expect(out).not.toContain(U2028);
    expect(out).not.toContain(U2029);
    // Survives the round-trip with original characters intact.
    expect(JSON.parse(out)).toEqual(value);
  });

  it('produces output that is itself a valid JavaScript literal', () => {
    // The whole point of the helper is producing a string that survives
    // being inlined as `<script>var x = <output>;</script>`. Use
    // new Function() to evaluate the string in a clean scope, which is
    // the same parser path the browser uses for inline scripts.
    const value = {
      audit:      'see </script> for details',
      copyPasted: `line1${U2028}line2${U2029}line3`,
      n:          42,
    };
    const out = safeJsonForScript(value);
    const fn = new Function(`return ${out};`);
    expect(fn()).toEqual(value);
  });

  it('does not over-escape — normal strings stay readable', () => {
    const out = safeJsonForScript({ name: 'Boston Marathon', year: 2026 });
    // Sanity: the unrelated characters round-trip unmodified.
    expect(out).toContain('Boston Marathon');
    expect(out).toContain('2026');
  });
});
