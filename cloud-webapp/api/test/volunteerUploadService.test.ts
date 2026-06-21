import { describe, it, expect, vi, beforeEach } from 'vitest';

// Config reads these at import — set before the service (and its config) load.
process.env.MASTER_SPREADSHEET_ID = 'sheet-1';
process.env.VOLUNTEER_STAGING_BUCKET = 'test-staging';
process.env.VOLUNTEER_STAGING_PREFIX = 'vol';

// ── mocks (must precede the service import) ─────────────────────────────────

// Upload_Links rows keyed by the A1 range the service requests.
const sheetData: Record<string, string[][]> = {};
vi.mock('../src/services/sheetsService.js', () => ({
  getSheetValues: async (_spreadsheetId: string, range: string) => sheetData[range] ?? [],
  // The Upload_Log append (appendUploadLog → appendSheetValues) runs after a
  // batch is copied to Drive. Stubbed so the best-effort logging path succeeds
  // quietly instead of hitting its non-fatal catch on a missing mock export.
  appendSheetValues: async (_spreadsheetId: string, _range: string, rows: unknown[][]) =>
    rows.length,
}));

const eventDocs: Record<string, Record<string, unknown> | undefined> = {};
vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: (name: string) => {
      if (name !== 'events') throw new Error(`unexpected collection ${name}`);
      return {
        doc: (id: string) => ({ get: async () => ({ data: () => eventDocs[id] }) }),
      };
    },
  }),
}));

const driveUploads: Array<{ folderId: string; name: string; mimeType: string; size: number }> = [];
// Folder get-or-create calls, in order, so tests can assert the Club/tag/batch path.
const folderCreates: Array<{ parent: string; name: string }> = [];
// Existing Drive files the duplicate-check lists (name + size). Mutated per test.
const existingDriveFiles: Array<{ name: string; size: string }> = [];
vi.mock('../src/services/driveService.js', () => ({
  DRIVE_SCOPE_READWRITE: 'rw-scope',
  getDriveToken: async () => 'drive-token',
  uploadFileToDrive: async (folderId: string, name: string, mimeType: string, bytes: Uint8Array) => {
    driveUploads.push({ folderId, name, mimeType, size: bytes.length });
    return { id: `drive-${name}`, name };
  },
  // Deterministic, traceable folder id: `<parent>><name>` so a test can read the
  // full path back off the upload target.
  getOrCreateSubfolder: async (parent: string, name: string) => {
    folderCreates.push({ parent, name });
    return { id: `${parent}>${name}`, name };
  },
  listEventImages: async () =>
    existingDriveFiles.map((f) => ({ id: `id-${f.name}`, name: f.name, relPath: f.name, mimeType: 'image/jpeg', size: f.size })),
}));

const indexTriggers: string[] = [];
vi.mock('../src/services/indexerJob.js', () => ({
  triggerIndexJob: async (eventId: string) => {
    indexTriggers.push(eventId);
    return { execution: 'exec-1' };
  },
}));

// Staging bucket object fixtures keyed by object name.
interface FakeObj {
  exists: boolean;
  size: number;
  contentType?: string;
  metadata?: Record<string, string>;
}
const objects: Record<string, FakeObj> = {};
const deleted: string[] = [];
vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket(): unknown {
      return {
        file: (objectName: string) => ({
          exists: async () => [objects[objectName]?.exists ?? false],
          getMetadata: async () => [
            {
              size: objects[objectName]?.size,
              contentType: objects[objectName]?.contentType,
              metadata: objects[objectName]?.metadata,
            },
          ],
          download: async () => [Buffer.alloc(objects[objectName]?.size ?? 0)],
          delete: async () => {
            deleted.push(objectName);
            return [undefined];
          },
        }),
      };
    }
  },
}));

const {
  validateUploadLink,
  enqueueStagedBatch,
  stagingExtForMime,
  stagingObjectName,
  UploadLinkError,
} = await import('../src/services/volunteerUploadService.js');

const LINKS_RANGE = 'Upload_Links!A1:K';

function row(linkId: string, eventId: string, club: string, token: string, revokedAt = '', tag = ''): string[] {
  const r = Array(11).fill('');
  r[0] = linkId;
  r[1] = eventId;
  r[2] = club;
  r[3] = token;
  r[7] = revokedAt;
  r[10] = tag;
  return r;
}

beforeEach(() => {
  for (const k of Object.keys(sheetData)) delete sheetData[k];
  for (const k of Object.keys(eventDocs)) delete eventDocs[k];
  for (const k of Object.keys(objects)) delete objects[k];
  driveUploads.length = 0;
  folderCreates.length = 0;
  existingDriveFiles.length = 0;
  indexTriggers.length = 0;
  deleted.length = 0;

  sheetData[LINKS_RANGE] = [
    ['LINK_ID', 'EVENT_ID', 'CLUB_NAME', 'TOKEN', '', '', '', 'REVOKED_AT', '', '', 'TAG'],
    row('link1', 'ev1', 'ClubA', 'tok-good', '', 'tagX'),
    row('link2', 'ev2', 'ClubB', 'tok-revoked', '2026-01-01', 'tagY'),
    row('link3', 'ev3', 'ClubC', 'tok-nofolder', '', 'tagZ'),
    row('link4', 'ev4', 'ClubD', 'tok-notag', '', ''),
  ];
  eventDocs['ev1'] = { name: 'Spring Run', driveFolderId: 'folder-ev1' };
  eventDocs['ev2'] = { name: 'Revoked Event', driveFolderId: 'folder-ev2' };
  eventDocs['ev3'] = { name: 'Unconfigured Event' }; // no driveFolderId
  eventDocs['ev4'] = { name: 'No Tag Event', driveFolderId: 'folder-ev4' };
});

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('stagingExtForMime', () => {
  it('maps known image/video types', () => {
    expect(stagingExtForMime('image/jpeg')).toBe('jpg');
    expect(stagingExtForMime('image/HEIC')).toBe('heic'); // case-insensitive
    expect(stagingExtForMime('video/quicktime')).toBe('mov');
  });
  it('falls back to bin for unknown / missing types', () => {
    expect(stagingExtForMime('application/zip')).toBe('bin');
    expect(stagingExtForMime(undefined)).toBe('bin');
  });
});

describe('stagingObjectName', () => {
  it('builds <prefix>/<eventId>/<batchId>/<uploadId>.<ext>', () => {
    expect(stagingObjectName('ev1', 'batchA', 'uuid-1', 'image/jpeg')).toBe('vol/ev1/batchA/uuid-1.jpg');
  });
});

// ── validateUploadLink ─────────────────────────────────────────────────────

describe('validateUploadLink', () => {
  it('resolves a valid token with event metadata + name', async () => {
    const link = await validateUploadLink('tok-good');
    expect(link).toEqual({
      linkId: 'link1',
      eventId: 'ev1',
      clubName: 'ClubA',
      tag: 'tagX',
      eventName: 'Spring Run',
    });
  });

  it('throws invalid_token for an unknown token', async () => {
    await expect(validateUploadLink('nope')).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('throws revoked when REVOKED_AT is set', async () => {
    await expect(validateUploadLink('tok-revoked')).rejects.toMatchObject({ code: 'revoked' });
  });

  it('still resolves when the event-name lookup fails (non-fatal)', async () => {
    eventDocs['ev1'] = undefined; // get().data() → undefined
    const link = await validateUploadLink('tok-good');
    expect(link.eventId).toBe('ev1');
    expect(link.eventName).toBe('');
  });
});

// ── enqueueStagedBatch ──────────────────────────────────────────────────────

describe('enqueueStagedBatch', () => {
  it('copies into the Event/Club/tag/batch hierarchy with credited names, deletes staged, triggers once', async () => {
    const link = await validateUploadLink('tok-good'); // clubName ClubA, tag tagX
    objects['vol/ev1/b1/u1.jpg'] = {
      exists: true,
      size: 100,
      contentType: 'image/jpeg',
      metadata: { originalName: 'race-001.jpg', photographerName: 'Jane Doe' },
    };
    objects['vol/ev1/b1/u2.jpg'] = {
      exists: true,
      size: 200,
      contentType: 'image/jpeg',
      metadata: { originalName: 'race-002.jpg', photographerName: 'Jane Doe' },
    };

    const res = await enqueueStagedBatch(link, 'b1', ['vol/ev1/b1/u1.jpg', 'vol/ev1/b1/u2.jpg']);

    expect(res).toMatchObject({ copied: 2, skippedDuplicates: 0 });

    // Path built once and reused: Club → tag → batch (one each), batch named from photographer.
    expect(folderCreates).toHaveLength(3);
    expect(folderCreates[0]).toEqual({ parent: 'folder-ev1', name: 'ClubA' });
    expect(folderCreates[1]).toEqual({ parent: 'folder-ev1>ClubA', name: 'tagX' });
    expect(folderCreates[2]?.parent).toBe('folder-ev1>ClubA>tagX');
    expect(folderCreates[2]?.name).toMatch(/^\d{8}-\d{6}_janedoe$/);

    const batchFolderId = `folder-ev1>ClubA>tagX>${folderCreates[2]?.name}`;
    expect(driveUploads).toEqual([
      { folderId: batchFolderId, name: 'ClubA_JaneDoe_race-001.jpg', mimeType: 'image/jpeg', size: 100 },
      { folderId: batchFolderId, name: 'ClubA_JaneDoe_race-002.jpg', mimeType: 'image/jpeg', size: 200 },
    ]);
    expect(deleted.sort()).toEqual(['vol/ev1/b1/u1.jpg', 'vol/ev1/b1/u2.jpg']);
    expect(indexTriggers).toEqual(['ev1']);
  });

  it('substitutes the DEFAULT_TAG (ALL) when the link has no tag', async () => {
    const link = await validateUploadLink('tok-notag'); // ClubD, empty tag
    objects['vol/ev4/bt/u1.jpg'] = { exists: true, size: 10, contentType: 'image/jpeg', metadata: { originalName: 'x.jpg' } };
    await enqueueStagedBatch(link, 'bt', ['vol/ev4/bt/u1.jpg']);
    expect(folderCreates[0]).toEqual({ parent: 'folder-ev4', name: 'ClubD' });
    expect(folderCreates[1]).toEqual({ parent: 'folder-ev4>ClubD', name: 'ALL' });
  });

  it('names the batch folder "volunteer" when no photographer name was given', async () => {
    const link = await validateUploadLink('tok-good');
    objects['vol/ev1/bv/u1.jpg'] = { exists: true, size: 10, contentType: 'image/jpeg', metadata: { originalName: 'x.jpg' } };
    await enqueueStagedBatch(link, 'bv', ['vol/ev1/bv/u1.jpg']);
    expect(folderCreates[2]?.name).toMatch(/^\d{8}-\d{6}_volunteer$/);
  });

  it('creates no folders when every file is a duplicate (no empty batch folder)', async () => {
    const link = await validateUploadLink('tok-good');
    existingDriveFiles.push({ name: 'ClubA_dup.jpg', size: '5' });
    objects['vol/ev1/bz/u1.jpg'] = { exists: true, size: 5, contentType: 'image/jpeg', metadata: { originalName: 'dup.jpg' } };
    const res = await enqueueStagedBatch(link, 'bz', ['vol/ev1/bz/u1.jpg']);
    expect(res).toMatchObject({ copied: 0, skippedDuplicates: 1 });
    expect(folderCreates).toHaveLength(0);
  });

  it('credits with the club-only prefix when no photographer name was stamped', async () => {
    const link = await validateUploadLink('tok-good');
    objects['vol/ev1/bc/u1.jpg'] = { exists: true, size: 10, contentType: 'image/jpeg', metadata: { originalName: 'shot.jpg' } };
    await enqueueStagedBatch(link, 'bc', ['vol/ev1/bc/u1.jpg']);
    expect(driveUploads[0]?.name).toBe('ClubA_shot.jpg');
  });

  it('skips a file already present in the Drive folder (duplicate by credited name + size)', async () => {
    const link = await validateUploadLink('tok-good');
    // The credited name of this upload already exists in Drive at the same size.
    existingDriveFiles.push({ name: 'ClubA_JaneDoe_race-001.jpg', size: '100' });
    objects['vol/ev1/bd/u1.jpg'] = {
      exists: true,
      size: 100,
      contentType: 'image/jpeg',
      metadata: { originalName: 'race-001.jpg', photographerName: 'Jane Doe' },
    };

    const res = await enqueueStagedBatch(link, 'bd', ['vol/ev1/bd/u1.jpg']);

    expect(res).toMatchObject({ copied: 0, skippedDuplicates: 1 });
    expect(driveUploads).toHaveLength(0);
    expect(deleted).toEqual(['vol/ev1/bd/u1.jpg']); // duplicate staged copy cleaned up
    expect(indexTriggers).toHaveLength(0); // nothing copied → no trigger
  });

  it('treats a second identical file within the same batch as a duplicate', async () => {
    const link = await validateUploadLink('tok-good');
    const meta = { originalName: 'dup.jpg', photographerName: 'Jane Doe' };
    objects['vol/ev1/bw/u1.jpg'] = { exists: true, size: 42, contentType: 'image/jpeg', metadata: meta };
    objects['vol/ev1/bw/u2.jpg'] = { exists: true, size: 42, contentType: 'image/jpeg', metadata: meta };

    const res = await enqueueStagedBatch(link, 'bw', ['vol/ev1/bw/u1.jpg', 'vol/ev1/bw/u2.jpg']);

    expect(res).toMatchObject({ copied: 1, skippedDuplicates: 1 });
    // The new per-file skipped list names the duplicate that was skipped.
    expect(res.skippedDuplicateNames).toEqual(['ClubA_JaneDoe_dup.jpg']);
    expect(driveUploads).toHaveLength(1);
    expect(driveUploads[0]?.name).toBe('ClubA_JaneDoe_dup.jpg');
  });

  it('is not fooled by a same-name file of a different size', async () => {
    const link = await validateUploadLink('tok-good');
    existingDriveFiles.push({ name: 'ClubA_JaneDoe_race-001.jpg', size: '999' }); // different size
    objects['vol/ev1/bs/u1.jpg'] = {
      exists: true,
      size: 100,
      contentType: 'image/jpeg',
      metadata: { originalName: 'race-001.jpg', photographerName: 'Jane Doe' },
    };
    const res = await enqueueStagedBatch(link, 'bs', ['vol/ev1/bs/u1.jpg']);
    expect(res).toMatchObject({ copied: 1, skippedDuplicates: 0 });
  });

  it('skips missing and empty objects without failing the batch', async () => {
    const link = await validateUploadLink('tok-good');
    objects['vol/ev1/b2/good.jpg'] = { exists: true, size: 50, contentType: 'image/jpeg', metadata: { originalName: 'ok.jpg' } };
    objects['vol/ev1/b2/empty.jpg'] = { exists: true, size: 0, contentType: 'image/jpeg' };
    // 'vol/ev1/b2/missing.jpg' is never registered → exists() false.

    const res = await enqueueStagedBatch(link, 'b2', [
      'vol/ev1/b2/good.jpg',
      'vol/ev1/b2/empty.jpg',
      'vol/ev1/b2/missing.jpg',
    ]);

    expect(res).toMatchObject({ copied: 1, skippedDuplicates: 0 });
    expect(driveUploads).toHaveLength(1);
    expect(driveUploads[0]?.name).toBe('ClubA_ok.jpg');
    expect(indexTriggers).toEqual(['ev1']);
  });

  it('falls back to the object basename (credited) when originalName metadata is absent', async () => {
    const link = await validateUploadLink('tok-good');
    objects['vol/ev1/b3/u9.png'] = { exists: true, size: 10, contentType: 'image/png' };
    await enqueueStagedBatch(link, 'b3', ['vol/ev1/b3/u9.png']);
    expect(driveUploads[0]?.name).toBe('ClubA_u9.png');
  });

  it('does not trigger the indexer when nothing was copied', async () => {
    const link = await validateUploadLink('tok-good');
    const res = await enqueueStagedBatch(link, 'b4', ['vol/ev1/b4/missing.jpg']);
    expect(res).toMatchObject({ copied: 0, skippedDuplicates: 0 });
    expect(driveUploads).toHaveLength(0);
    expect(indexTriggers).toHaveLength(0);
  });

  it('returns zero counts for an empty batch without touching Drive', async () => {
    const link = await validateUploadLink('tok-good');
    expect(await enqueueStagedBatch(link, 'b5', [])).toMatchObject({ copied: 0, skippedDuplicates: 0 });
    expect(driveUploads).toHaveLength(0);
  });

  it('throws not_configured when the event has no Drive folder', async () => {
    const link = await validateUploadLink('tok-nofolder');
    await expect(enqueueStagedBatch(link, 'b6', ['vol/ev3/b6/u1.jpg'])).rejects.toBeInstanceOf(UploadLinkError);
    await expect(enqueueStagedBatch(link, 'b6', ['vol/ev3/b6/u1.jpg'])).rejects.toMatchObject({
      code: 'not_configured',
    });
  });
});
