/**
 * uploadInsightsService — the per-(club, tag, uploader) upload roll-up.
 *
 * WHAT THIS PROTECTS: the page exists to spot uploads that went wrong after the
 * NYC Marathon (2026-11-01). So beyond the sums, what matters is that a session
 * is folded together from its copy chunks and recoveries (or one upload reads as
 * a dozen), that a killed copy reads as STUCK while a live one does not, and that
 * files that only ever reached staging still show up — they have no
 * `upload_batches` doc at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { fakeStore } from './helpers/fakeDb.js';
import { FakeObjectStore } from './helpers/fakeObjectStore.js';

process.env.VOLUNTEER_STAGING_BUCKET = 'staging-bucket';

const storage = new FakeObjectStore();
vi.mock('../src/lib/storage.js', () => ({ objectStore: () => storage }));

let db = fakeStore();
vi.mock('../src/lib/firestore.js', () => ({ firestore: () => db }));

const listLinks = vi.fn();
vi.mock('../src/services/linkStore.js', () => ({ listLinks: (...a: unknown[]) => listLinks(...a) }));
const copiedMbByBatchFolder = vi.fn();
vi.mock('../src/services/summaryService.js', () => ({
  copiedMbByBatchFolder: (...a: unknown[]) => copiedMbByBatchFolder(...a),
}));

const { buildUploadInsights, loadUploadInsights, parseBatchFolder, sessionIdOf, STUCK_AFTER_MS } = await import(
  '../src/services/uploadInsightsService.js'
);
type Input = Parameters<typeof buildUploadInsights>[0];
type Staged = Input['staged'][number];

const EV = 'ev1';
const NOW = Date.parse('2026-11-02T12:00:00Z');
const at = (min: number): string => new Date(NOW + min * 60_000).toISOString();
const MB = 1024 * 1024;

const LINKS = new Map([
  ['link-a', { clubName: 'MMR', tag: 'NYC' }],
  ['link-b', { clubName: 'Harriers', tag: '' }],
]);

function input(over: Partial<Input> = {}): Input {
  return {
    now: NOW,
    batches: [],
    staged: [],
    links: LINKS,
    copiedMbByFolder: new Map(),
    indexedByFolder: new Map(),
    ...over,
  };
}

function staged(batchId: string, over: Partial<Staged> = {}): Staged {
  return {
    name: `volunteer_uploads/${EV}/${batchId}/${Math.random()}.jpg`,
    md5Hex: '',
    size: 2 * MB,
    batchId,
    linkId: 'link-a',
    clubName: 'MMR',
    tag: 'NYC',
    photographerName: 'Jane Doe',
    createdMs: NOW - 10 * 60_000,
    ...over,
  };
}

describe('session ids and folder names', () => {
  it('folds chunk and recovery docs into their session', () => {
    expect(sessionIdOf({ batchId: 'c1', parentBatchId: 's1' })).toBe('s1');
    expect(sessionIdOf({ batchId: 's1-p0123456789abcdef' })).toBe('s1');
    expect(sessionIdOf({ batchId: 's1-rec2' })).toBe('s1');
    expect(sessionIdOf({ batchId: 'a1b2c3d4-0000-4000-8000-000000000000' })).toBe(
      'a1b2c3d4-0000-4000-8000-000000000000',
    );
  });

  it('reads the UTC stamp and uploader off a batch folder name', () => {
    expect(parseBatchFolder('20261101-143005_janedoe')).toEqual({
      ms: Date.parse('2026-11-01T14:30:05Z'),
      username: 'janedoe',
    });
    expect(parseBatchFolder('Photos_001')).toBeNull();
  });
});

describe('buildUploadInsights', () => {
  it('rolls one chunked session up from its chunks, with size, time and index %', () => {
    const folder = '20261102-111000_janedoe';
    const { groups, totals } = buildUploadInsights(
      input({
        batches: [
          // The session doc only names the folder; the chunks hold the counts.
          { batchId: 's1', chunked: true, linkId: 'link-a', phase: 'received', total: 0, batchFolderName: folder,
            createdAt: at(-50), updatedAt: at(-50) },
          { batchId: 's1-p0000000000000001', parentBatchId: 's1', linkId: 'link-a', phase: 'indexing', total: 100,
            copied: 98, skippedDuplicates: 2, batchFolderName: folder, createdAt: at(-50), updatedAt: at(-30) },
          { batchId: 's1-p0000000000000002', parentBatchId: 's1', linkId: 'link-a', phase: 'indexing', total: 50,
            copied: 50, batchFolderName: folder, createdAt: at(-40), updatedAt: at(-20) },
        ],
        copiedMbByFolder: new Map([[folder, 600]]),
        indexedByFolder: new Map([[folder, 74]]),
      }),
    );

    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g).toMatchObject({
      clubName: 'MMR',
      tag: 'NYC',
      uploader: 'janedoe',
      sessions: 1,
      files: 150,
      copied: 148,
      skippedDuplicates: 2,
      copiedBytes: 600 * MB,
      indexed: 74,
      indexRatio: 0.5,
      inProgress: 0,
      stuck: 0,
    });
    // Start is the folder stamp (11:10), the earliest thing on record; end is the
    // last chunk update (11:40).
    expect(g.firstSessionAt).toBe('2026-11-02T11:10:00.000Z');
    expect(g.lastActivityAt).toBe(at(-20));
    expect(g.minutes).toBe(30);
    expect(g.mbPerSec).toBeCloseTo(600 / 1800);
    expect(g.filesPerMin).toBeCloseTo(148 / 30);
    expect(g.sessionList[0]).toMatchObject({ batchId: 's1', status: 'ok', batchFolders: [folder] });
    expect(totals).toMatchObject({ sessions: 1, files: 150, copied: 148 });
  });

  it('groups sessions per (club, tag, uploader) and an empty link tag reads ALL', () => {
    const { groups, totals } = buildUploadInsights(
      input({
        batches: [
          { batchId: 'a', linkId: 'link-a', phase: 'done', total: 10, copied: 10,
            batchFolderName: '20261102-090000_janedoe', createdAt: at(-180), updatedAt: at(-170) },
          { batchId: 'b', linkId: 'link-a', phase: 'done', total: 5, copied: 5,
            batchFolderName: '20261102-100000_janedoe', createdAt: at(-120), updatedAt: at(-115) },
          { batchId: 'c', linkId: 'link-b', phase: 'done', total: 3, copied: 3,
            batchFolderName: '20261102-100000_bob', createdAt: at(-120), updatedAt: at(-118) },
        ],
      }),
    );
    const jane = groups.find((g) => g.uploader === 'janedoe')!;
    expect(jane).toMatchObject({ sessions: 2, files: 15, minutes: 15 });
    expect(jane.firstSessionAt).toBe('2026-11-02T09:00:00.000Z');
    expect(jane.lastSessionAt).toBe('2026-11-02T10:00:00.000Z');
    expect(groups.find((g) => g.uploader === 'bob')).toMatchObject({ clubName: 'Harriers', tag: 'ALL' });
    expect(totals).toMatchObject({ sessions: 3, files: 18 });
  });

  it('tells a stuck copy from a live one', () => {
    const live = { linkId: 'link-a', phase: 'saving' as const, total: 10, batchFolderName: '20261102-115000_x',
      createdAt: at(-10), updatedAt: at(-1) };
    const dead = { ...live, batchFolderName: '20261102-080000_y', createdAt: at(-240),
      updatedAt: new Date(NOW - STUCK_AFTER_MS - 60_000).toISOString() };
    const { groups } = buildUploadInsights(input({ batches: [{ batchId: 'l', ...live }, { batchId: 'd', ...dead }] }));
    expect(groups.find((g) => g.uploader === 'x')).toMatchObject({ inProgress: 1, stuck: 0 });
    expect(groups.find((g) => g.uploader === 'y')).toMatchObject({ inProgress: 0, stuck: 1 });
  });

  it('flags an errored session', () => {
    const { groups } = buildUploadInsights(
      input({ batches: [{ batchId: 'e', linkId: 'link-a', phase: 'error', total: 4, failed: 4,
        batchFolderName: '20261102-110000_z', createdAt: at(-60), updatedAt: at(-55) }] }),
    );
    expect(groups[0]).toMatchObject({ errors: 1, failed: 4 });
  });

  it('a recovered session is not stuck on the doc its killed worker left behind', () => {
    const folder = '20261102-060000_janedoe';
    const { groups } = buildUploadInsights(
      input({
        batches: [
          { batchId: 's2', linkId: 'link-a', phase: 'saving', total: 100, copied: 40, batchFolderName: folder,
            createdAt: at(-360), updatedAt: at(-350), recoveryDispatchedAt: at(-200) },
          { batchId: 's2-rec1', linkId: 'link-a', phase: 'indexing', total: 60, copied: 60,
            batchFolderName: '20261102-090000_janedoe', createdAt: at(-190), updatedAt: at(-180) },
        ],
      }),
    );
    const s = groups[0]!.sessionList[0]!;
    expect(s).toMatchObject({ status: 'ok', recovered: true, files: 100, copied: 100 });
    expect(s.batchFolders).toHaveLength(2);
    expect(groups[0]).toMatchObject({ recovered: 1, stuck: 0 });
  });

  it('files that only reached staging are a never-completed session, credited from object metadata', () => {
    const { groups } = buildUploadInsights(
      input({ staged: [staged('orphan', { photographerName: 'Sam Lee' }), staged('orphan')] }),
    );
    expect(groups[0]).toMatchObject({
      clubName: 'MMR',
      tag: 'NYC',
      uploader: 'samlee',
      neverCompleted: 1,
      files: 2,
      staged: 2,
      stagedBytes: 4 * MB,
      copied: 0,
    });
  });

  it('counts files staged after a chunked session\'s last flush', () => {
    const folder = '20261102-113000_janedoe';
    const { groups } = buildUploadInsights(
      input({
        batches: [
          { batchId: 's3', chunked: true, linkId: 'link-a', batchFolderName: folder, createdAt: at(-30), updatedAt: at(-30) },
          { batchId: 's3-p0000000000000003', parentBatchId: 's3', linkId: 'link-a', phase: 'indexing', total: 100,
            copied: 100, batchFolderName: folder, createdAt: at(-30), updatedAt: at(-20) },
        ],
        staged: [staged('s3'), staged('s3'), staged('s3')],
      }),
    );
    expect(groups[0]).toMatchObject({ files: 103, copied: 100, staged: 3 });
  });

  // A real NYC Marathon session (2026-11-02) had chunks reading "total 100,
  // copied 22, dup 1". The first attempt copied most of the chunk, then died
  // before writing its counts; the retry reset them and skipped the files whose
  // staged bytes were already gone. Those files are in Drive but in no counter.
  it('reports files no copy result was recorded for, and indexes against them', () => {
    const folder = '20261102-131640_volunteer';
    const { groups } = buildUploadInsights(
      input({
        batches: [
          { batchId: 's4', chunked: true, linkId: 'link-a', batchFolderName: folder, createdAt: at(-60), updatedAt: at(-60) },
          { batchId: 's4-p0000000000000004', parentBatchId: 's4', linkId: 'link-a', phase: 'indexing', total: 100,
            copied: 22, skippedDuplicates: 1, batchFolderName: folder, createdAt: at(-60), updatedAt: at(-20) },
          { batchId: 's4-p0000000000000005', parentBatchId: 's4', linkId: 'link-a', phase: 'indexing', total: 100,
            copied: 100, batchFolderName: folder, createdAt: at(-50), updatedAt: at(-40) },
        ],
        indexedByFolder: new Map([[folder, 199]]),
      }),
    );
    const g = groups[0]!;
    expect(g).toMatchObject({ files: 200, copied: 122, skippedDuplicates: 1, staged: 0, untracked: 77 });
    expect(g.sessionList[0]).toMatchObject({ untracked: 77 });
    // 199 indexed of the 199 that reached Drive — not 163% of the 122 counted.
    expect(g.indexRatio).toBe(1);
  });

  it('a club scope drops every other club', () => {
    const { groups, totals } = buildUploadInsights(
      input({
        clubScope: 'Harriers',
        batches: [
          { batchId: 'a', linkId: 'link-a', phase: 'done', total: 10, copied: 10, batchFolderName: '20261102-090000_jane' },
          { batchId: 'c', linkId: 'link-b', phase: 'done', total: 3, copied: 3, batchFolderName: '20261102-100000_bob' },
        ],
      }),
    );
    expect(groups.map((g) => g.clubName)).toEqual(['Harriers']);
    expect(totals.files).toBe(3);
  });

  it('unknown sizes and index counts stay null rather than reading as zero', () => {
    const { groups } = buildUploadInsights(
      input({
        copiedMbByFolder: null,
        indexedByFolder: null,
        batches: [{ batchId: 'a', linkId: 'link-a', phase: 'done', total: 1, copied: 1,
          batchFolderName: '20261102-090000_jane', createdAt: at(-10), updatedAt: at(-5) }],
      }),
    );
    expect(groups[0]).toMatchObject({ copiedBytes: null, indexed: null, indexRatio: null, mbPerSec: null });
  });
});

describe('loadUploadInsights', () => {
  beforeEach(() => {
    db = fakeStore();
    storage.reset();
    listLinks.mockReset().mockResolvedValue([{ linkId: 'link-a', clubName: 'MMR', tag: 'NYC' }]);
    copiedMbByBatchFolder.mockReset().mockResolvedValue(new Map([['20261102-090000_jane', 12]]));
  });

  it('joins the batch docs, staging, Sheet and the indexer counts for one event', async () => {
    db.seed('upload_batches', {
      a: { batchId: 'a', eventId: EV, linkId: 'link-a', phase: 'indexing', total: 5, copied: 5,
        batchFolderName: '20261102-090000_jane', createdAt: at(-60), updatedAt: at(-50) },
      other: { batchId: 'other', eventId: 'ev2', linkId: 'link-a', phase: 'done', total: 9, copied: 9 },
    });
    db.seed('upload_folder_counts', {
      [EV]: { eventId: EV, updatedAt: at(-5), folders: [{ clubName: 'MMR', tag: 'NYC', batchFolder: '20261102-090000_jane', count: 4 }] },
    });
    storage.seed('staging-bucket', `volunteer_uploads/${EV}/a/x.jpg`, {
      size: 100,
      createdMs: NOW - 55 * 60_000,
      custom: { linkId: 'link-a', clubName: 'MMR', tag: 'NYC', photographerName: 'Jane' },
    });

    const r = await loadUploadInsights(EV, { spreadsheetId: 'sheet1', now: NOW });
    expect(r).toMatchObject({ ok: true, eventId: EV, stagingListed: true, truncated: false, indexCountsAt: at(-5) });
    expect(r.warnings).toEqual([]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({
      uploader: 'jane',
      files: 6,
      copied: 5,
      staged: 1,
      copiedBytes: 12 * MB,
      indexed: 4,
      indexRatio: 0.8,
    });
    expect(listLinks).toHaveBeenCalledWith('sheet1', { eventId: EV });
  });

  it('degrades a failed Sheet read to warnings, and no counts doc to a null index', async () => {
    db.seed('upload_batches', {
      a: { batchId: 'a', eventId: EV, linkId: 'link-a', phase: 'done', total: 5, copied: 5,
        batchFolderName: '20261102-090000_jane', createdAt: at(-60), updatedAt: at(-50) },
    });
    copiedMbByBatchFolder.mockRejectedValue(new Error('sheets down'));
    listLinks.mockRejectedValue(new Error('sheets down'));

    const r = await loadUploadInsights(EV, { spreadsheetId: 'sheet1', now: NOW });
    expect(r.indexCountsAt).toBeNull();
    expect(r.groups[0]).toMatchObject({ copiedBytes: null, indexed: null, clubName: '', tag: 'ALL' });
    expect(r.warnings.join(' ')).toMatch(/Upload_Log/);
    expect(r.warnings.join(' ')).toMatch(/upload links/);
  });
});
