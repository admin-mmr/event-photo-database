import {
  validateEventName,
  validateTagName,
  DRIVE_ILLEGAL_CHARS_REGEX,
  MAX_EVENT_NAME_LENGTH,
  MAX_TAG_NAME_LENGTH,
} from '../../src/utils/userNameValidator';

describe('userNameValidator', () => {
  // ─── validateEventName ──────────────────────────────────────────────────────

  describe('validateEventName()', () => {
    // Happy paths — ASCII

    it('accepts a single English word', () => {
      const r = validateEventName('Marathon');
      expect(r.isValid).toBe(true);
      expect(r.errors).toEqual([]);
      expect(r.trimmed).toBe('Marathon');
    });

    it('accepts multi-word English names with spaces', () => {
      const r = validateEventName('NYC Half Marathon');
      expect(r.isValid).toBe(true);
    });

    it('accepts names with embedded digits', () => {
      const r = validateEventName('Run4Fun 2026');
      expect(r.isValid).toBe(true);
    });

    it('trims leading and trailing whitespace', () => {
      const r = validateEventName('  Boston Marathon  ');
      expect(r.isValid).toBe(true);
      expect(r.trimmed).toBe('Boston Marathon');
    });

    // Happy paths — Unicode (CJK)

    it('accepts a Chinese event name', () => {
      const r = validateEventName('湘舍动公益跑');
      expect(r.isValid).toBe(true);
      expect(r.trimmed).toBe('湘舍动公益跑');
    });

    it('accepts a Chinese name with spaces between words', () => {
      const r = validateEventName('湘舍动 公益跑');
      expect(r.isValid).toBe(true);
    });

    it('accepts a mixed Chinese-English event name', () => {
      const r = validateEventName('NYC 马拉松 2026');
      expect(r.isValid).toBe(true);
    });

    it('accepts a Japanese event name', () => {
      const r = validateEventName('東京マラソン');
      expect(r.isValid).toBe(true);
    });

    it('accepts accented Latin characters', () => {
      const r = validateEventName('Carrera de Año Nuevo');
      expect(r.isValid).toBe(true);
    });

    // Failure paths — empty / whitespace

    it('rejects an empty string', () => {
      const r = validateEventName('');
      expect(r.isValid).toBe(false);
      expect(r.errors[0]).toMatch(/required/i);
    });

    it('rejects whitespace-only input', () => {
      const r = validateEventName('     ');
      expect(r.isValid).toBe(false);
      expect(r.errors[0]).toMatch(/required/i);
    });

    it('rejects non-string input', () => {
      const r = validateEventName(undefined);
      expect(r.isValid).toBe(false);
      const r2 = validateEventName(42);
      expect(r2.isValid).toBe(false);
      const r3 = validateEventName(null);
      expect(r3.isValid).toBe(false);
    });

    // Failure paths — Drive-illegal characters

    it.each([
      ['/',  'NYC/Marathon'],
      ['\\', 'NYC\\Marathon'],
      [':',  'NYC: Marathon'],
      ['*',  'NYC*Marathon'],
      ['?',  'NYC?Marathon'],
      ['"',  'NYC"Marathon"'],
      ['<',  'NYC<Marathon'],
      ['>',  'NYC>Marathon'],
      ['|',  'NYC|Marathon'],
    ])('rejects Drive-illegal character %s', (illegalChar, name) => {
      const r = validateEventName(name);
      expect(r.isValid).toBe(false);
      expect(r.errors[0]).toContain(`"${illegalChar}"`);
    });

    // Failure paths — other punctuation

    it('rejects names with hyphens', () => {
      const r = validateEventName('Half-Marathon');
      expect(r.isValid).toBe(false);
      expect(r.errors[0]).toContain('"-"');
    });

    it('rejects names with underscores (user must type spaces)', () => {
      const r = validateEventName('Half_Marathon');
      expect(r.isValid).toBe(false);
      expect(r.errors[0]).toContain('"_"');
    });

    it('rejects names with exclamation marks', () => {
      const r = validateEventName('Marathon!');
      expect(r.isValid).toBe(false);
      expect(r.errors[0]).toContain('"!"');
    });

    it('rejects names with @ symbol', () => {
      const r = validateEventName('Marathon @ NYC');
      expect(r.isValid).toBe(false);
      expect(r.errors[0]).toContain('"@"');
    });

    it('lists every disallowed character once, sorted', () => {
      const r = validateEventName('A!B@C!D@');
      expect(r.isValid).toBe(false);
      expect(r.errors[0]).toContain('"!"');
      expect(r.errors[0]).toContain('"@"');
      // Each char appears exactly once in the message — no duplicates
      const exclamationOccurrences = (r.errors[0].match(/"!"/g) ?? []).length;
      expect(exclamationOccurrences).toBe(1);
    });

    // Failure paths — length

    it('rejects names over the max length', () => {
      const r = validateEventName('A'.repeat(MAX_EVENT_NAME_LENGTH + 1));
      expect(r.isValid).toBe(false);
      expect(r.errors[0]).toMatch(/100 characters or fewer/i);
    });

    it('accepts names exactly at the max length', () => {
      const r = validateEventName('A'.repeat(MAX_EVENT_NAME_LENGTH));
      expect(r.isValid).toBe(true);
    });

    it('counts CJK characters as one each (no surrogate pair surprises)', () => {
      // Each Chinese character is one code unit in JS string length.
      const name = '跑'.repeat(MAX_EVENT_NAME_LENGTH);
      const r = validateEventName(name);
      expect(r.isValid).toBe(true);
    });
  });

  // ─── validateTagName ────────────────────────────────────────────────────────

  describe('validateTagName()', () => {
    // Happy paths

    it('accepts a simple ASCII tag', () => {
      const r = validateTagName('finish_line');
      expect(r.isValid).toBe(true);
      expect(r.trimmed).toBe('finish_line');
    });

    it('accepts a tag with hyphens', () => {
      const r = validateTagName('mile-10');
      expect(r.isValid).toBe(true);
    });

    it('accepts a tag with mixed underscores and hyphens', () => {
      const r = validateTagName('finish_line-east');
      expect(r.isValid).toBe(true);
    });

    it('accepts a Chinese tag', () => {
      const r = validateTagName('终点线');
      expect(r.isValid).toBe(true);
    });

    it('accepts a mixed Chinese-English tag', () => {
      const r = validateTagName('mile_10_终点');
      expect(r.isValid).toBe(true);
    });

    it('accepts a numeric-only tag', () => {
      const r = validateTagName('10');
      expect(r.isValid).toBe(true);
    });

    it('trims leading and trailing whitespace', () => {
      const r = validateTagName('  finish_line  ');
      expect(r.isValid).toBe(true);
      expect(r.trimmed).toBe('finish_line');
    });

    // Failure paths — spaces inside

    it('rejects a tag with internal spaces', () => {
      const r = validateTagName('finish line');
      expect(r.isValid).toBe(false);
      expect(r.errors[0]).toContain('(space)');
    });

    // Failure paths — Drive-illegal characters

    it.each([
      ['/',  'finish/line'],
      ['\\', 'finish\\line'],
      [':',  'finish:line'],
      ['*',  'finish*line'],
      ['?',  'finish?line'],
      ['"',  'finish"line'],
      ['<',  'finish<line'],
      ['>',  'finish>line'],
      ['|',  'finish|line'],
    ])('rejects Drive-illegal character %s', (illegalChar, name) => {
      const r = validateTagName(name);
      expect(r.isValid).toBe(false);
      expect(r.errors[0]).toContain(`"${illegalChar}"`);
    });

    // Failure paths — other punctuation

    it('rejects @ symbol', () => {
      const r = validateTagName('finish@line');
      expect(r.isValid).toBe(false);
      expect(r.errors[0]).toContain('"@"');
    });

    it('rejects period (.)', () => {
      const r = validateTagName('finish.line');
      expect(r.isValid).toBe(false);
      expect(r.errors[0]).toContain('".');
    });

    // Failure paths — empty

    it('rejects an empty tag (callers should substitute DEFAULT_TAG)', () => {
      const r = validateTagName('');
      expect(r.isValid).toBe(false);
      expect(r.errors[0]).toMatch(/required/i);
    });

    it('rejects whitespace-only tag', () => {
      const r = validateTagName('   ');
      expect(r.isValid).toBe(false);
      expect(r.errors[0]).toMatch(/required/i);
    });

    // Failure paths — length

    it('rejects tags over 40 characters', () => {
      const r = validateTagName('a'.repeat(MAX_TAG_NAME_LENGTH + 1));
      expect(r.isValid).toBe(false);
      expect(r.errors[0]).toMatch(/40 characters or fewer/i);
    });

    it('accepts tags exactly at the max length', () => {
      const r = validateTagName('a'.repeat(MAX_TAG_NAME_LENGTH));
      expect(r.isValid).toBe(true);
    });
  });

  // ─── DRIVE_ILLEGAL_CHARS_REGEX ──────────────────────────────────────────────

  describe('DRIVE_ILLEGAL_CHARS_REGEX', () => {
    it.each(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])(
      'matches Drive-illegal character %s',
      (ch) => {
        expect(DRIVE_ILLEGAL_CHARS_REGEX.test(ch)).toBe(true);
      }
    );

    it('matches control characters (\\x00, \\x1f, \\x7f)', () => {
      expect(DRIVE_ILLEGAL_CHARS_REGEX.test('\x00')).toBe(true);
      expect(DRIVE_ILLEGAL_CHARS_REGEX.test('\x1f')).toBe(true);
      expect(DRIVE_ILLEGAL_CHARS_REGEX.test('\x7f')).toBe(true);
    });

    it('does NOT match safe characters', () => {
      for (const ch of ['A', 'z', '0', '9', ' ', '_', '-', '.', '湘', '马', 'ñ']) {
        expect(DRIVE_ILLEGAL_CHARS_REGEX.test(ch)).toBe(false);
      }
    });
  });
});
