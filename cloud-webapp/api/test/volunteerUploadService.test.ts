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
vi.mock('../src/services/driveService.js', () => ({
  DRIVE_SCOPE_READWRITE: 'rw-scope',
  getDriveToken: async () => 'drive-token',
  uploadFileToDrive: async (folderId: string, name: string, mimeType: string, bytes: Uint8Array) => {
    driveUploads.push({ folderId, name, mimeType, size: bytes.length });
    return { id: `drive-${name}`, name };
  },
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
  indexTriggers.length = 0;
  deleted.length = 0;

  sheetData[LINKS_RANGE] = [
    ['LINK_ID', 'EVENT_ID', 'CLUB_NAME', 'TOKEN', '', '', '', 'REVOKED_AT', '', '', 'TAG'],
    row('link1', 'ev1', 'ClubA', 'tok-good', '', 'tagX'),
    row('link2', 'ev2', 'ClubB', 'tok-revoked', '2026-01-01', 'tagY'),
    row('link3', 'ev3', 'ClubC', 'tok-nofolder', '', 'tagZ'),
  ];
  eventDocs['ev1'] = { name: 'Spring Run', driveFolderId: 'folder-ev1' };
  eventDocs['ev2'] = { name: 'Revoked Event', driveFolderId: 'folder-ev2' };
  eventDocs['ev3'] = { name: 'Unconfigured Event' }; // no driveFolderId
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
  it('copies valid staged objects to Drive, deletes them, triggers the indexer once', async () => {
    const link = await validateUploadLink('tok-good');
    objects['vol/ev1/b1/u1.jpg'] = {
      exists: true,
      size: 100,
      contentType: 'image/jpeg',
      metadata: { originalName: 'race-001.jpg' },
    };
    objects['vol/ev1/b1/u2.jpg'] = {
      exists: true,
      size: 200,
      contentType: 'image/jpeg',
      metadata: { originalName: 'race-002.jpg' },
    };

    const copied = await enqueueStagedBatch(link, 'b1', ['vol/ev1/b1/u1.jpg', 'vol/ev1/b1/u2.jpg']);

    expect(copied).toBe(2);
    expect(driveUploads).toEqual([
      { folderId: 'folder-ev1', name: 'race-001.jpg', mimeType: 'image/jpeg', size: 100 },
      { folderId: 'folder-ev1', name: 'race-002.jpg', mimeType: 'image/jpeg', size: 200 },
    ]);
    expect(deleted.sort()).toEqual(['vol/ev1/b1/u1.jpg', 'vol/ev1/b1/u2.jpg']);
    expect(indexTriggers).toEqual(['ev1']);
  });

  it('skips missing and empty objects without failing the batch', async () => {
    const link = await validateUploadLink('tok-good');
    objects['vol/ev1/b2/good.jpg'] = { exists: true, size: 50, contentType: 'image/jpeg', metadata: { originalName: 'ok.jpg' } };
    objects['vol/ev1/b2/empty.jpg'] = { exists: true, size: 0, contentType: 'image/jpeg' };
    // 'vol/ev1/b2/missing.jpg' is never registered → exists() false.

    const copied = await enqueueStagedBatch(link, 'b2', [
      'vol/ev1/b2/good.jpg',
      'vol/ev1/b2/empty.jpg',
      'vol/ev1/b2/missing.jpg',
    ]);

    expect(copied).toBe(1);
    expect(driveUploads).toHaveLength(1);
    expect(driveUploads[0]?.name).toBe('ok.jpg');
    expect(indexTriggers).toEqual(['ev1']);
  });

  it('falls back to the object basename when originalName metadata is absent', async () => {
    const link = await validateUploadLink('tok-good');
    objects['vol/ev1/b3/u9.png'] = { exists: true, size: 10, contentType: 'image/png' };
    await enqueueStagedBatch(link, 'b3', ['vol/ev1/b3/u9.png']);
    expect(driveUploads[0]?.name).toBe('u9.png');
  });

  it('does not trigger the indexer when nothing was copied', async () => {
    const link = await validateUploadLink('tok-good');
    const copied = await enqueueStagedBatch(link, 'b4', ['vol/ev1/b4/missing.jpg']);
    expect(copied).toBe(0);
    expect(driveUploads).toHaveLength(0);
    expect(indexTriggers).toHaveLength(0);
  });

  it('returns 0 for an empty batch without touching Drive', async () => {
    const link = await validateUploadLink('tok-good');
    expect(await enqueueStagedBatch(link, 'b5', [])).toBe(0);
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
