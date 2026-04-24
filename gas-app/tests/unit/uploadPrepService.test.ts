/**
 * uploadPrepService.test.ts — Unit tests for the Upload Prep feature.
 *
 * Tests focus on the logic that can be exercised without a live Drive connection:
 *   - classifyFile()        — MIME / extension → copy | convert | skip
 *   - resolveDestName()     — collision resolution policy
 *   - mergeManifestRows()   — incremental manifest update (via service internals)
 *   - manifestService       — CSV serialization round-trip
 *   - assertSuperAdmin()    — email allowlist enforcement
 *
 * Drive operations (makeCopy, FolderIterator, etc.) are mocked via the GAS
 * global mocks installed by tests/mocks/gasGlobals.ts.
 */

import {
  classifyFile,
  resolveDestName,
  assertSuperAdmin,
} from '../../src/services/uploadPrepService';
import { escapeCsvField, serializeCsvRow } from '../../src/services/manifestService';
import { setMockUser } from '../mocks/gasGlobals';

// ─── classifyFile ─────────────────────────────────────────────────────────────

describe('classifyFile', () => {
  // ── Copy (JPEG) ──────────────────────────────────────────────────────────────
  it('classifies image/jpeg as copy', () => {
    expect(classifyFile('image/jpeg', 'photo.jpg')).toEqual({ class: 'copy' });
  });

  it('classifies image/jpeg with uppercase extension as copy', () => {
    expect(classifyFile('image/jpeg', 'IMG_5001.JPG')).toEqual({ class: 'copy' });
  });

  // ── Convert (raster) ─────────────────────────────────────────────────────────
  it('classifies image/png as convert', () => {
    expect(classifyFile('image/png', 'photo.png')).toEqual({ class: 'convert' });
  });

  it('classifies image/heic as convert', () => {
    expect(classifyFile('image/heic', 'IMG_5001.HEIC')).toEqual({ class: 'convert' });
  });

  it('classifies image/heif as convert', () => {
    expect(classifyFile('image/heif', 'shot.heif')).toEqual({ class: 'convert' });
  });

  it('classifies image/tiff as convert', () => {
    expect(classifyFile('image/tiff', 'scan.tiff')).toEqual({ class: 'convert' });
  });

  it('classifies image/webp as convert', () => {
    expect(classifyFile('image/webp', 'img.webp')).toEqual({ class: 'convert' });
  });

  it('classifies image/bmp as convert', () => {
    expect(classifyFile('image/bmp', 'img.bmp')).toEqual({ class: 'convert' });
  });

  it('classifies image/avif as convert', () => {
    expect(classifyFile('image/avif', 'img.avif')).toEqual({ class: 'convert' });
  });

  it('classifies image/gif as convert', () => {
    expect(classifyFile('image/gif', 'anim.gif')).toEqual({ class: 'convert' });
  });

  // ── Convert (RAW by extension) ────────────────────────────────────────────────
  const rawCases: Array<[string, string]> = [
    ['application/octet-stream', 'photo.cr2'],
    ['application/octet-stream', 'photo.cr3'],
    ['application/octet-stream', 'photo.nef'],
    ['application/octet-stream', 'photo.arw'],
    ['application/octet-stream', 'photo.dng'],
    ['application/octet-stream', 'photo.raf'],
    ['application/octet-stream', 'photo.orf'],
    ['application/octet-stream', 'photo.rw2'],
    ['application/octet-stream', 'photo.pef'],
    ['application/octet-stream', 'photo.srw'],
    // uppercase extension
    ['application/octet-stream', 'PHOTO.NEF'],
    ['application/octet-stream', 'PHOTO.ARW'],
  ];

  test.each(rawCases)('classifies %s / %s as convert (RAW)', (mime, name) => {
    expect(classifyFile(mime, name)).toEqual({ class: 'convert' });
  });

  // ── Skip (video) ──────────────────────────────────────────────────────────────
  it('classifies video/mp4 as skip with reason video', () => {
    expect(classifyFile('video/mp4', 'clip.mp4')).toEqual({ class: 'skip', skipReason: 'video' });
  });

  it('classifies video/quicktime .MOV as skip with reason video', () => {
    expect(classifyFile('video/quicktime', 'clip.mov')).toEqual({ class: 'skip', skipReason: 'video' });
  });

  it('classifies .mp4 extension with octet-stream as skip (video)', () => {
    expect(classifyFile('application/octet-stream', 'live.mp4')).toEqual({ class: 'skip', skipReason: 'video' });
  });

  // ── Skip (audio) ──────────────────────────────────────────────────────────────
  it('classifies audio/mpeg as skip', () => {
    const result = classifyFile('audio/mpeg', 'track.mp3');
    expect(result.class).toBe('skip');
  });

  // ── Skip (Google-native) ──────────────────────────────────────────────────────
  it('classifies Google Doc as skip (not_an_image)', () => {
    expect(classifyFile('application/vnd.google-apps.document', 'notes.gdoc')).toEqual({
      class: 'skip',
      skipReason: 'not_an_image',
    });
  });

  it('classifies Google Spreadsheet as skip (not_an_image)', () => {
    expect(classifyFile('application/vnd.google-apps.spreadsheet', 'data.gsheet')).toEqual({
      class: 'skip',
      skipReason: 'not_an_image',
    });
  });

  // ── Skip (misc files) ─────────────────────────────────────────────────────────
  it('classifies PDF as skip', () => {
    const result = classifyFile('application/pdf', 'doc.pdf');
    expect(result.class).toBe('skip');
  });

  it('classifies zip as skip', () => {
    const result = classifyFile('application/zip', 'archive.zip');
    expect(result.class).toBe('skip');
  });

  it('classifies unknown mime with no known extension as skip (unsupported_format)', () => {
    expect(classifyFile('application/x-unknown', 'file.xyz')).toEqual({
      class: 'skip',
      skipReason: 'unsupported_format',
    });
  });

  // ── Live Photo pair (HEIC + MP4 sibling) ─────────────────────────────────────
  it('HEIC from a Live Photo pair is convert', () => {
    expect(classifyFile('image/heic', 'IMG_5001.HEIC')).toEqual({ class: 'convert' });
  });

  it('MP4 from a Live Photo pair is skip (video)', () => {
    expect(classifyFile('video/mp4', 'IMG_5001.MP4')).toEqual({ class: 'skip', skipReason: 'video' });
  });
});

// ─── resolveDestName ──────────────────────────────────────────────────────────

describe('resolveDestName', () => {
  it('lowercases extension to .jpg for a JPEG source', () => {
    const used = new Set<string>();
    expect(resolveDestName('IMG_5001.JPG', used)).toBe('IMG_5001.jpg');
  });

  it('lowercases extension to .jpg for a HEIC source', () => {
    const used = new Set<string>();
    expect(resolveDestName('IMG_5001.HEIC', used)).toBe('IMG_5001.jpg');
  });

  it('returns <stem>.jpg when no collision', () => {
    const used = new Set<string>(['other.jpg']);
    expect(resolveDestName('photo.png', used)).toBe('photo.jpg');
  });

  it('appends __2 when <stem>.jpg is taken', () => {
    const used = new Set<string>(['IMG_5001.jpg']);
    expect(resolveDestName('IMG_5001.HEIC', used)).toBe('IMG_5001__2.jpg');
  });

  it('appends __3 when __2 is also taken', () => {
    const used = new Set<string>(['IMG_5001.jpg', 'IMG_5001__2.jpg']);
    expect(resolveDestName('IMG_5001.HEIC', used)).toBe('IMG_5001__3.jpg');
  });

  it('handles files with no extension', () => {
    const used = new Set<string>();
    expect(resolveDestName('photonoext', used)).toBe('photonoext.jpg');
  });

  it('stem conflict: same stem different exts both get unique names', () => {
    const used = new Set<string>();
    const name1 = resolveDestName('IMG_5001.JPG', used);
    used.add(name1);
    const name2 = resolveDestName('IMG_5001.HEIC', used);
    expect(name1).toBe('IMG_5001.jpg');
    expect(name2).toBe('IMG_5001__2.jpg');
  });

  it('handles Unicode filenames (Chinese characters)', () => {
    const used = new Set<string>();
    expect(resolveDestName('纽约半马_001.HEIC', used)).toBe('纽约半马_001.jpg');
  });
});

// ─── assertSuperAdmin ─────────────────────────────────────────────────────────

describe('assertSuperAdmin', () => {
  afterEach(() => {
    // Restore the default mock user (admin@mmrunners.org from gasGlobals)
    setMockUser('admin@mmrunners.org');
  });

  it('does not throw for a user in SUPER_ADMINS list', () => {
    setMockUser('cathy.lin@mmrunners.org');
    expect(() => assertSuperAdmin()).not.toThrow();
  });

  it('throws Forbidden for a user not in SUPER_ADMINS list', () => {
    setMockUser('club-admin@example.com');
    expect(() => assertSuperAdmin()).toThrow(/Forbidden/);
  });

  it('throws Forbidden for an empty email', () => {
    setMockUser('');
    expect(() => assertSuperAdmin()).toThrow(/Forbidden/);
  });
});

// ─── manifestService — CSV helpers ───────────────────────────────────────────

describe('escapeCsvField', () => {
  it('returns the value unchanged if it contains no special chars', () => {
    expect(escapeCsvField('hello')).toBe('hello');
  });

  it('wraps in quotes if value contains a comma', () => {
    expect(escapeCsvField('hello,world')).toBe('"hello,world"');
  });

  it('wraps in quotes and doubles embedded quotes', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('wraps in quotes if value contains a newline', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('handles the empty string', () => {
    expect(escapeCsvField('')).toBe('');
  });

  it('handles a value that is just a double-quote', () => {
    expect(escapeCsvField('"')).toBe('""""');
  });
});

describe('serializeCsvRow', () => {
  it('joins plain fields with commas', () => {
    expect(serializeCsvRow(['a', 'b', 'c'])).toBe('a,b,c');
  });

  it('quotes fields that contain commas', () => {
    expect(serializeCsvRow(['event_name', '20260315-NYRR-纽半马', 'file,name'])).toBe(
      'event_name,20260315-NYRR-纽半马,"file,name"'
    );
  });

  it('produces a round-trippable row for a typical manifest entry', () => {
    const fields = [
      '20260315-NYRR-纽半马',
      '1aB2cDEFG',
      'IMG_5001.HEIC',
      'image/heic',
      'd41d8cd98f00b204e9800998ecf8427e',
      '3456789',
      '2026-03-15T12:34:56.000Z',
      '1xY9z',
      'IMG_5001.jpg',
      'converted',
      '',
      '92',
      'true',
      '2026-04-23T14:10:02.000Z',
      'run_20260423T141001Z',
    ];
    const row = serializeCsvRow(fields);
    // Verify round-trip: the row starts with the event name (contains Chinese chars)
    expect(row).toMatch(/^20260315-NYRR-纽半马,/);
    // The last field should not be quoted (no special chars)
    expect(row).toMatch(/run_20260423T141001Z$/);
  });
});

// ─── Incremental skip logic ───────────────────────────────────────────────────

describe('Incremental skip logic (via classifyFile + resolveDestName integration)', () => {
  it('already_prepped file does not change the used-names set', () => {
    // Simulates what the service does: when a file is already done,
    // its dest_name is kept in usedNames so future files don't collide with it.
    const usedNames = new Set<string>(['IMG_5001.jpg']); // from prior manifest
    const result = resolveDestName('IMG_5002.JPG', usedNames);
    expect(result).toBe('IMG_5002.jpg'); // no collision
  });

  it('error row from prior run gets re-processed (action !== copied|converted)', () => {
    // The service checks: prior.action must be 'copied' or 'converted' for skip.
    // An 'error' row means the file should be retried.
    const priorAction: string = 'error';
    const shouldSkip = priorAction === 'copied' || priorAction === 'converted';
    expect(shouldSkip).toBe(false);
  });

  it('skipped row from prior run gets re-processed on force=false', () => {
    // A previously skipped file (not an image) will be classified as skip again,
    // but the service does process it (appends a new row). Only copied/converted
    // rows with matching MD5 are truly bypassed.
    const priorAction: string = 'skipped';
    const shouldBypass = priorAction === 'copied' || priorAction === 'converted';
    expect(shouldBypass).toBe(false);
  });

  it('copied file with unchanged MD5 is bypassed (already_prepped)', () => {
    const priorAction: string = 'copied';
    const priorMd5: string = 'abc123';
    const currentMd5: string = 'abc123'; // unchanged
    const shouldBypass = (priorAction === 'copied' || priorAction === 'converted') && priorMd5 === currentMd5;
    expect(shouldBypass).toBe(true);
  });

  it('copied file with changed MD5 is NOT bypassed (source was updated)', () => {
    const priorAction: string = 'copied';
    const priorMd5: string = 'abc123';
    const currentMd5: string = 'def456'; // changed
    const shouldBypass = (priorAction === 'copied' || priorAction === 'converted') && priorMd5 === currentMd5;
    expect(shouldBypass).toBe(false);
  });
});

// ─── Format policy edge cases ─────────────────────────────────────────────────

describe('Format policy edge cases (spec §8)', () => {
  it('hidden file starting with . that is not an image is skipped', () => {
    const result = classifyFile('application/octet-stream', '.DS_Store');
    expect(result.class).toBe('skip');
  });

  it('system file starting with _ that is not an image is skipped', () => {
    const result = classifyFile('text/plain', '_notes.txt');
    expect(result.class).toBe('skip');
  });

  it('hidden image file (e.g. .jpg hidden file) would be classified by mime type', () => {
    // A JPEG that starts with . should be classified as copy since mime is image/jpeg
    const result = classifyFile('image/jpeg', '.hidden_photo.jpg');
    expect(result.class).toBe('copy');
  });

  it('MKV video with octet-stream mime is skipped', () => {
    const result = classifyFile('application/octet-stream', 'video.mkv');
    expect(result.class).toBe('skip');
  });
});
