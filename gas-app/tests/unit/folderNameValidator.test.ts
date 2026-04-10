import {
  validateFolderName,
  buildLayer1FolderName,
  buildLayer3FolderName,
} from '../../src/utils/folderNameValidator';

describe('folderNameValidator', () => {
  // ─── Layer 1 ─────────────────────────────────────────────────────────────────

  describe('validateFolderName — Layer 1 (Master Event Folder)', () => {
    it('accepts a standard event folder name', () => {
      const r = validateFolderName({ folderName: '2025-11-03_NYC_Marathon', layer: 1 });
      expect(r.isValid).toBe(true);
      expect(r.violations).toHaveLength(0);
    });

    it('accepts a single-word event name', () => {
      const r = validateFolderName({ folderName: '2025-12-25_Christmas', layer: 1 });
      expect(r.isValid).toBe(true);
    });

    it('accepts many-word event names', () => {
      const r = validateFolderName({ folderName: '2025-03-15_Boston_Spring_Half_Marathon', layer: 1 });
      expect(r.isValid).toBe(true);
    });

    it('rejects missing date prefix entirely', () => {
      const r = validateFolderName({ folderName: 'NYC_Marathon', layer: 1 });
      expect(r.isValid).toBe(false);
      expect(r.violations[0]).toContain('YYYY-MM-DD');
    });

    it('rejects lowercase event words', () => {
      const r = validateFolderName({ folderName: '2025-11-03_nyc_marathon', layer: 1 });
      expect(r.isValid).toBe(false);
    });

    it('rejects names with spaces', () => {
      const r = validateFolderName({ folderName: '2025-11-03_NYC Marathon', layer: 1 });
      expect(r.isValid).toBe(false);
    });

    it('rejects names with special characters', () => {
      const r = validateFolderName({ folderName: '2025-11-03_NYC@Marathon', layer: 1 });
      expect(r.isValid).toBe(false);
    });

    it('rejects date prefix with wrong format (US style)', () => {
      const r = validateFolderName({ folderName: '11-03-2025_NYC_Marathon', layer: 1 });
      expect(r.isValid).toBe(false);
    });

    it('rejects Feb 30 (impossible date)', () => {
      const r = validateFolderName({ folderName: '2025-02-30_Some_Event', layer: 1 });
      expect(r.isValid).toBe(false);
      expect(r.violations).toContain('The date portion is not a valid calendar date.');
    });

    it('rejects month 13', () => {
      const r = validateFolderName({ folderName: '2025-13-01_Some_Event', layer: 1 });
      expect(r.isValid).toBe(false);
    });

    it('rejects April 31 (April has 30 days)', () => {
      const r = validateFolderName({ folderName: '2025-04-31_Some_Event', layer: 1 });
      expect(r.isValid).toBe(false);
    });

    it('accepts Feb 28 on non-leap year', () => {
      const r = validateFolderName({ folderName: '2025-02-28_Winter_Run', layer: 1 });
      expect(r.isValid).toBe(true);
    });

    it('accepts Feb 29 on a leap year', () => {
      const r = validateFolderName({ folderName: '2024-02-29_Leap_Day_Race', layer: 1 });
      expect(r.isValid).toBe(true);
    });

    it('rejects Feb 29 on a non-leap year', () => {
      const r = validateFolderName({ folderName: '2025-02-29_Leap_Day_Race', layer: 1 });
      expect(r.isValid).toBe(false);
    });

    it('trims leading/trailing whitespace before validating', () => {
      const r = validateFolderName({ folderName: '  2025-11-03_NYC_Marathon  ', layer: 1 });
      expect(r.isValid).toBe(true);
      expect(r.normalizedName).toBe('2025-11-03_NYC_Marathon');
    });
  });

  // ─── Layer 2 ─────────────────────────────────────────────────────────────────

  describe('validateFolderName — Layer 2 (Club Folder)', () => {
    it('accepts valid club names', () => {
      expect(validateFolderName({ folderName: 'New_Bee',        layer: 2 }).isValid).toBe(true);
      expect(validateFolderName({ folderName: 'Misty_Mountain', layer: 2 }).isValid).toBe(true);
      expect(validateFolderName({ folderName: 'Nankai',         layer: 2 }).isValid).toBe(true);
    });

    it('accepts single-word club names', () => {
      const r = validateFolderName({ folderName: 'Runners', layer: 2 });
      expect(r.isValid).toBe(true);
    });

    it('rejects names starting with underscore', () => {
      const r = validateFolderName({ folderName: '_InvalidClub', layer: 2 });
      expect(r.isValid).toBe(false);
    });

    it('rejects names starting with a number', () => {
      const r = validateFolderName({ folderName: '1stClub', layer: 2 });
      expect(r.isValid).toBe(false);
    });

    it('rejects names with spaces', () => {
      const r = validateFolderName({ folderName: 'New Bee', layer: 2 });
      expect(r.isValid).toBe(false);
    });

    it('rejects names with special characters', () => {
      const r = validateFolderName({ folderName: 'Club@NYC', layer: 2 });
      expect(r.isValid).toBe(false);
    });

    it('rejects trailing underscores', () => {
      const r = validateFolderName({ folderName: 'New_Bee_', layer: 2 });
      expect(r.isValid).toBe(false);
    });

    it('rejects consecutive underscores', () => {
      const r = validateFolderName({ folderName: 'New__Bee', layer: 2 });
      expect(r.isValid).toBe(false);
    });
  });

  // ─── Layer 3 ─────────────────────────────────────────────────────────────────

  describe('validateFolderName — Layer 3 (Upload Batch Folder)', () => {
    it('accepts valid batch folder names', () => {
      const r = validateFolderName({ folderName: '20251103-093500_cathylin', layer: 3 });
      expect(r.isValid).toBe(true);
    });

    it('accepts usernames with dots and dashes', () => {
      const r = validateFolderName({ folderName: '20251103-093500_cathy.lin', layer: 3 });
      expect(r.isValid).toBe(true);
    });

    it('rejects uppercase username', () => {
      const r = validateFolderName({ folderName: '20251103-093500_CathyLin', layer: 3 });
      expect(r.isValid).toBe(false);
    });

    it('rejects username starting with a digit', () => {
      const r = validateFolderName({ folderName: '20251103-093500_1username', layer: 3 });
      expect(r.isValid).toBe(false);
    });

    it('rejects wrong timestamp format (with dashes in date)', () => {
      const r = validateFolderName({ folderName: '2025-11-03-093500_cathylin', layer: 3 });
      expect(r.isValid).toBe(false);
    });

    it('rejects missing underscore between timestamp and username', () => {
      const r = validateFolderName({ folderName: '20251103-093500cathylin', layer: 3 });
      expect(r.isValid).toBe(false);
    });
  });

  // ─── buildLayer1FolderName ────────────────────────────────────────────────────

  describe('buildLayer1FolderName()', () => {
    it('builds a valid Layer 1 name from date and event name', () => {
      const name = buildLayer1FolderName('2025-11-03', 'NYC Marathon');
      // charAt(0).toUpperCase() + rest-as-is: "NYC" → "NYC", "Marathon" → "Marathon"
      expect(name).toBe('2025-11-03_NYC_Marathon');
    });

    it('handles event names with mixed case', () => {
      const name = buildLayer1FolderName('2025-11-03', 'nyc marathon');
      // "nyc" → charAt(0).toUpperCase() = "N" + "yc" = "Nyc"
      expect(name).toBe('2025-11-03_Nyc_Marathon');
    });

    it('handles event names with extra spaces', () => {
      const name = buildLayer1FolderName('2025-11-03', '  Boston  Marathon  ');
      expect(name).toBe('2025-11-03_Boston_Marathon');
    });

    it('returns null for empty event name', () => {
      expect(buildLayer1FolderName('2025-11-03', '')).toBeNull();
      expect(buildLayer1FolderName('2025-11-03', '   ')).toBeNull();
    });

    it('returns null for invalid date', () => {
      expect(buildLayer1FolderName('not-a-date', 'Marathon')).toBeNull();
    });
  });

  // ─── buildLayer3FolderName ────────────────────────────────────────────────────

  describe('buildLayer3FolderName()', () => {
    it('builds a valid Layer 3 name', () => {
      const name = buildLayer3FolderName('20251103-093500', 'cathylin');
      expect(name).toBe('20251103-093500_cathylin');
    });

    it('lowercases the username', () => {
      const name = buildLayer3FolderName('20251103-093500', 'CathyLin');
      expect(name).toBe('20251103-093500_cathylin');
    });

    it('strips disallowed characters from username', () => {
      const name = buildLayer3FolderName('20251103-093500', 'cathy@example.com');
      // @ is stripped; . is kept (allowed)
      expect(name).toBe('20251103-093500_cathyexample.com');
    });
  });
});
