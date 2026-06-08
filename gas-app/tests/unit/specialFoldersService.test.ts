/**
 * Unit tests for specialFoldersService — pure helpers only.
 *
 * The Drive walking, shortcut creation, and sheet I/O code paths in
 * specialFoldersService delegate to driveService, driveShortcutClient,
 * and sheetService. Those are exercised through their own service tests
 * and (in production) by the post-batch-sync integration. The pure
 * computational helpers below are the most leveraged piece — folder-
 * indexing math and MIME classification — so they're worth dedicated
 * unit coverage.
 */

import {
  photosFolderName,
  bucketIndexForPosition,
  bucketCountForFiles,
  isPhotoFile,
  isVideoFile,
  isMediaFile,
  PHOTO_TARGET_MIME_TYPES,
  VIDEO_TARGET_MIME_TYPES,
} from '../../src/services/specialFoldersService';
import {
  PHOTOS_FOLDER_PREFIX,
  MAX_SHORTCUTS_PER_PHOTOS_FOLDER,
} from '../../src/config/constants';
import { PhotoMimeType, VideoMimeType } from '../../src/types/enums';

// ─── photosFolderName ─────────────────────────────────────────────────────────

describe('specialFoldersService — photosFolderName()', () => {
  it('zero-pads single-digit indices to width 3', () => {
    expect(photosFolderName(1)).toBe(`${PHOTOS_FOLDER_PREFIX}001`);
    expect(photosFolderName(2)).toBe(`${PHOTOS_FOLDER_PREFIX}002`);
    expect(photosFolderName(9)).toBe(`${PHOTOS_FOLDER_PREFIX}009`);
  });

  it('zero-pads two-digit indices to width 3', () => {
    expect(photosFolderName(10)).toBe(`${PHOTOS_FOLDER_PREFIX}010`);
    expect(photosFolderName(42)).toBe(`${PHOTOS_FOLDER_PREFIX}042`);
    expect(photosFolderName(99)).toBe(`${PHOTOS_FOLDER_PREFIX}099`);
  });

  it('does not pad three-digit indices', () => {
    expect(photosFolderName(100)).toBe(`${PHOTOS_FOLDER_PREFIX}100`);
    expect(photosFolderName(500)).toBe(`${PHOTOS_FOLDER_PREFIX}500`);
    expect(photosFolderName(999)).toBe(`${PHOTOS_FOLDER_PREFIX}999`);
  });

  it('throws for non-positive or non-finite indices', () => {
    expect(() => photosFolderName(0)).toThrow();
    expect(() => photosFolderName(-1)).toThrow();
    expect(() => photosFolderName(NaN)).toThrow();
    expect(() => photosFolderName(Infinity)).toThrow();
  });

  it('floors fractional indices before padding', () => {
    expect(photosFolderName(1.7)).toBe(`${PHOTOS_FOLDER_PREFIX}001`);
    expect(photosFolderName(42.9)).toBe(`${PHOTOS_FOLDER_PREFIX}042`);
  });
});

// ─── bucketIndexForPosition ──────────────────────────────────────────────────

describe('specialFoldersService — bucketIndexForPosition()', () => {
  const cap = MAX_SHORTCUTS_PER_PHOTOS_FOLDER;

  it('puts position 0 in bucket 1', () => {
    expect(bucketIndexForPosition(0)).toBe(1);
  });

  it('keeps the entire first bucket in bucket 1', () => {
    expect(bucketIndexForPosition(1)).toBe(1);
    expect(bucketIndexForPosition(cap - 1)).toBe(1);
  });

  it('rolls over to bucket 2 at the cap boundary', () => {
    expect(bucketIndexForPosition(cap)).toBe(2);
    expect(bucketIndexForPosition(cap + 1)).toBe(2);
  });

  it('keeps the entire second bucket in bucket 2', () => {
    expect(bucketIndexForPosition(2 * cap - 1)).toBe(2);
  });

  it('rolls over to bucket 3 at the next cap boundary', () => {
    expect(bucketIndexForPosition(2 * cap)).toBe(3);
  });

  it('throws on negative or non-finite positions', () => {
    expect(() => bucketIndexForPosition(-1)).toThrow();
    expect(() => bucketIndexForPosition(NaN)).toThrow();
    expect(() => bucketIndexForPosition(Infinity)).toThrow();
  });
});

// ─── bucketCountForFiles ─────────────────────────────────────────────────────

describe('specialFoldersService — bucketCountForFiles()', () => {
  const cap = MAX_SHORTCUTS_PER_PHOTOS_FOLDER;

  it('returns 0 buckets for 0 files', () => {
    expect(bucketCountForFiles(0)).toBe(0);
  });

  it('returns 0 buckets for negative or non-finite counts', () => {
    expect(bucketCountForFiles(-1)).toBe(0);
    expect(bucketCountForFiles(NaN)).toBe(0);
    expect(bucketCountForFiles(Infinity)).toBe(0);
  });

  it('returns 1 bucket for 1..cap files', () => {
    expect(bucketCountForFiles(1)).toBe(1);
    expect(bucketCountForFiles(cap - 1)).toBe(1);
    expect(bucketCountForFiles(cap)).toBe(1);
  });

  it('returns 2 buckets for cap+1..2*cap files', () => {
    expect(bucketCountForFiles(cap + 1)).toBe(2);
    expect(bucketCountForFiles(2 * cap - 1)).toBe(2);
    expect(bucketCountForFiles(2 * cap)).toBe(2);
  });

  it('returns 3 buckets for 2*cap+1 files', () => {
    expect(bucketCountForFiles(2 * cap + 1)).toBe(3);
  });

  it('matches the bucketIndexForPosition contract at the boundaries', () => {
    // The (last position of bucket N) maps to bucket N, and that count of
    // files should also need exactly N buckets.
    for (const n of [1, 2, 3, 7]) {
      expect(bucketCountForFiles(n * cap)).toBe(n);
      expect(bucketIndexForPosition(n * cap - 1)).toBe(n);
      expect(bucketIndexForPosition(n * cap)).toBe(n + 1);
    }
  });
});

// ─── MIME classification ─────────────────────────────────────────────────────

describe('specialFoldersService — MIME classification', () => {
  describe('isPhotoFile()', () => {
    it('accepts every PhotoMimeType enum value', () => {
      for (const mime of Object.values(PhotoMimeType)) {
        expect(isPhotoFile(mime as string)).toBe(true);
      }
    });

    it('rejects every VideoMimeType enum value', () => {
      for (const mime of Object.values(VideoMimeType)) {
        expect(isPhotoFile(mime as string)).toBe(false);
      }
    });

    it('rejects unrelated MIME types and empty input', () => {
      expect(isPhotoFile('application/pdf')).toBe(false);
      expect(isPhotoFile('text/plain')).toBe(false);
      expect(isPhotoFile('')).toBe(false);
      expect(isPhotoFile('application/vnd.google-apps.shortcut')).toBe(false);
    });
  });

  describe('isVideoFile()', () => {
    it('accepts every VideoMimeType enum value', () => {
      for (const mime of Object.values(VideoMimeType)) {
        expect(isVideoFile(mime as string)).toBe(true);
      }
    });

    it('rejects every PhotoMimeType enum value', () => {
      for (const mime of Object.values(PhotoMimeType)) {
        expect(isVideoFile(mime as string)).toBe(false);
      }
    });

    it('rejects unrelated MIME types', () => {
      expect(isVideoFile('application/pdf')).toBe(false);
      expect(isVideoFile('audio/mpeg')).toBe(false);
      expect(isVideoFile('')).toBe(false);
    });
  });

  describe('isMediaFile()', () => {
    it('accepts every PhotoMimeType AND VideoMimeType enum value', () => {
      for (const mime of Object.values(PhotoMimeType)) {
        expect(isMediaFile(mime as string)).toBe(true);
      }
      for (const mime of Object.values(VideoMimeType)) {
        expect(isMediaFile(mime as string)).toBe(true);
      }
    });

    it('rejects unrelated MIME types and empty input', () => {
      expect(isMediaFile('application/pdf')).toBe(false);
      expect(isMediaFile('audio/mpeg')).toBe(false);
      expect(isMediaFile('')).toBe(false);
    });
  });

  describe('PHOTO/VIDEO target sets', () => {
    it('do not overlap', () => {
      for (const mime of PHOTO_TARGET_MIME_TYPES) {
        expect(VIDEO_TARGET_MIME_TYPES.has(mime)).toBe(false);
      }
      for (const mime of VIDEO_TARGET_MIME_TYPES) {
        expect(PHOTO_TARGET_MIME_TYPES.has(mime)).toBe(false);
      }
    });
  });
});
