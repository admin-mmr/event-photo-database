/**
 * duplicateFilesService — grouping rules and the trash+ledger removal pass.
 *
 * The contract that matters most: the surviving copy is the FIRST in relPath
 * order, byte-for-byte the rule indexer/job.py uses when it collapses photos by
 * md5. If these two ever disagree, removal trashes the file the live index
 * points at and the gallery loses a photo until the next re-index.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.MASTER_SPREADSHEET_ID = 'sheet1';
process.env.MANAGED_FOLDERS_ENABLED = 'true';

// Untyped spies (default behaviour set in beforeEach) so each test can shape a
// single call without fighting inferred argument tuples.
const walkMediaFiles = vi.fn();
const getDriveToken = vi.fn();
vi.mock('../src/services/driveService.js', () => ({
  walkMediaFiles: (...a: unknown[]) => walkMediaFiles(...a),
  getDriveToken: (...a: unknown[]) => getDriveToken(...a),
  DRIVE_SCOPE_READWRITE: 'https://www.googleapis.com/auth/drive',
}));

const trashDriveFile = vi.fn();
vi.mock('../src/services/driveShortcutClient.js', () => ({
  trashDriveFile: (...a: unknown[]) => trashDriveFile(...a),
}));

const recordSoftDelete = vi.fn();
vi.mock('../src/services/deletedFilesStore.js', () => ({
  recordSoftDelete: (...a: unknown[]) => recordSoftDelete(...a),
}));

const removeShortcutsForTargets = vi.fn();
vi.mock('../src/services/specialFoldersService.js', () => ({
  removeShortcutsForTargets: (...a: unknown[]) => removeShortcutsForTargets(...a),
  isManagedFolderName: (n: string) => n === 'Videos' || n === 'Album' || n.startsWith('Photos_'),
  isVideoFile: (m: string) => m === 'video/mp4' || m === 'video/quicktime',
}));

const tryRebuildPublicFolderIndex = vi.fn();
vi.mock('../src/services/publicFolderIndexService.js', () => ({
  tryRebuildPublicFolderIndex: () => tryRebuildPublicFolderIndex(),
}));

const eventDoc = vi.fn();
vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({ collection: () => ({ doc: () => ({ get: eventDoc }) }) }),
}));

const {
  scanEventDuplicates,
  removeEventDuplicates,
  groupByContentHash,
  pathContext,
} = await import('../src/services/duplicateFilesService.js');

interface F {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  relPath?: string;
  size?: string;
}
const file = (id: string, relPath: string, md5?: string, size = '100'): F => ({
  id,
  name: relPath.split('/').pop()!,
  mimeType: 'image/jpeg',
  ...(md5 === undefined ? {} : { md5Checksum: md5 }),
  relPath,
  size,
});

beforeEach(() => {
  walkMediaFiles.mockReset().mockResolvedValue([]);
  getDriveToken.mockReset().mockResolvedValue('tok');
  trashDriveFile.mockReset().mockResolvedValue({ ok: true, status: 200 });
  recordSoftDelete.mockReset().mockResolvedValue({ deleteId: 'd1' });
  removeShortcutsForTargets.mockReset().mockResolvedValue({ shortcutsRemoved: 0, foldersTouched: 0, errors: [] });
  tryRebuildPublicFolderIndex.mockReset().mockResolvedValue(undefined);
  eventDoc.mockReset().mockResolvedValue({ data: () => ({ driveFolderId: 'root1', name: 'Spring Meet' }) });
});

describe('pathContext', () => {
  it('reads club + batch folder out of a Club/tag/batch/file path', () => {
    expect(pathContext('Blue Club/finals/batch-7/IMG_1.jpg')).toEqual({
      clubName: 'Blue Club',
      batchFolderName: 'batch-7',
    });
  });

  it('leaves both blank for a file sitting at the event root', () => {
    expect(pathContext('IMG_1.jpg')).toEqual({ clubName: '', batchFolderName: '' });
  });
});

describe('groupByContentHash', () => {
  it('keeps the first copy in relPath order, matching the indexer', () => {
    // Deliberately supplied out of order — sorting is the service's job.
    const { groups } = groupByContentHash([
      file('c', 'Club/z/late.jpg', 'same'),
      file('a', 'Club/a/early.jpg', 'same'),
      file('b', 'Club/m/mid.jpg', 'same'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.canonical.driveFileId).toBe('a');
    expect(groups[0]!.duplicates.map((d) => d.driveFileId)).toEqual(['b', 'c']);
  });

  it('orders by code point (not locale) so it agrees with Python sorted()', () => {
    // localeCompare puts 'a' before 'B'; code-point order puts 'B' first, which
    // is what indexer/job.py does.
    const { groups } = groupByContentHash([file('lower', 'a.jpg', 'h'), file('upper', 'B.jpg', 'h')]);
    expect(groups[0]!.canonical.driveFileId).toBe('upper');
  });

  it('ignores unique files and counts files Drive gave no md5 for', () => {
    const { groups, unhashedFiles } = groupByContentHash([
      file('u1', 'a.jpg', 'h1'),
      file('u2', 'b.jpg', 'h2'),
      file('n1', 'c.jpg', undefined),
      file('n2', 'd.jpg', ''),
    ]);
    expect(groups).toEqual([]);
    expect(unhashedFiles).toBe(2);
  });

  it('treats two no-md5 files as distinct, never as duplicates of each other', () => {
    const { groups } = groupByContentHash([file('n1', 'a.jpg', ''), file('n2', 'b.jpg', '')]);
    expect(groups).toEqual([]);
  });

  it('matches hashes case-insensitively', () => {
    const { groups } = groupByContentHash([file('a', 'a.jpg', 'ABCD'), file('b', 'b.jpg', 'abcd')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.duplicates.map((d) => d.driveFileId)).toEqual(['b']);
  });
});

describe('scanEventDuplicates', () => {
  it('never walks the managed folders (their copies are not duplicates)', async () => {
    walkMediaFiles.mockResolvedValue([]);
    await scanEventDuplicates('ev1');
    const skip = walkMediaFiles.mock.calls[0]![2].skipChildFolder as (n: string) => boolean;
    expect(skip('Photos_001')).toBe(true);
    expect(skip('Album')).toBe(true);
    expect(skip('Videos')).toBe(true);
    expect(skip('Blue Club')).toBe(false);
  });

  it('reports totals and the bytes a removal would reclaim', async () => {
    walkMediaFiles.mockResolvedValue([
      file('a', 'Club/t/b/1.jpg', 'dup', '500'),
      file('b', 'Club/t/b/2.jpg', 'dup', '500'),
      file('c', 'Club/t/b/3.jpg', 'dup', '500'),
      file('d', 'Club/t/b/4.jpg', 'unique', '900'),
    ]);
    const out = await scanEventDuplicates('ev1');
    expect(out.ok).toBe(true);
    expect(out.data!.eventName).toBe('Spring Meet');
    expect(out.data!.filesScanned).toBe(4);
    expect(out.data!.duplicateFiles).toBe(2);
    // Only the removable copies count — the canonical stays.
    expect(out.data!.reclaimableBytes).toBe(1000);
  });

  it('confines a club_admin to their own club subtree', async () => {
    walkMediaFiles.mockResolvedValue([
      file('mine1', 'Blue/t/b/1.jpg', 'dup'),
      file('mine2', 'Blue/t/b/2.jpg', 'dup'),
      file('theirs', 'Red/t/b/3.jpg', 'dup'),
    ]);
    const out = await scanEventDuplicates('ev1', { clubScope: 'Blue' });
    expect(out.data!.filesScanned).toBe(2);
    const ids = out.data!.groups.flatMap((g) => [g.canonical.driveFileId, ...g.duplicates.map((d) => d.driveFileId)]);
    expect(ids).toEqual(['mine1', 'mine2']);
  });

  it('fails cleanly when the event has no Drive folder', async () => {
    eventDoc.mockResolvedValueOnce({ data: () => ({}) });
    const out = await scanEventDuplicates('ev1');
    expect(out.ok).toBe(false);
    expect(walkMediaFiles).not.toHaveBeenCalled();
  });
});

describe('removeEventDuplicates', () => {
  const threeDupes = [
    file('keep', 'Club/t/b/1.jpg', 'dup', '400'),
    file('dup1', 'Club/t/b/2.jpg', 'dup', '400'),
    file('dup2', 'Club/t/b/3.jpg', 'dup', '400'),
  ];

  it('writes NOTHING on a dry run', async () => {
    walkMediaFiles.mockResolvedValue(threeDupes);
    const out = await removeEventDuplicates('ev1', { actorEmail: 'a@x.org' });
    expect(out.data!.apply).toBe(false);
    expect(out.data!.candidates).toBe(2);
    expect(out.data!.planned.map((p) => p.driveFileId)).toEqual(['dup1', 'dup2']);
    expect(out.data!.removed).toBe(0);
    expect(trashDriveFile).not.toHaveBeenCalled();
    expect(recordSoftDelete).not.toHaveBeenCalled();
  });

  it('trashes every duplicate but never the canonical', async () => {
    walkMediaFiles.mockResolvedValue(threeDupes);
    const out = await removeEventDuplicates('ev1', { apply: true, actorEmail: 'a@x.org' });
    expect(out.data!.removed).toBe(2);
    expect(out.data!.bytesReclaimed).toBe(800);
    const trashed = trashDriveFile.mock.calls.map((c) => c[0]);
    expect(trashed).toEqual(['dup1', 'dup2']);
    expect(trashed).not.toContain('keep');
  });

  it('ledgers each removal with the club, batch and the copy that was kept', async () => {
    walkMediaFiles.mockResolvedValue(threeDupes);
    await removeEventDuplicates('ev1', { apply: true, actorEmail: 'a@x.org' });
    const [sheetId, rec, actorEmail] = recordSoftDelete.mock.calls[0]! as [string, Record<string, string>, string];
    expect(sheetId).toBe('sheet1');
    expect(actorEmail).toBe('a@x.org');
    expect(rec).toMatchObject({
      driveFileId: 'dup1',
      fileName: '2.jpg',
      eventId: 'ev1',
      clubName: 'Club',
      batchFolderName: 'b',
    });
    expect(rec.reason).toContain('Club/t/b/1.jpg');
  });

  it('does not ledger a file whose trash call failed', async () => {
    walkMediaFiles.mockResolvedValue(threeDupes);
    trashDriveFile.mockResolvedValueOnce({ ok: false, error: 'HTTP 403', status: 403 });
    const out = await removeEventDuplicates('ev1', { apply: true, actorEmail: 'a@x.org' });
    expect(out.data!.failed).toBe(1);
    expect(out.data!.removed).toBe(1);
    expect(recordSoftDelete.mock.calls.map((c) => (c[1] as { driveFileId: string }).driveFileId)).toEqual(['dup2']);
    expect(out.data!.warnings[0]).toContain('Club/t/b/2.jpg');
  });

  it('still counts a removal (and warns) when the ledger write fails', async () => {
    walkMediaFiles.mockResolvedValue(threeDupes);
    recordSoftDelete.mockRejectedValueOnce(new Error('sheet down'));
    const out = await removeEventDuplicates('ev1', { apply: true, actorEmail: 'a@x.org' });
    expect(out.data!.removed).toBe(2);
    expect(out.data!.warnings.join(' ')).toContain('ledger write failed');
  });

  it('honours the limit and reports what is left for the next call', async () => {
    walkMediaFiles.mockResolvedValue(threeDupes);
    const out = await removeEventDuplicates('ev1', { apply: true, limit: 1, actorEmail: 'a@x.org' });
    expect(out.data!.removed).toBe(1);
    expect(out.data!.remaining).toBe(1);
    expect(trashDriveFile).toHaveBeenCalledTimes(1);
  });

  it('restricts the run to the requested hashes', async () => {
    walkMediaFiles.mockResolvedValue([
      ...threeDupes,
      file('otherKeep', 'Club/t/b/4.jpg', 'other'),
      file('otherDup', 'Club/t/b/5.jpg', 'other'),
    ]);
    const out = await removeEventDuplicates('ev1', { apply: true, hashes: ['OTHER'], actorEmail: 'a@x.org' });
    expect(out.data!.candidates).toBe(1);
    expect(trashDriveFile.mock.calls.map((c) => c[0])).toEqual(['otherDup']);
  });

  it('sweeps managed shortcuts for the trashed originals and refreshes the index', async () => {
    walkMediaFiles.mockResolvedValue(threeDupes);
    await removeEventDuplicates('ev1', { apply: true, actorEmail: 'a@x.org' });
    expect(removeShortcutsForTargets).toHaveBeenCalledWith(['dup1', 'dup2']);
    expect(tryRebuildPublicFolderIndex).toHaveBeenCalledTimes(1);
  });

  it('skips the sweep entirely when nothing was trashed', async () => {
    walkMediaFiles.mockResolvedValue([file('only', 'Club/t/b/1.jpg', 'h')]);
    const out = await removeEventDuplicates('ev1', { apply: true, actorEmail: 'a@x.org' });
    expect(out.data!.removed).toBe(0);
    expect(removeShortcutsForTargets).not.toHaveBeenCalled();
    expect(tryRebuildPublicFolderIndex).not.toHaveBeenCalled();
  });

  it('only touches the scoped club when a club_admin applies', async () => {
    walkMediaFiles.mockResolvedValue([
      file('mine1', 'Blue/t/b/1.jpg', 'dup'),
      file('mine2', 'Blue/t/b/2.jpg', 'dup'),
      file('theirs1', 'Red/t/b/1.jpg', 'dup'),
      file('theirs2', 'Red/t/b/2.jpg', 'dup'),
    ]);
    await removeEventDuplicates('ev1', { apply: true, clubScope: 'Blue', actorEmail: 'a@x.org' });
    expect(trashDriveFile.mock.calls.map((c) => c[0])).toEqual(['mine2']);
  });
});
