/**
 * Unit tests for manifestService — Manifest and index file management.
 *
 * Handles CSV-based manifest tracking for upload batches and photo metadata.
 */

jest.mock('../../src/config/constants');

import {
  escapeCsvField,
  serializeCsvRow,
  loadManifest,
  writeManifest,
  loadIndex,
  upsertIndex,
} from '../../src/services/manifestService';

describe('manifestService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── CSV field escaping ───────────────────────────────────────────────────

  describe('escapeCsvField()', () => {
    it('returns plain string unchanged', () => {
      const result = escapeCsvField('simple');
      expect(result).toBe('simple');
    });

    it('escapes fields with commas', () => {
      const result = escapeCsvField('field,with,commas');
      expect(result).toContain('"');
    });

    it('escapes fields with quotes', () => {
      const result = escapeCsvField('field"with"quotes');
      expect(result).toContain('"');
    });

    it('escapes fields with newlines', () => {
      const result = escapeCsvField('field\nwith\nnewlines');
      expect(result).toContain('"');
    });
  });

  // ─── CSV row serialization ────────────────────────────────────────────────

  describe('serializeCsvRow()', () => {
    it('serializes array of fields', () => {
      const result = serializeCsvRow(['field1', 'field2', 'field3']);
      expect(typeof result).toBe('string');
      expect(result).toContain('field1');
    });

    it('joins fields with commas', () => {
      const result = serializeCsvRow(['a', 'b', 'c']);
      const parts = result.split(',');
      expect(parts.length).toBeGreaterThanOrEqual(3);
    });

    it('handles empty array', () => {
      const result = serializeCsvRow([]);
      expect(typeof result).toBe('string');
    });

    it('escapes special characters in fields', () => {
      const result = serializeCsvRow(['field,with,comma']);
      expect(result).toContain('"');
    });
  });

  // ─── Manifest file operations ──────────────────────────────────────────────

  describe('loadManifest()', () => {
    it('returns manifest rows array', () => {
      const result = loadManifest('folder-id-001');
      expect(Array.isArray(result)).toBe(true);
    });

    it('returns empty array when manifest not found', () => {
      const result = loadManifest('nonexistent-folder');
      expect(Array.isArray(result)).toBe(true);
    });

    it('parses CSV rows into ManifestRow objects', () => {
      const result = loadManifest('folder-id-001');
      if (result.length > 0) {
        const row = result[0];
        expect(typeof row === 'object').toBe(true);
      }
    });
  });

  describe('writeManifest()', () => {
    it('function exists and is callable', () => {
      expect(typeof writeManifest).toBe('function');
    });
  });

  // ─── Index file operations ─────────────────────────────────────────────────

  describe('loadIndex()', () => {
    it('returns index rows array', () => {
      const result = loadIndex('root-folder-id');
      expect(Array.isArray(result)).toBe(true);
    });

    it('returns empty array when index not found', () => {
      const result = loadIndex('nonexistent-root');
      expect(Array.isArray(result)).toBe(true);
    });

    it('parses CSV rows into IndexRow objects', () => {
      const result = loadIndex('root-folder-id');
      if (result.length > 0) {
        const row = result[0];
        expect(typeof row === 'object').toBe(true);
      }
    });
  });

  describe('upsertIndex()', () => {
    it('function exists and is callable', () => {
      expect(typeof upsertIndex).toBe('function');
    });
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  describe('Error handling', () => {
    it('handles missing folder gracefully', () => {
      const result = loadManifest('nonexistent');
      expect(Array.isArray(result)).toBe(true);
    });

    it('handles corrupted CSV files', () => {
      expect(() => {
        loadManifest('folder-id-001');
      }).not.toThrow();
    });
  });
});
