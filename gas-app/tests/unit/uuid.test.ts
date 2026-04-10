import { generateUuid, isValidUuid } from '../../src/utils/uuid';
import { resetUuidCounter } from '../mocks/gasGlobals';

describe('uuid utils', () => {
  beforeEach(() => resetUuidCounter());

  describe('generateUuid()', () => {
    it('returns a non-empty string', () => {
      const id = generateUuid();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('returns a valid UUID v4 format', () => {
      const id = generateUuid();
      expect(isValidUuid(id)).toBe(true);
    });

    it('generates unique values on successive calls', () => {
      const ids = Array.from({ length: 10 }, () => generateUuid());
      const unique = new Set(ids);
      expect(unique.size).toBe(10);
    });
  });

  describe('isValidUuid()', () => {
    it('accepts a valid UUID v4', () => {
      expect(isValidUuid('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(true);
    });

    it('accepts the mock UUID format', () => {
      const id = generateUuid();
      expect(isValidUuid(id)).toBe(true);
    });

    it('rejects empty string', () => {
      expect(isValidUuid('')).toBe(false);
    });

    it('rejects UUID v3 (version digit is 3)', () => {
      expect(isValidUuid('a0eebc99-9c0b-3002-b527-0e02b2c3d479')).toBe(false);
    });

    it('rejects UUID with wrong variant digit', () => {
      // Variant should be 8, 9, a, or b — this uses 'c' which is invalid
      expect(isValidUuid('f47ac10b-58cc-4372-c567-0e02b2c3d479')).toBe(false);
    });

    it('rejects UUID with wrong number of segments', () => {
      expect(isValidUuid('f47ac10b-58cc-4372-a567')).toBe(false);
    });

    it('rejects UUID with non-hex characters', () => {
      expect(isValidUuid('f47ac10b-58cc-4372-a567-0e02b2c3g479')).toBe(false);
    });

    it('is case-insensitive', () => {
      expect(isValidUuid('F47AC10B-58CC-4372-A567-0E02B2C3D479')).toBe(true);
    });
  });
});
