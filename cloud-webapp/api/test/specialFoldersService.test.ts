import { describe, it, expect } from 'vitest';

import {
  photosFolderName,
  bucketIndexForPosition,
  bucketCountForFiles,
  decidePhotoAction,
  photoCopyDestName,
  isNoisyName,
  planShortcutDedupe,
  planManagedEntryRenames,
  dedupePhotosByContent,
  isManagedFolderName,
  isPhotoFile,
  isVideoFile,
  isMediaFile,
} from '../src/services/specialFoldersService.js';
import type { ShortcutEntry, ManagedCopyEntry } from '../src/services/driveShortcutClient.js';
import type { DriveMediaFile } from '../src/services/driveService.js';

describe('photosFolderName', () => {
  it('zero-pads to three digits', () => {
    expect(photosFolderName(1)).toBe('Photos_001');
    expect(photosFolderName(42)).toBe('Photos_042');
    expect(photosFolderName(999)).toBe('Photos_999');
  });
  it('rejects non-positive', () => {
    expect(() => photosFolderName(0)).toThrow();
    expect(() => photosFolderName(-1)).toThrow();
  });
});

describe('bucket math (MAX_PHOTOS_PER_BUCKET=800 default)', () => {
  it('maps positions to 1-based buckets', () => {
    expect(bucketIndexForPosition(0)).toBe(1);
    expect(bucketIndexForPosition(799)).toBe(1);
    expect(bucketIndexForPosition(800)).toBe(2);
    expect(bucketIndexForPosition(1599)).toBe(2);
    expect(bucketIndexForPosition(1600)).toBe(3);
  });
  it('counts buckets for a file total', () => {
    expect(bucketCountForFiles(0)).toBe(0);
    expect(bucketCountForFiles(1)).toBe(1);
    expect(bucketCountForFiles(800)).toBe(1);
    expect(bucketCountForFiles(801)).toBe(2);
    expect(bucketCountForFiles(1600)).toBe(2);
  });
});

describe('decidePhotoAction (storage-minimizing policy)', () => {
  it('JPEG → shortcut, everything else → convert', () => {
    expect(decidePhotoAction('image/jpeg')).toBe('shortcut');
    expect(decidePhotoAction('image/png')).toBe('convert');
    expect(decidePhotoAction('image/heic')).toBe('convert');
    expect(decidePhotoAction('image/webp')).toBe('convert');
  });
});

describe('photoCopyDestName', () => {
  it('normalizes extension to .jpg', () => {
    expect(photoCopyDestName('IMG_5001.HEIC', new Set())).toBe('IMG_5001.jpg');
    expect(photoCopyDestName('pic.png', new Set())).toBe('pic.jpg');
  });
  it('avoids collisions with __N suffixes', () => {
    const used = new Set(['IMG.jpg', 'IMG__2.jpg']);
    expect(photoCopyDestName('IMG.png', used)).toBe('IMG__3.jpg');
  });
});

describe('isNoisyName', () => {
  it('flags Copy of … and (N) decorations', () => {
    expect(isNoisyName('Copy of IMG_1.jpg')).toBe(true);
    expect(isNoisyName('IMG_1 (2).jpg')).toBe(true);
    expect(isNoisyName('IMG_1.jpg')).toBe(false);
  });
});

describe('planShortcutDedupe', () => {
  const sc = (id: string, name: string, targetId: string): ShortcutEntry => ({ id, name, targetId });

  it('keeps one survivor per target, preferring clean names', () => {
    const existing = [
      sc('s1', 'Copy of A.jpg', 'tA'),
      sc('s2', 'A.jpg', 'tA'),
      sc('s3', 'B.jpg', 'tB'),
    ];
    const { survivors, trashShortcutIds } = planShortcutDedupe(existing);
    const survivorIds = survivors.map((s) => s.id).sort();
    expect(survivorIds).toEqual(['s2', 's3']);
    expect(trashShortcutIds).toEqual(['s1']);
  });

  it('is a no-op when every target is unique', () => {
    const existing = [sc('s1', 'A.jpg', 'tA'), sc('s2', 'B.jpg', 'tB')];
    const { survivors, trashShortcutIds } = planShortcutDedupe(existing);
    expect(survivors).toHaveLength(2);
    expect(trashShortcutIds).toHaveLength(0);
  });
});

describe('planManagedEntryRenames', () => {
  const sc = (id: string, name: string, targetId: string): ShortcutEntry => ({ id, name, targetId });
  const cp = (id: string, name: string, sourcePhotoId: string): ManagedCopyEntry => ({ id, name, sourcePhotoId });

  it('re-points a shortcut at its renamed target', () => {
    const sources = new Map([['tA', '20260620-143052_A.jpg']]);
    expect(planManagedEntryRenames([sc('s1', 'A.jpg', 'tA')], [], sources)).toEqual([
      { id: 's1', from: 'A.jpg', to: '20260620-143052_A.jpg' },
    ]);
  });

  it('is a no-op once names already match (idempotent re-run)', () => {
    const sources = new Map([['tA', 'A.jpg']]);
    expect(planManagedEntryRenames([sc('s1', 'A.jpg', 'tA')], [], sources)).toEqual([]);
  });

  it('leaves an entry alone when its source is gone', () => {
    expect(planManagedEntryRenames([sc('s1', 'A.jpg', 'tGone')], [], new Map())).toEqual([]);
  });

  it('renames a converted copy to the source stem with a .jpg extension', () => {
    const sources = new Map([['tA', '20260620-143052_A.heic']]);
    expect(planManagedEntryRenames([], [cp('c1', 'A.jpg', 'tA')], sources)).toEqual([
      { id: 'c1', from: 'A.jpg', to: '20260620-143052_A.jpg' },
    ]);
  });

  it('keeps converted copies collision-free within the folder', () => {
    // Two different sources whose renamed stems collide once both become .jpg.
    const sources = new Map([
      ['tA', '20260620-143052_shot.heic'],
      ['tB', '20260620-143052_shot.png'],
    ]);
    const out = planManagedEntryRenames([], [cp('c1', 'a.jpg', 'tA'), cp('c2', 'b.jpg', 'tB')], sources);
    const names = out.map((r) => r.to);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain('20260620-143052_shot.jpg');
  });

  it('does not let a copy steal a name a shortcut already holds', () => {
    const sources = new Map([
      ['tA', '20260620-143052_x.jpg'], // shortcut keeps this exact name
      ['tB', '20260620-143052_x.heic'], // copy would want the same .jpg name
    ]);
    const out = planManagedEntryRenames([sc('s1', 'old.jpg', 'tA')], [cp('c1', 'c.jpg', 'tB')], sources);
    const copyRename = out.find((r) => r.id === 'c1');
    expect(copyRename?.to).not.toBe('20260620-143052_x.jpg');
  });

  it('is deterministic regardless of input order', () => {
    const sources = new Map([
      ['tA', 'a-new.jpg'],
      ['tB', 'b-new.jpg'],
    ]);
    const a = planManagedEntryRenames([sc('s1', 'a.jpg', 'tA'), sc('s2', 'b.jpg', 'tB')], [], sources);
    const b = planManagedEntryRenames([sc('s2', 'b.jpg', 'tB'), sc('s1', 'a.jpg', 'tA')], [], sources);
    expect(a).toEqual(b);
  });
});

describe('dedupePhotosByContent', () => {
  const f = (id: string, md5?: string): DriveMediaFile => ({
    id,
    name: `${id}.jpg`,
    mimeType: 'image/jpeg',
    ...(md5 === undefined ? {} : { md5Checksum: md5 }),
  });

  it('keeps one file per content hash, preferring the first in order', () => {
    const { photos, duplicatesSkipped } = dedupePhotosByContent([
      f('a', 'HASH1'),
      f('b', 'hash1'), // same bytes, different Drive id — the re-upload
      f('c', 'hash2'),
    ]);
    expect(photos.map((p) => p.id)).toEqual(['a', 'c']);
    expect(duplicatesSkipped).toBe(1);
  });

  it('is case-insensitive on the hash', () => {
    const { photos } = dedupePhotosByContent([f('a', 'ABCDEF'), f('b', 'abcdef')]);
    expect(photos.map((p) => p.id)).toEqual(['a']);
  });

  it('KEEPS files with no md5 — unknown is not the same as duplicate', () => {
    const { photos, duplicatesSkipped } = dedupePhotosByContent([f('a'), f('b'), f('c', '')]);
    expect(photos.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(duplicatesSkipped).toBe(0);
  });

  it('is a no-op when every photo is unique', () => {
    const { photos, duplicatesSkipped } = dedupePhotosByContent([f('a', 'h1'), f('b', 'h2')]);
    expect(photos).toHaveLength(2);
    expect(duplicatesSkipped).toBe(0);
  });

  it('collapses a large duplicate run to a single entry', () => {
    const many = Array.from({ length: 12 }, (_, i) => f(`dup${i}`, 'same'));
    const { photos, duplicatesSkipped } = dedupePhotosByContent(many);
    expect(photos).toHaveLength(1);
    expect(duplicatesSkipped).toBe(11);
  });
});

describe('folder/MIME classifiers', () => {
  it('recognizes managed folder names', () => {
    expect(isManagedFolderName('Photos_001')).toBe(true);
    expect(isManagedFolderName('Videos')).toBe(true);
    expect(isManagedFolderName('Album')).toBe(true);
    expect(isManagedFolderName('岚山')).toBe(false);
  });
  it('classifies photo/video/media MIME types', () => {
    expect(isPhotoFile('image/jpeg')).toBe(true);
    expect(isPhotoFile('video/mp4')).toBe(false);
    expect(isVideoFile('video/quicktime')).toBe(true);
    expect(isMediaFile('image/heic')).toBe(true);
    expect(isMediaFile('video/mp4')).toBe(true);
    expect(isMediaFile('application/pdf')).toBe(false);
  });
});
