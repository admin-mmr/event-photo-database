import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory Firestore stand-in. `failNext` lets a test force a write to throw
// so we can assert init/update swallow errors (best-effort).
const docs: Record<string, Record<string, unknown>> = {};
let failNext = false;

vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        get: async (ref: { __id: string }) => ({ exists: docs[ref.__id] !== undefined, data: () => docs[ref.__id] }),
        set: (ref: { __id: string }, data: Record<string, unknown>) => {
          docs[ref.__id] = { ...(docs[ref.__id] ?? {}), ...data };
        },
      }),
    collection: (name: string) => {
      if (name !== 'upload_batches') throw new Error(`unexpected collection ${name}`);
      return {
        where: (field: string, _op: string, value: unknown) => ({
          get: async () => ({
            docs: Object.values(docs)
              .filter((d) => d[field] === value)
              .map((d) => ({ data: () => d })),
          }),
        }),
        doc: (id: string) => ({
          __id: id,
          set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
            if (failNext) {
              failNext = false;
              throw new Error('firestore down');
            }
            docs[id] = opts?.merge ? { ...(docs[id] ?? {}), ...data } : data;
          },
          get: async () => ({
            exists: docs[id] !== undefined,
            data: () => docs[id],
          }),
        }),
      };
    },
  }),
}));
vi.mock('../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const {
  initUploadBatch,
  updateUploadBatch,
  getUploadBatch,
  claimSessionBatch,
  seedChunkBatch,
  getUploadBatchStatus,
  combinePhases,
  hasUploadBatchRecord,
} = await import(
  '../src/services/uploadBatchService.js'
);

beforeEach(() => {
  for (const k of Object.keys(docs)) delete docs[k];
  failNext = false;
});

describe('uploadBatchService', () => {
  it('init creates a doc at phase "saving" with zeroed counters', async () => {
    await initUploadBatch('b1', 'ev1', 'link1', 5);
    expect(getUploadBatch('b1')).resolves.toMatchObject({
      batchId: 'b1',
      eventId: 'ev1',
      linkId: 'link1',
      phase: 'saving',
      total: 5,
      copied: 0,
      skippedDuplicates: 0,
      failed: 0,
    });
  });

  it('update merges a phase transition + counts and bumps updatedAt', async () => {
    await initUploadBatch('b2', 'ev1', 'link1', 3);
    await updateUploadBatch('b2', {
      phase: 'indexing',
      copied: 2,
      skippedDuplicates: 1,
      skippedDuplicateNames: ['dup.jpg'],
      failed: 0,
      batchFolderName: '20260101-000000_jane',
    });
    const batch = await getUploadBatch('b2');
    expect(batch).toMatchObject({
      phase: 'indexing',
      copied: 2,
      skippedDuplicates: 1,
      skippedDuplicateNames: ['dup.jpg'],
      batchFolderName: '20260101-000000_jane',
    });
    expect(typeof batch?.updatedAt).toBe('string');
  });

  it('get returns null for an unknown batch', async () => {
    await expect(getUploadBatch('missing')).resolves.toBeNull();
  });

  it('init never throws when the write fails (best-effort)', async () => {
    failNext = true;
    await expect(initUploadBatch('b3', 'ev1', 'link1', 1)).resolves.toBeUndefined();
    expect(docs['b3']).toBeUndefined();
  });

  it('update never throws when the write fails (best-effort)', async () => {
    await initUploadBatch('b4', 'ev1', 'link1', 1);
    failNext = true;
    await expect(updateUploadBatch('b4', { phase: 'done' })).resolves.toBeUndefined();
  });
});

describe('chunked sessions', () => {
  it('the first /complete names the session folder; later calls adopt it', async () => {
    expect(await claimSessionBatch('s1', 'ev1', 'l1', '20261102-034720_dannyzeng')).toBe('20261102-034720_dannyzeng');
    expect(await claimSessionBatch('s1', 'ev1', 'l1', '20261102-035500_dannyzeng')).toBe('20261102-034720_dannyzeng');
    expect(docs.s1).toMatchObject({ chunked: true, eventId: 'ev1', batchFolderName: '20261102-034720_dannyzeng' });
  });

  it('seeds a chunk once, so a repeated /complete cannot reset a chunk already copying', async () => {
    await seedChunkBatch('s1-pa', 's1', 'ev1', 'l1', 100, 'folder');
    docs['s1-pa'] = { ...docs['s1-pa'], phase: 'saving', copied: 40 };
    await seedChunkBatch('s1-pa', 's1', 'ev1', 'l1', 100, 'folder');
    expect(docs['s1-pa']).toMatchObject({ phase: 'saving', copied: 40, parentBatchId: 's1', batchFolderName: 'folder' });
  });

  it('reports a chunked session as the sum of its chunks', async () => {
    await claimSessionBatch('s1', 'ev1', 'l1', 'folder');
    await seedChunkBatch('s1-pa', 's1', 'ev1', 'l1', 100, 'folder');
    await seedChunkBatch('s1-pb', 's1', 'ev1', 'l1', 50, 'folder');
    docs['s1-pa'] = { ...docs['s1-pa'], phase: 'indexing', copied: 98, skippedDuplicates: 2, skippedDuplicateNames: ['a', 'b'] };
    docs['s1-pb'] = { ...docs['s1-pb'], phase: 'saving', copied: 10 };

    const status = await getUploadBatchStatus('s1');

    expect(status).toMatchObject({
      batchId: 's1',
      phase: 'saving',
      total: 150,
      copied: 108,
      skippedDuplicates: 2,
      skippedDuplicateNames: ['a', 'b'],
    });
  });

  it('reports an un-chunked batch as itself', async () => {
    await initUploadBatch('b1', 'ev1', 'l1', 3);
    expect(await getUploadBatchStatus('b1')).toMatchObject({ batchId: 'b1', total: 3 });
    expect(await getUploadBatchStatus('missing')).toBeNull();
  });

  it('combines chunk phases: any copying → saving, then indexing, then done', () => {
    expect(combinePhases(['received', 'received'])).toBe('received');
    expect(combinePhases(['received', 'indexing'])).toBe('saving');
    expect(combinePhases(['done', 'indexing'])).toBe('indexing');
    expect(combinePhases(['done', 'error'])).toBe('error');
    expect(combinePhases(['done', 'ready'])).toBe('done');
    expect(combinePhases(['ready', 'ready'])).toBe('ready');
  });
});

describe('hasUploadBatchRecord (what the never-completed sweep treats as owned)', () => {
  it('a plain /complete doc owns its batch', async () => {
    await initUploadBatch('b1', 'ev1', 'l1', 3);
    expect(await hasUploadBatchRecord('b1')).toBe(true);
  });

  it('a chunked session does NOT, until recovery has looked at it once', async () => {
    // Its doc exists from the first flush, but files staged after the last
    // flush can still be stranded by a closed page.
    await claimSessionBatch('s1', 'ev1', 'l1', 'folder');
    expect(await hasUploadBatchRecord('s1')).toBe(false);
    docs.s1 = { ...docs.s1, recoveryDispatchedAt: '2026-11-02T08:00:00Z' };
    expect(await hasUploadBatchRecord('s1')).toBe(true);
  });

  it('no doc at all is not owned', async () => {
    expect(await hasUploadBatchRecord('nope')).toBe(false);
  });
});
