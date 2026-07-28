import { describe, it, expect, vi, beforeEach } from 'vitest';

// Config reads these at import — set before the service (and its config) load.
process.env.MASTER_SPREADSHEET_ID = 'sheet-1';
process.env.VOLUNTEER_STAGING_BUCKET = 'test-staging';
process.env.VOLUNTEER_STAGING_PREFIX = 'vol';

// ── mocks (must precede the service import) ─────────────────────────────────

// Upload_Links rows keyed by the A1 range the service requests.
const sheetData: Record<string, string[][]> = {};
// Per-range read counter so a test can assert the service caches the tab
// instead of re-reading it on every validateUploadLink call.
const sheetReads: Record<string, number> = {};
vi.mock('../src/services/sheetsService.js', () => ({
  getSheetValues: async (_spreadsheetId: string, range: string) => {
    sheetReads[range] = (sheetReads[range] ?? 0) + 1;
    return sheetData[range] ?? [];
  },
  // The Upload_Log append (appendUploadLog → appendSheetValues) runs after a
  // batch is copied to Drive. Stubbed so the best-effort logging path succeeds
  // quietly instead of hitting its non-fatal catch on a missing mock export.
  appendSheetValues: async (_spreadsheetId: string, _range: string, rows: unknown[][]) =>
    rows.length,
}));

const eventDocs: Record<string, Record<string, unknown> | undefined> = {};
// Backing store for the `upload_dedup` claim collection. `create()` rejects with
// the gRPC ALREADY_EXISTS code when the doc is present, exactly as Firestore
// does — that atomicity is the whole point of the claim, so the double has to
// model it rather than just recording writes.
const dedupDocs = new Map<string, Record<string, unknown>>();
vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: (name: string) => {
      if (name === 'upload_dedup') {
        return {
          doc: (id: string) => ({
            __id: id,
            create: async (data: Record<string, unknown>) => {
              if (dedupDocs.has(id)) {
                throw Object.assign(new Error('6 ALREADY_EXISTS: entity already exists'), { code: 6 });
              }
              dedupDocs.set(id, data);
            },
            set: async (data: Record<string, unknown>) =>
              dedupDocs.set(id, { ...dedupDocs.get(id), ...data }),
            delete: async () => dedupDocs.delete(id),
          }),
          where: (field: string, _op: string, value: unknown) => ({
            get: async () => {
              const hits = [...dedupDocs.entries()].filter(([, d]) => d[field] === value);
              return {
                size: hits.length,
                docs: hits.map(([id]) => ({ ref: { delete: async () => dedupDocs.delete(id) } })),
              };
            },
          }),
        };
      }
      if (name === 'upload_batches') {
        return {
          doc: (id: string) => ({
            get: async () => ({ exists: batchDocs.has(id), data: () => batchDocs.get(id) }),
            set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
              batchWrites.push({ id, ...data });
              batchDocs.set(id, opts?.merge ? { ...batchDocs.get(id), ...data } : data);
            },
          }),
        };
      }
      if (name !== 'events') throw new Error(`unexpected collection ${name}`);
      return {
        doc: (id: string) => ({ get: async () => ({ data: () => eventDocs[id] }) }),
      };
    },
    // The stale-claim reclaim reads the existing claim in a transaction. Modelled
    // here so an ALREADY_EXISTS in these tests resolves through the real code
    // path (fresh claim → still a duplicate) rather than through its fail-closed
    // catch, which would give the right answer for the wrong reason.
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        get: async (ref: { __id: string }) => ({
          exists: dedupDocs.has(ref.__id),
          data: () => dedupDocs.get(ref.__id),
        }),
        update: (ref: { __id: string }, patch: Record<string, unknown>) =>
          void dedupDocs.set(ref.__id, { ...dedupDocs.get(ref.__id), ...patch }),
      }),
  }),
}));

// `upload_batches/{batchId}` docs + every write in order, so a test can assert
// the batch folder name is persisted BEFORE the terminal phase write (a run that
// is killed mid-copy only leaves the early write behind).
const batchDocs = new Map<string, Record<string, unknown>>();
const batchWrites: Array<Record<string, unknown>> = [];
// Drive files indexed by their `uploadDedupKey` appProperty — the tag a retry
// searches for to recognise a copy an earlier, dead attempt already wrote.
const appPropFiles = new Map<string, { id: string; name: string }>();
const appPropLookups: string[] = [];
// Credited names whose Drive write should throw, to exercise the failure paths.
const failUploadsFor = new Set<string>();

const driveUploads: Array<{ folderId: string; name: string; mimeType: string; size: number; appProperties?: Record<string, string> }> = [];
// Chunked resumable uploads (large files), with how many chunks were pulled.
const resumableUploads: Array<{ folderId: string; name: string; mimeType: string; size: number; chunks: number; appProperties?: Record<string, string> }> = [];
// Folder get-or-create calls, in order, so tests can assert the Club/tag/batch path.
const folderCreates: Array<{ parent: string; name: string }> = [];
// Existing Drive files the duplicate-check lists. `md5Checksum` is the primary
// dedup key; name/size is only the fallback for a file Drive didn't hash.
const existingDriveFiles: Array<{ name: string; size: string; md5Checksum?: string }> = [];
vi.mock('../src/services/driveService.js', () => ({
  DRIVE_SCOPE_READWRITE: 'rw-scope',
  getDriveToken: async () => 'drive-token',
  uploadFileToDrive: async (
    folderId: string,
    name: string,
    mimeType: string,
    bytes: Uint8Array,
    opts?: { appProperties?: Record<string, string> },
  ) => {
    if (failUploadsFor.has(name)) throw new Error('Drive upload 500: boom');
    driveUploads.push({ folderId, name, mimeType, size: bytes.length, ...(opts?.appProperties ? { appProperties: opts.appProperties } : {}) });
    return { id: `drive-${name}`, name };
  },
  findFileByAppProperty: async (_key: string, value: string) => {
    appPropLookups.push(value);
    return appPropFiles.get(value) ?? null;
  },
  // Drains readChunk like the real resumable protocol so the ranged-download
  // path is exercised and the byte count can be asserted.
  uploadFileToDriveResumable: async (
    folderId: string,
    name: string,
    mimeType: string,
    totalBytes: number,
    readChunk: (start: number, end: number) => Promise<Uint8Array>,
    opts?: { appProperties?: Record<string, string> },
  ) => {
    if (failUploadsFor.has(name)) throw new Error('Drive resumable 500: boom');
    const CHUNK = 32 * 1024 * 1024;
    let offset = 0;
    let received = 0;
    let chunks = 0;
    while (offset < totalBytes) {
      const end = Math.min(offset + CHUNK, totalBytes) - 1;
      received += (await readChunk(offset, end)).length;
      offset = end + 1;
      chunks += 1;
    }
    resumableUploads.push({ folderId, name, mimeType, size: received, chunks, ...(opts?.appProperties ? { appProperties: opts.appProperties } : {}) });
    return { id: `drive-${name}`, name };
  },
  // Deterministic, traceable folder id: `<parent>><name>` so a test can read the
  // full path back off the upload target.
  getOrCreateSubfolder: async (parent: string, name: string) => {
    folderCreates.push({ parent, name });
    return { id: `${parent}>${name}`, name };
  },
  listEventImages: async () =>
    existingDriveFiles.map((f) => ({
      id: `id-${f.name}`,
      name: f.name,
      relPath: f.name,
      mimeType: 'image/jpeg',
      size: f.size,
      ...(f.md5Checksum === undefined ? {} : { md5Checksum: f.md5Checksum }),
    })),
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
  /** GCS reports MD5 base64-encoded; the service converts it to Drive's hex. */
  md5Hash?: string;
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
              md5Hash: objects[objectName]?.md5Hash,
            },
          ],
          download: async (opts?: { start?: number; end?: number }) => {
            const size = objects[objectName]?.size ?? 0;
            const start = opts?.start ?? 0;
            const end = Math.min(opts?.end ?? size - 1, size - 1);
            return [Buffer.alloc(Math.max(0, end - start + 1))];
          },
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
  __clearUploadLinksCache,
} = await import('../src/services/volunteerUploadService.js');
// Real (unmocked) — tests seed claim docs under the same ids the service uses.
const { claimId } = await import('../src/services/uploadDedupService.js');

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
  __clearUploadLinksCache();
  for (const k of Object.keys(sheetData)) delete sheetData[k];
  for (const k of Object.keys(sheetReads)) delete sheetReads[k];
  for (const k of Object.keys(eventDocs)) delete eventDocs[k];
  for (const k of Object.keys(objects)) delete objects[k];
  driveUploads.length = 0;
  resumableUploads.length = 0;
  folderCreates.length = 0;
  existingDriveFiles.length = 0;
  indexTriggers.length = 0;
  deleted.length = 0;
  dedupDocs.clear();
  batchDocs.clear();
  batchWrites.length = 0;
  appPropFiles.clear();
  appPropLookups.length = 0;
  failUploadsFor.clear();

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

  it('reads the Upload_Links tab once across many validate calls (quota guard)', async () => {
    // Simulate a batch: one /session (→ validateUploadLink) per file, plus a
    // few invalid-token probes. All must share a single cached Sheet read so a
    // big batch can't blow the 60 reads/min/user Sheets quota.
    for (let i = 0; i < 25; i++) await validateUploadLink('tok-good');
    await expect(validateUploadLink('nope')).rejects.toMatchObject({ code: 'invalid_token' });
    expect(sheetReads[LINKS_RANGE]).toBe(1);
  });

  it('re-reads after the cache is cleared', async () => {
    await validateUploadLink('tok-good');
    expect(sheetReads[LINKS_RANGE]).toBe(1);
    __clearUploadLinksCache();
    await validateUploadLink('tok-good');
    expect(sheetReads[LINKS_RANGE]).toBe(2);
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
    // Every copy carries its dedup tag, stamped in the same request as the bytes,
    // so a later attempt can find it instead of writing a second copy.
    expect(driveUploads).toEqual([
      {
        folderId: batchFolderId,
        name: 'ClubA_JaneDoe_race-001.jpg',
        mimeType: 'image/jpeg',
        size: 100,
        appProperties: { uploadDedupKey: claimId('ev1', 'cluba_janedoe_race-001.jpg|100') },
      },
      {
        folderId: batchFolderId,
        name: 'ClubA_JaneDoe_race-002.jpg',
        mimeType: 'image/jpeg',
        size: 200,
        appProperties: { uploadDedupKey: claimId('ev1', 'cluba_janedoe_race-002.jpg|200') },
      },
    ]);
    expect(deleted.sort()).toEqual(['vol/ev1/b1/u1.jpg', 'vol/ev1/b1/u2.jpg']);
    expect(indexTriggers).toEqual(['ev1']);
  });

  it('copies a large video via the chunked resumable path (never buffered whole)', async () => {
    const link = await validateUploadLink('tok-good');
    const size = 70 * 1024 * 1024; // > INLINE_COPY_MAX_BYTES (64 MiB) → 3 × 32 MiB chunks
    objects['vol/ev1/bv/u1.mp4'] = {
      exists: true,
      size,
      contentType: 'video/mp4',
      metadata: { originalName: 'finish-line.mp4', photographerName: 'Jane Doe' },
    };

    const res = await enqueueStagedBatch(link, 'bv', ['vol/ev1/bv/u1.mp4']);

    expect(res).toMatchObject({ copied: 1, skippedDuplicates: 0 });
    expect(driveUploads).toHaveLength(0); // buffered path not used
    expect(resumableUploads).toHaveLength(1);
    expect(resumableUploads[0]).toMatchObject({
      name: 'ClubA_JaneDoe_finish-line.mp4',
      mimeType: 'video/mp4',
      size,
      chunks: 3,
    });
    expect(deleted).toEqual(['vol/ev1/bv/u1.mp4']);
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

  // ── Content-hash dedup ────────────────────────────────────────────────────
  // MD5, not name+size, is the duplicate key. name+size quietly stopped working
  // once the capture-time rename shipped: stored files gained a
  // `YYYYMMDD-HHMMSS_` prefix that a fresh upload's credited name never has.
  // One real event accumulated 982 redundant Drive files this way.

  // base64("\x01\x02...") stand-ins — only equality matters, not the real digest.
  const MD5_A = Buffer.from('a'.repeat(16), 'binary').toString('base64');
  const MD5_B = Buffer.from('b'.repeat(16), 'binary').toString('base64');
  const HEX_A = Buffer.from(MD5_A, 'base64').toString('hex');

  it('skips a re-upload whose Drive copy was RENAMED by the capture-time prefix', async () => {
    const link = await validateUploadLink('tok-good');
    // Same bytes, but Drive now stores it under the prefixed name. The old
    // name+size key could never match this; the hash does.
    existingDriveFiles.push({
      name: '20260726-075713_ClubA_JaneDoe_race-001.jpg',
      size: '100',
      md5Checksum: HEX_A,
    });
    objects['vol/ev1/bh1/u1.jpg'] = {
      exists: true,
      size: 100,
      contentType: 'image/jpeg',
      md5Hash: MD5_A,
      metadata: { originalName: 'race-001.jpg', photographerName: 'Jane Doe' },
    };

    const res = await enqueueStagedBatch(link, 'bh1', ['vol/ev1/bh1/u1.jpg']);

    expect(res).toMatchObject({ copied: 0, skippedDuplicates: 1 });
    expect(driveUploads).toHaveLength(0);
  });

  it('skips the same bytes credited to a DIFFERENT photographer', async () => {
    const link = await validateUploadLink('tok-good');
    existingDriveFiles.push({ name: 'ClubA_JaneDoe_race-001.jpg', size: '100', md5Checksum: HEX_A });
    objects['vol/ev1/bh2/u1.jpg'] = {
      exists: true,
      size: 100,
      contentType: 'image/jpeg',
      md5Hash: MD5_A,
      metadata: { originalName: 'race-001.jpg', photographerName: 'Someone Else' },
    };

    const res = await enqueueStagedBatch(link, 'bh2', ['vol/ev1/bh2/u1.jpg']);
    expect(res).toMatchObject({ copied: 0, skippedDuplicates: 1 });
  });

  it('still copies genuinely different bytes that happen to share a name and size', async () => {
    const link = await validateUploadLink('tok-good');
    existingDriveFiles.push({ name: 'ClubA_JaneDoe_race-001.jpg', size: '100', md5Checksum: HEX_A });
    objects['vol/ev1/bh3/u1.jpg'] = {
      exists: true,
      size: 100,
      contentType: 'image/jpeg',
      md5Hash: MD5_B, // different photo, same name+size
      metadata: { originalName: 'race-001.jpg', photographerName: 'Jane Doe' },
    };

    const res = await enqueueStagedBatch(link, 'bh3', ['vol/ev1/bh3/u1.jpg']);
    expect(res).toMatchObject({ copied: 1, skippedDuplicates: 0 });
  });

  // ── Cross-batch claim ─────────────────────────────────────────────────────
  // The listing snapshot is taken once per batch, so a batch cannot see what a
  // CONCURRENT batch for the same event is writing. `existingDriveFiles` models
  // that faithfully: uploads never appear in it, so a second batch runs against
  // exactly the stale view a racing worker would have. One photographer's five
  // overlapping sessions duplicated their overlap this way.

  it('skips a photo a concurrent batch already claimed, despite a stale snapshot', async () => {
    const link = await validateUploadLink('tok-good');
    const staged = (batch: string) => ({
      exists: true,
      size: 100,
      contentType: 'image/jpeg',
      md5Hash: MD5_A,
      metadata: { originalName: `race-001.jpg`, photographerName: 'Jane Doe' },
      _batch: batch,
    });
    objects['vol/ev1/bc1/u1.jpg'] = staged('bc1');
    objects['vol/ev1/bc2/u1.jpg'] = staged('bc2');

    const first = await enqueueStagedBatch(link, 'bc1', ['vol/ev1/bc1/u1.jpg']);
    // Deliberately do NOT add the copy to existingDriveFiles — the second batch
    // sees the same pre-upload listing a concurrent worker would.
    const second = await enqueueStagedBatch(link, 'bc2', ['vol/ev1/bc2/u1.jpg']);

    expect(first).toMatchObject({ copied: 1, skippedDuplicates: 0 });
    expect(second).toMatchObject({ copied: 0, skippedDuplicates: 1 });
    expect(driveUploads).toHaveLength(1);
  });

  it('KEEPS the staged bytes when the skip is an unconfirmed claim', async () => {
    // THE 9-PHOTO BUG. A request killed mid-copy leaves a claim with no
    // driveFileId (no catch block runs on a kill). The retry then read that
    // corpse as "duplicate", skipped the file AND DELETED THE STAGED OBJECT —
    // destroying the only copy of bytes that never reached Drive.
    const link = await validateUploadLink('tok-good');
    // A claim exists for these bytes but was never stamped: nothing in Drive.
    dedupDocs.set(claimId('ev1', HEX_A), {
      eventId: 'ev1',
      dedupKey: HEX_A,
      name: 'race-001.jpg',
      batchId: 'killed-batch',
      claimedAt: new Date(), // fresh, so the stale-reclaim does not apply
    });
    objects['vol/ev1/uc/u1.jpg'] = {
      exists: true,
      size: 100,
      contentType: 'image/jpeg',
      md5Hash: MD5_A,
      metadata: { originalName: 'race-001.jpg', photographerName: 'Jane Doe' },
    };

    const res = await enqueueStagedBatch(link, 'uc', ['vol/ev1/uc/u1.jpg']);

    expect(res).toMatchObject({ copied: 0, skippedDuplicates: 1 });
    // Skipped, yes — but the bytes MUST still be there for recovery.
    expect(deleted).toEqual([]);
  });

  it('deletes the staged bytes when the duplicate IS confirmed in Drive', async () => {
    // The counterpart: a claim stamped with a driveFileId proves the bytes
    // landed, so the staged copy is genuinely redundant.
    const link = await validateUploadLink('tok-good');
    dedupDocs.set(claimId('ev1', HEX_A), {
      eventId: 'ev1',
      dedupKey: HEX_A,
      name: 'race-001.jpg',
      batchId: 'done-batch',
      claimedAt: new Date(),
      driveFileId: 'drive-1',
    });
    objects['vol/ev1/cf/u1.jpg'] = {
      exists: true,
      size: 100,
      contentType: 'image/jpeg',
      md5Hash: MD5_A,
      metadata: { originalName: 'race-001.jpg', photographerName: 'Jane Doe' },
    };

    const res = await enqueueStagedBatch(link, 'cf', ['vol/ev1/cf/u1.jpg']);

    expect(res).toMatchObject({ copied: 0, skippedDuplicates: 1 });
    expect(deleted).toEqual(['vol/ev1/cf/u1.jpg']);
  });

  it('lets exactly one of two genuinely concurrent batches copy the same photo', async () => {
    const link = await validateUploadLink('tok-good');
    for (const b of ['cc1', 'cc2', 'cc3']) {
      objects[`vol/ev1/${b}/u1.jpg`] = {
        exists: true,
        size: 100,
        contentType: 'image/jpeg',
        md5Hash: MD5_A,
        metadata: { originalName: 'race-001.jpg', photographerName: 'Jane Doe' },
      };
    }

    const results = await Promise.all(
      ['cc1', 'cc2', 'cc3'].map((b) => enqueueStagedBatch(link, b, [`vol/ev1/${b}/u1.jpg`])),
    );

    expect(results.reduce((n, r) => n + r.copied, 0)).toBe(1);
    expect(results.reduce((n, r) => n + r.skippedDuplicates, 0)).toBe(2);
    expect(driveUploads).toHaveLength(1);
  });

  it('dedupes by hash within one batch even when the names differ', async () => {
    const link = await validateUploadLink('tok-good');
    objects['vol/ev1/bh4/u1.jpg'] = {
      exists: true,
      size: 42,
      contentType: 'image/jpeg',
      md5Hash: MD5_A,
      metadata: { originalName: 'first.jpg', photographerName: 'Jane Doe' },
    };
    objects['vol/ev1/bh4/u2.jpg'] = {
      exists: true,
      size: 42,
      contentType: 'image/jpeg',
      md5Hash: MD5_A,
      metadata: { originalName: 'second-name.jpg', photographerName: 'Jane Doe' },
    };

    const res = await enqueueStagedBatch(link, 'bh4', ['vol/ev1/bh4/u1.jpg', 'vol/ev1/bh4/u2.jpg']);
    expect(res).toMatchObject({ copied: 1, skippedDuplicates: 1 });
  });

  it('falls back to name+size when the staged object has no md5', async () => {
    const link = await validateUploadLink('tok-good');
    existingDriveFiles.push({ name: 'ClubA_JaneDoe_race-001.jpg', size: '100', md5Checksum: HEX_A });
    objects['vol/ev1/bh5/u1.jpg'] = {
      exists: true,
      size: 100,
      contentType: 'image/jpeg',
      metadata: { originalName: 'race-001.jpg', photographerName: 'Jane Doe' },
    };

    const res = await enqueueStagedBatch(link, 'bh5', ['vol/ev1/bh5/u1.jpg']);
    expect(res).toMatchObject({ copied: 0, skippedDuplicates: 1 });
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

/**
 * A RETRY MUST NOT CREATE DUPLICATES.
 *
 * Winning a claim is not proof that nobody copied these bytes: a worker killed
 * between the Drive write and its bookkeeping leaves a copy in Drive that no
 * record points at. The 2,683-duplicate census (2026-07-28) is what that looks
 * like at scale — one uploader's session re-landed into folders ~70s apart.
 * Every case below is a way the retry used to write a second copy.
 */
describe('enqueueStagedBatch retry safety', () => {
  const STALE_MS = 36 * 60 * 1000; // older than the service's 35-min staleness bar

  /** One staged photo with a known content hash. */
  function stageOne(objectName: string, md5Base64: string, originalName = 'race-001.jpg'): void {
    objects[objectName] = {
      exists: true,
      size: 100,
      contentType: 'image/jpeg',
      md5Hash: md5Base64,
      metadata: { originalName, photographerName: 'Jane Doe' },
    };
  }

  // 'AAECAwQFBgcICQoLDA0ODw==' → hex 000102...0f, the hash the service derives.
  const MD5_B64 = 'AAECAwQFBgcICQoLDA0ODw==';
  const MD5_HEX = '000102030405060708090a0b0c0d0e0f';

  it('adopts the copy a dead attempt already wrote, instead of duplicating it', async () => {
    const link = await validateUploadLink('tok-good');
    stageOne('vol/ev1/b9/u1.jpg', MD5_B64);
    const tag = claimId('ev1', MD5_HEX);
    // The wreckage: a claim old enough to reclaim, never stamped with a file id…
    dedupDocs.set(tag, { eventId: 'ev1', dedupKey: MD5_HEX, batchId: 'b9', claimedAt: new Date(Date.now() - STALE_MS) });
    // …but its Drive write DID land, tagged.
    appPropFiles.set(tag, { id: 'drive-already-there', name: 'ClubA_JaneDoe_race-001.jpg' });

    const res = await enqueueStagedBatch(link, 'b9-retry', ['vol/ev1/b9/u1.jpg']);

    expect(driveUploads).toEqual([]); // the duplicate that used to be written
    expect(res).toMatchObject({ copied: 0, skippedDuplicates: 1 });
    // The claim now points at the adopted file, so an admin delete can release it.
    expect(dedupDocs.get(tag)?.driveFileId).toBe('drive-already-there');
    // Proven in Drive, so the staged bytes are safe to reclaim.
    expect(deleted).toEqual(['vol/ev1/b9/u1.jpg']);
    expect(appPropLookups).toContain(tag);
  });

  it('does copy when the dead attempt left nothing behind', async () => {
    const link = await validateUploadLink('tok-good');
    stageOne('vol/ev1/b10/u1.jpg', MD5_B64);
    const tag = claimId('ev1', MD5_HEX);
    dedupDocs.set(tag, { eventId: 'ev1', dedupKey: MD5_HEX, batchId: 'b10', claimedAt: new Date(Date.now() - STALE_MS) });
    // No appPropFiles entry: the holder died BEFORE writing anything.

    const res = await enqueueStagedBatch(link, 'b10-retry', ['vol/ev1/b10/u1.jpg']);

    expect(res).toMatchObject({ copied: 1 });
    expect(driveUploads).toHaveLength(1);
    expect(dedupDocs.get(tag)?.driveFileId).toBe('drive-ClubA_JaneDoe_race-001.jpg');
  });

  it('keeps the claim when the write threw but the file really is in Drive', async () => {
    const link = await validateUploadLink('tok-good');
    stageOne('vol/ev1/b11/u1.jpg', MD5_B64);
    const tag = claimId('ev1', MD5_HEX);
    // Drive committed the file and then failed us on the way back — the classic
    // "500 after the create" that a blind release turns into a duplicate.
    failUploadsFor.add('ClubA_JaneDoe_race-001.jpg');
    appPropFiles.set(tag, { id: 'drive-landed-anyway', name: 'ClubA_JaneDoe_race-001.jpg' });

    const res = await enqueueStagedBatch(link, 'b11', ['vol/ev1/b11/u1.jpg']);

    // Counted as copied (it IS in Drive) and NOT failed.
    expect(res).toMatchObject({ copied: 1 });
    // The claim survives and is stamped, so the Cloud Tasks retry skips the file
    // instead of writing a second copy.
    expect(dedupDocs.has(tag)).toBe(true);
    expect(dedupDocs.get(tag)?.driveFileId).toBe('drive-landed-anyway');
  });

  it('releases the claim when the write threw and nothing landed', async () => {
    const link = await validateUploadLink('tok-good');
    stageOne('vol/ev1/b12/u1.jpg', MD5_B64);
    const tag = claimId('ev1', MD5_HEX);
    failUploadsFor.add('ClubA_JaneDoe_race-001.jpg');
    // No appPropFiles entry: the write genuinely did not happen.

    const res = await enqueueStagedBatch(link, 'b12', ['vol/ev1/b12/u1.jpg']);

    expect(res).toMatchObject({ copied: 0 });
    // Claim handed back, so the retry may try again rather than being told it is
    // a duplicate of a file that never existed.
    expect(dedupDocs.has(tag)).toBe(false);
    // And the bytes are kept — they are the only copy.
    expect(deleted).toEqual([]);
  });

  it('resumes the SAME batch folder on a retry instead of minting a second one', async () => {
    const link = await validateUploadLink('tok-good');
    stageOne('vol/ev1/b13/u1.jpg', MD5_B64);
    // A previous attempt at this batch already created and recorded its folder.
    batchDocs.set('b13', { batchId: 'b13', batchFolderName: '20260101-000000_janedoe' });

    await enqueueStagedBatch(link, 'b13', ['vol/ev1/b13/u1.jpg']);

    // buildBatchFolderName() would have stamped the CURRENT time here; reusing the
    // recorded name is what keeps one session in one folder across retries.
    expect(folderCreates.map((f) => f.name)).toEqual(['ClubA', 'tagX', '20260101-000000_janedoe']);
    expect(driveUploads[0]?.folderId).toBe('folder-ev1>ClubA>tagX>20260101-000000_janedoe');
  });

  it('records the batch folder name before the terminal write, so a killed run is resumable', async () => {
    const link = await validateUploadLink('tok-good');
    stageOne('vol/ev1/b14/u1.jpg', MD5_B64);

    await enqueueStagedBatch(link, 'b14', ['vol/ev1/b14/u1.jpg']);

    const firstNameWrite = batchWrites.findIndex((w) => typeof w.batchFolderName === 'string' && w.batchFolderName);
    const terminalWrite = batchWrites.findIndex((w) => w.phase === 'indexing' || w.phase === 'done');
    expect(firstNameWrite).toBeGreaterThanOrEqual(0);
    // Written as soon as the folder exists — the end-of-loop update never runs on
    // a run that gets killed, which is exactly the run whose retry needs the name.
    expect(firstNameWrite).toBeLessThan(terminalWrite);
  });

  it('does not spend a Drive lookup on the normal path', async () => {
    const link = await validateUploadLink('tok-good');
    stageOne('vol/ev1/b15/u1.jpg', MD5_B64);

    await enqueueStagedBatch(link, 'b15', ['vol/ev1/b15/u1.jpg']);

    // A clean claim proves nobody has copied these bytes, so the verification
    // query would be pure per-file cost on every upload.
    expect(appPropLookups).toEqual([]);
    expect(driveUploads).toHaveLength(1);
  });
});
