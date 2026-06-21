import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory Firestore stand-in. `failNext` lets a test force a write to throw
// so we can assert init/update swallow errors (best-effort).
const docs: Record<string, Record<string, unknown>> = {};
let failNext = false;

vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: (name: string) => {
      if (name !== 'upload_batches') throw new Error(`unexpected collection ${name}`);
      return {
        doc: (id: string) => ({
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

const { initUploadBatch, updateUploadBatch, getUploadBatch } = await import(
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
