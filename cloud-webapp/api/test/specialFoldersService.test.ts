import { describe, it, expect } from 'vitest';

import {
  photosFolderName,
  bucketIndexForPosition,
  bucketCountForFiles,
  decidePhotoAction,
  photoCopyDestName,
  isNoisyName,
  planShortcutDedupe,
  isManagedFolderName,
  isPhotoFile,
  isVideoFile,
  isMediaFile,
} from '../src/services/specialFoldersService.js';
import type { ShortcutEntry } from '../src/services/driveShortcutClient.js';

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
