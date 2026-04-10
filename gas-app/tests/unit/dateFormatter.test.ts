import {
  toIsoDate,
  toBatchTimestamp,
  parseIsoDate,
  isValidIsoDate,
  folderDatePrefix,
  nowIsoTimestamp,
  todayIsoDate,
} from '../../src/utils/dateFormatter';

describe('dateFormatter utils', () => {
  describe('toIsoDate()', () => {
    it('formats a Date as YYYY-MM-DD', () => {
      const d = new Date(2025, 10, 3); // Nov 3, 2025 (local time)
      expect(toIsoDate(d)).toBe('2025-11-03');
    });

    it('zero-pads single-digit months and days', () => {
      const d = new Date(2025, 0, 5); // Jan 5
      expect(toIsoDate(d)).toBe('2025-01-05');
    });

    it('handles year boundaries correctly', () => {
      const d = new Date(2024, 11, 31); // Dec 31, 2024
      expect(toIsoDate(d)).toBe('2024-12-31');
    });
  });

  describe('toBatchTimestamp()', () => {
    it('formats a Date as YYYYMMDD-HHMMSS using UTC', () => {
      // UTC time: 2025-11-03T09:35:00Z
      const d = new Date('2025-11-03T09:35:00.000Z');
      expect(toBatchTimestamp(d)).toBe('20251103-093500');
    });

    it('zero-pads all fields', () => {
      const d = new Date('2025-01-05T02:03:04.000Z');
      expect(toBatchTimestamp(d)).toBe('20250105-020304');
    });

    it('produces a 15-character string (YYYYMMDD-HHMMSS)', () => {
      const ts = toBatchTimestamp(new Date());
      expect(ts).toHaveLength(15);
    });
  });

  describe('parseIsoDate()', () => {
    it('parses a valid YYYY-MM-DD string', () => {
      const d = parseIsoDate('2025-11-03');
      expect(d).not.toBeNull();
      expect(d!.getUTCFullYear()).toBe(2025);
      expect(d!.getUTCMonth()).toBe(10); // 0-based
      expect(d!.getUTCDate()).toBe(3);
    });

    it('returns null for wrong format', () => {
      expect(parseIsoDate('11/03/2025')).toBeNull();
      expect(parseIsoDate('20251103')).toBeNull();
      expect(parseIsoDate('')).toBeNull();
    });

    it('returns null for impossible dates', () => {
      expect(parseIsoDate('2025-02-30')).toBeNull();
      expect(parseIsoDate('2025-13-01')).toBeNull();
      expect(parseIsoDate('2025-00-15')).toBeNull();
    });

    it('handles Feb 28 on non-leap year', () => {
      expect(parseIsoDate('2025-02-28')).not.toBeNull();
    });

    it('handles Feb 29 on leap year', () => {
      expect(parseIsoDate('2024-02-29')).not.toBeNull();
    });

    it('rejects Feb 29 on non-leap year', () => {
      expect(parseIsoDate('2025-02-29')).toBeNull();
    });
  });

  describe('isValidIsoDate()', () => {
    it('returns true for valid ISO dates', () => {
      expect(isValidIsoDate('2025-01-01')).toBe(true);
      expect(isValidIsoDate('2025-12-31')).toBe(true);
      expect(isValidIsoDate('2024-02-29')).toBe(true);
    });

    it('returns false for invalid ISO dates', () => {
      expect(isValidIsoDate('2025-04-31')).toBe(false);
      expect(isValidIsoDate('not-a-date')).toBe(false);
      expect(isValidIsoDate('')).toBe(false);
    });
  });

  describe('folderDatePrefix()', () => {
    it('returns the same string for a valid date', () => {
      expect(folderDatePrefix('2025-11-03')).toBe('2025-11-03');
    });

    it('returns null for an invalid date', () => {
      expect(folderDatePrefix('2025-02-30')).toBeNull();
      expect(folderDatePrefix('bad')).toBeNull();
    });
  });

  describe('nowIsoTimestamp()', () => {
    it('returns a valid ISO 8601 timestamp string', () => {
      const ts = nowIsoTimestamp();
      expect(() => new Date(ts)).not.toThrow();
      expect(new Date(ts).toISOString()).toBe(ts);
    });
  });

  describe('todayIsoDate()', () => {
    it('returns a 10-character YYYY-MM-DD string', () => {
      const today = todayIsoDate();
      expect(today).toHaveLength(10);
      expect(isValidIsoDate(today)).toBe(true);
    });
  });
});
