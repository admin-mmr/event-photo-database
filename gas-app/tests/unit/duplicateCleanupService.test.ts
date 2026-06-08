/**
 * Unit tests for duplicateCleanupService — pure detection logic.
 *
 * The Drive walking + REST listing paths delegate to driveService /
 * driveShortcutClient (tested elsewhere). The leveraged pieces here are the
 * pure helpers: noisy-name parsing, keeper selection, and group building.
 */

jest.mock('../../src/services/sheetService');
jest.mock('../../src/services/driveService');
jest.mock('../../src/services/eventService');
jest.mock('../../src/services/driveShortcutClient');

import {
  parseNoisyName,
  chooseKeeper,
  findDuplicateGroups,
  ScannedFile,
} from '../../src/services/duplicateCleanupService';

function makeFile(overrides: Partial<ScannedFile> = {}): ScannedFile {
  return {
    id: 'f-001',
    name: 'Misty_Mountain_PaulineHuang_IMG_5518.jpeg',
    mimeType: 'image/jpeg',
    sizeBytes: 1000,
    md5Checksum: 'aaa',
    createdTime: '2026-06-06T10:00:00Z',
    clubName: 'Misty_Mountain',
    tag: 'ALL',
    batchFolderName: '20260606-160229_x',
    ...overrides,
  };
}

// ─── parseNoisyName ──────────────────────────────────────────────────────────

describe('duplicateCleanupService — parseNoisyName()', () => {
  it('returns the name unchanged for canonical filenames', () => {
    expect(parseNoisyName('a.jpeg')).toEqual({ base: 'a.jpeg', noisy: false });
    expect(parseNoisyName('IMG_5518.jpeg')).toEqual({ base: 'IMG_5518.jpeg', noisy: false });
  });

  it('strips a " (N)" counter before the extension', () => {
    expect(parseNoisyName('IMG_5518 (1).jpeg')).toEqual({ base: 'IMG_5518.jpeg', noisy: true });
    expect(parseNoisyName('IMG_5518 (12).jpeg')).toEqual({ base: 'IMG_5518.jpeg', noisy: true });
  });

  it('strips a trailing " (N)" on extension-less names', () => {
    expect(parseNoisyName('notes (1)')).toEqual({ base: 'notes', noisy: true });
  });

  it('strips a "Copy of " prefix, including stacked copies, any case', () => {
    expect(parseNoisyName('Copy of a.jpeg')).toEqual({ base: 'a.jpeg', noisy: true });
    expect(parseNoisyName('Copy of Copy of a.jpeg')).toEqual({ base: 'a.jpeg', noisy: true });
    expect(parseNoisyName('copy of a.jpeg')).toEqual({ base: 'a.jpeg', noisy: true });
  });

  it('handles combined prefix + counter', () => {
    expect(parseNoisyName('Copy of a (2).jpeg')).toEqual({ base: 'a.jpeg', noisy: true });
  });

  it('does not treat parentheses inside the name (no space / not numeric) as noise', () => {
    expect(parseNoisyName('a(1).jpeg')).toEqual({ base: 'a(1).jpeg', noisy: false });
    expect(parseNoisyName('a (final).jpeg')).toEqual({ base: 'a (final).jpeg', noisy: false });
  });
});

// ─── chooseKeeper ────────────────────────────────────────────────────────────

describe('duplicateCleanupService — chooseKeeper()', () => {
  it('prefers the canonically named file over noisy names regardless of age', () => {
    const noisyOld = makeFile({ id: 'f-1', name: 'a (1).jpeg', createdTime: '2026-01-01T00:00:00Z' });
    const cleanNew = makeFile({ id: 'f-2', name: 'a.jpeg', createdTime: '2026-06-01T00:00:00Z' });
    expect(chooseKeeper([noisyOld, cleanNew]).id).toBe('f-2');
  });

  it('breaks ties between canonical names by earliest createdTime', () => {
    const newer = makeFile({ id: 'f-1', name: 'a.jpeg', createdTime: '2026-06-01T00:00:00Z' });
    const older = makeFile({ id: 'f-2', name: 'b.jpeg', createdTime: '2026-01-01T00:00:00Z' });
    expect(chooseKeeper([newer, older]).id).toBe('f-2');
  });

  it('never lets an undated file beat a dated one', () => {
    const undated = makeFile({ id: 'f-1', name: 'a.jpeg', createdTime: '' });
    const dated = makeFile({ id: 'f-2', name: 'b.jpeg', createdTime: '2026-01-01T00:00:00Z' });
    expect(chooseKeeper([undated, dated]).id).toBe('f-2');
  });

  it('throws on an empty group', () => {
    expect(() => chooseKeeper([])).toThrow();
  });
});

// ─── findDuplicateGroups ─────────────────────────────────────────────────────

describe('duplicateCleanupService — findDuplicateGroups()', () => {
  it('returns no groups when all files are unique', () => {
    const files = [
      makeFile({ id: 'f-1', md5Checksum: 'aaa' }),
      makeFile({ id: 'f-2', name: 'other.jpeg', md5Checksum: 'bbb' }),
    ];
    expect(findDuplicateGroups(files)).toEqual([]);
  });

  it('groups files with identical MD5 and flags the noisy copy for deletion', () => {
    const original = makeFile({ id: 'f-1', name: 'IMG_5518.jpeg', md5Checksum: 'aaa' });
    const copy = makeFile({ id: 'f-2', name: 'IMG_5518 (1).jpeg', md5Checksum: 'aaa' });
    const groups = findDuplicateGroups([copy, original]);

    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe('md5');
    expect(groups[0].keeper.fileId).toBe('f-1');
    expect(groups[0].duplicates.map((d) => d.fileId)).toEqual(['f-2']);
  });

  it('catches renamed binary copies via MD5 ("Copy of" with different base)', () => {
    const original = makeFile({ id: 'f-1', name: 'Frida_15633.jpeg', md5Checksum: 'xyz' });
    const renamed = makeFile({ id: 'f-2', name: 'Copy of Frida_15633.jpeg', md5Checksum: 'xyz' });
    const groups = findDuplicateGroups([renamed, original]);
    expect(groups).toHaveLength(1);
    expect(groups[0].keeper.fileId).toBe('f-1');
  });

  it('never matches files across different clubs even with identical MD5', () => {
    const a = makeFile({ id: 'f-1', clubName: 'Club_A', md5Checksum: 'same' });
    const b = makeFile({ id: 'f-2', clubName: 'Club_B', md5Checksum: 'same' });
    expect(findDuplicateGroups([a, b])).toEqual([]);
  });

  it('matches across tags within the same club (same photo uploaded twice)', () => {
    const a = makeFile({ id: 'f-1', tag: 'ALL', md5Checksum: 'same' });
    const b = makeFile({ id: 'f-2', tag: 'finish_line', name: 'x (1).jpeg', md5Checksum: 'same' });
    const groups = findDuplicateGroups([a, b]);
    expect(groups).toHaveLength(1);
  });

  it('falls back to name-pattern + size matching when MD5 is unavailable', () => {
    const original = makeFile({ id: 'f-1', name: 'a.jpeg', md5Checksum: '', sizeBytes: 500 });
    const copy = makeFile({ id: 'f-2', name: 'a (1).jpeg', md5Checksum: '', sizeBytes: 500 });
    const groups = findDuplicateGroups([original, copy]);

    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe('name');
    expect(groups[0].keeper.fileId).toBe('f-1');
    expect(groups[0].duplicates.map((d) => d.fileId)).toEqual(['f-2']);
  });

  it('does NOT flag a name-pattern pair whose sizes differ', () => {
    const original = makeFile({ id: 'f-1', name: 'a.jpeg', md5Checksum: '', sizeBytes: 500 });
    const edited = makeFile({ id: 'f-2', name: 'a (1).jpeg', md5Checksum: '', sizeBytes: 999 });
    expect(findDuplicateGroups([original, edited])).toEqual([]);
  });

  it('does NOT flag a name-pattern pair when both have MD5s that differ', () => {
    const original = makeFile({ id: 'f-1', name: 'a.jpeg', md5Checksum: 'aaa', sizeBytes: 500 });
    const edited = makeFile({ id: 'f-2', name: 'Copy of a.jpeg', md5Checksum: 'bbb', sizeBytes: 500 });
    expect(findDuplicateGroups([original, edited])).toEqual([]);
  });

  it('collapses several numbered copies of the same base into one group', () => {
    const original = makeFile({ id: 'f-1', name: 'a.jpeg', md5Checksum: '', sizeBytes: 500 });
    const c1 = makeFile({ id: 'f-2', name: 'a (1).jpeg', md5Checksum: '', sizeBytes: 500 });
    const c2 = makeFile({ id: 'f-3', name: 'a (2).jpeg', md5Checksum: '', sizeBytes: 500 });
    const groups = findDuplicateGroups([original, c1, c2]);

    expect(groups).toHaveLength(1);
    expect(groups[0].duplicates.map((d) => d.fileId).sort()).toEqual(['f-2', 'f-3']);
  });

  it('does not double-report files already claimed by an MD5 group', () => {
    const original = makeFile({ id: 'f-1', name: 'a.jpeg', md5Checksum: 'same' });
    const copy = makeFile({ id: 'f-2', name: 'a (1).jpeg', md5Checksum: 'same' });
    const groups = findDuplicateGroups([original, copy]);

    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe('md5');
  });

  it('sorts groups by club then keeper filename for a stable report', () => {
    const files = [
      makeFile({ id: 'z1', clubName: 'Zeta', name: 'z.jpeg', md5Checksum: 'm1' }),
      makeFile({ id: 'z2', clubName: 'Zeta', name: 'z (1).jpeg', md5Checksum: 'm1' }),
      makeFile({ id: 'a1', clubName: 'Alpha', name: 'a.jpeg', md5Checksum: 'm2' }),
      makeFile({ id: 'a2', clubName: 'Alpha', name: 'a (1).jpeg', md5Checksum: 'm2' }),
    ];
    const groups = findDuplicateGroups(files);
    expect(groups.map((g) => g.clubName)).toEqual(['Alpha', 'Zeta']);
  });
});
