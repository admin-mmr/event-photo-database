import {
  checkForDuplicates,
  resolveUploadList,
  IncomingFileInfo,
  DuplicateMatch,
} from '../../src/services/duplicateCheckService';
import { ClubFolderFileEntry } from '../../src/services/driveService';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeExisting(overrides: Partial<ClubFolderFileEntry> = {}): ClubFolderFileEntry {
  return {
    name: 'photo1.jpg',
    fileId: 'file-id-001',
    sizeBytes: 1024 * 1024,
    modifiedAt: '2025-11-03T10:00:00.000Z',
    batchFolderName: '20251103-093500_cathylin',
    batchFolderId: 'batch-id-001',
    ...overrides,
  };
}

function makeIncoming(overrides: Partial<IncomingFileInfo> = {}): IncomingFileInfo {
  return {
    name: 'photo1.jpg',
    sizeBytes: 1024 * 1024,
    ...overrides,
  };
}

// ─── checkForDuplicates ───────────────────────────────────────────────────────

describe('checkForDuplicates()', () => {
  it('returns all files as accepted when there are no existing files', () => {
    const incoming = [makeIncoming({ name: 'a.jpg' }), makeIncoming({ name: 'b.jpg' })];
    const result = checkForDuplicates(incoming, []);
    expect(result.accepted).toHaveLength(2);
    expect(result.duplicates).toHaveLength(0);
  });

  it('returns an empty result when incoming is empty', () => {
    const existing = [makeExisting()];
    const result = checkForDuplicates([], existing);
    expect(result.accepted).toHaveLength(0);
    expect(result.duplicates).toHaveLength(0);
  });

  it('flags a file as duplicate when name AND size both match', () => {
    const incoming = [makeIncoming({ name: 'photo1.jpg', sizeBytes: 1024 * 1024 })];
    const existing = [makeExisting({ name: 'photo1.jpg', sizeBytes: 1024 * 1024 })];

    const result = checkForDuplicates(incoming, existing);

    expect(result.accepted).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].incomingFile.name).toBe('photo1.jpg');
    expect(result.duplicates[0].matchedFile.batchFolderName).toBe('20251103-093500_cathylin');
  });

  it('does NOT flag a duplicate when names match but sizes differ', () => {
    const incoming = [makeIncoming({ name: 'photo1.jpg', sizeBytes: 999 })];
    const existing = [makeExisting({ name: 'photo1.jpg', sizeBytes: 1024 * 1024 })];

    const result = checkForDuplicates(incoming, existing);

    expect(result.accepted).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });

  it('does NOT flag a duplicate when sizes match but names differ', () => {
    const incoming = [makeIncoming({ name: 'different.jpg', sizeBytes: 1024 * 1024 })];
    const existing = [makeExisting({ name: 'photo1.jpg', sizeBytes: 1024 * 1024 })];

    const result = checkForDuplicates(incoming, existing);

    expect(result.accepted).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });

  it('performs case-insensitive filename comparison', () => {
    const incoming = [makeIncoming({ name: 'PHOTO1.JPG', sizeBytes: 1024 * 1024 })];
    const existing = [makeExisting({ name: 'photo1.jpg', sizeBytes: 1024 * 1024 })];

    const result = checkForDuplicates(incoming, existing);

    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].incomingFile.name).toBe('PHOTO1.JPG');
  });

  it('correctly partitions a mixed batch of accepted and duplicate files', () => {
    const incoming = [
      makeIncoming({ name: 'dup1.jpg', sizeBytes: 100 }),
      makeIncoming({ name: 'new1.jpg', sizeBytes: 200 }),
      makeIncoming({ name: 'dup2.png', sizeBytes: 300 }),
      makeIncoming({ name: 'new2.heic', sizeBytes: 400 }),
    ];
    const existing = [
      makeExisting({ name: 'dup1.jpg', sizeBytes: 100 }),
      makeExisting({ name: 'dup2.png', sizeBytes: 300 }),
    ];

    const result = checkForDuplicates(incoming, existing);

    expect(result.accepted.map((f) => f.name)).toEqual(['new1.jpg', 'new2.heic']);
    expect(result.duplicates.map((d) => d.incomingFile.name)).toEqual(['dup1.jpg', 'dup2.png']);
  });

  it('reports the correct matched batch folder name for a duplicate', () => {
    const incoming = [makeIncoming({ name: 'race.jpg', sizeBytes: 500 })];
    const existing = [
      makeExisting({ name: 'race.jpg', sizeBytes: 500, batchFolderName: '20251103-120000_bob' }),
    ];

    const result = checkForDuplicates(incoming, existing);

    expect(result.duplicates[0].matchedFile.batchFolderName).toBe('20251103-120000_bob');
  });

  it('returns only the first existing match when a file appears in multiple batch folders', () => {
    const incoming = [makeIncoming({ name: 'race.jpg', sizeBytes: 500 })];
    const existing = [
      makeExisting({ name: 'race.jpg', sizeBytes: 500, batchFolderId: 'batch-a', batchFolderName: '20251103-080000_alice' }),
      makeExisting({ name: 'race.jpg', sizeBytes: 500, batchFolderId: 'batch-b', batchFolderName: '20251103-150000_bob' }),
    ];

    const result = checkForDuplicates(incoming, existing);

    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].matchedFile.batchFolderName).toBe('20251103-080000_alice');
  });
});

// ─── resolveUploadList ────────────────────────────────────────────────────────

describe('resolveUploadList()', () => {
  const dup1: DuplicateMatch = {
    incomingFile: makeIncoming({ name: 'dup1.jpg' }),
    matchedFile: { name: 'dup1.jpg', fileId: 'x', sizeBytes: 1, batchFolderName: 'batch' },
  };
  const dup2: DuplicateMatch = {
    incomingFile: makeIncoming({ name: 'dup2.jpg' }),
    matchedFile: { name: 'dup2.jpg', fileId: 'y', sizeBytes: 1, batchFolderName: 'batch' },
  };

  it('includes accepted files and skips all duplicates when overwrite set is empty', () => {
    const accepted = [makeIncoming({ name: 'new.jpg' })];
    const result = resolveUploadList(accepted, [dup1, dup2], new Set());

    expect(result.toUpload.map((f) => f.name)).toEqual(['new.jpg']);
    expect(result.skippedCount).toBe(2);
  });

  it('includes a duplicate when the user chose to overwrite it', () => {
    const accepted = [makeIncoming({ name: 'new.jpg' })];
    const result = resolveUploadList(accepted, [dup1, dup2], new Set(['dup1.jpg']));

    expect(result.toUpload.map((f) => f.name)).toEqual(['new.jpg', 'dup1.jpg']);
    expect(result.skippedCount).toBe(1);
  });

  it('includes all duplicates when all are in the overwrite set', () => {
    const accepted: IncomingFileInfo[] = [];
    const result = resolveUploadList(
      accepted,
      [dup1, dup2],
      new Set(['dup1.jpg', 'dup2.jpg'])
    );

    expect(result.toUpload).toHaveLength(2);
    expect(result.skippedCount).toBe(0);
  });

  it('skips all duplicates and preserves accepted files when overwrite set is empty', () => {
    const accepted = [makeIncoming({ name: 'a.jpg' }), makeIncoming({ name: 'b.jpg' })];
    const result = resolveUploadList(accepted, [dup1], new Set());

    expect(result.toUpload.map((f) => f.name)).toEqual(['a.jpg', 'b.jpg']);
    expect(result.skippedCount).toBe(1);
  });

  it('returns empty list with zero skipped when both inputs are empty', () => {
    const result = resolveUploadList([], [], new Set());
    expect(result.toUpload).toHaveLength(0);
    expect(result.skippedCount).toBe(0);
  });
});
