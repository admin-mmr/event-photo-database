import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const validateUploadLink = vi.fn();
const enqueueStagedBatch = vi.fn();
const isUploadDispatchConfigured = vi.fn();
const enqueueProcessBatchTask = vi.fn();
const seedChunkBatch = vi.fn();
const prepareSessionFolder = vi.fn();

vi.mock('../src/services/volunteerUploadService.js', () => ({
  validateUploadLink,
  enqueueStagedBatch,
  prepareSessionFolder,
  createResumableSession: vi.fn(),
  UploadLinkError: class UploadLinkError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
vi.mock('../src/services/uploadDispatch.js', () => ({
  isUploadDispatchConfigured,
  enqueueProcessBatchTask,
}));
vi.mock('../src/services/uploadBatchService.js', () => ({
  seedChunkBatch,
  getUploadBatchStatus: vi.fn(),
}));

const { buildServer } = await import('../src/server.js');

const body = {
  token: 't',
  batchId: 'b1',
  items: [{ uploadId: 'u1', objectName: 'vol/ev1/b1/u1.jpg', fileName: 'a.jpg', bytes: 10 }],
};

beforeEach(() => {
  validateUploadLink.mockReset().mockResolvedValue({
    eventId: 'ev1',
    linkId: 'link1',
    eventName: 'Spring Race',
    clubName: 'ClubA',
    tag: '',
  });
  enqueueStagedBatch.mockReset().mockResolvedValue({
    copied: 1,
    skippedDuplicates: 0,
    skippedDuplicateNames: [],
  });
  isUploadDispatchConfigured.mockReset();
  enqueueProcessBatchTask.mockReset();
  seedChunkBatch.mockReset().mockResolvedValue(undefined);
  prepareSessionFolder.mockReset().mockResolvedValue('20261102-041130_dannyzeng');
});

describe('POST /api/volunteer/upload/complete dispatch behaviour', () => {
  it('queues to the worker and returns "received" without copying inline', async () => {
    isUploadDispatchConfigured.mockReturnValue(true);
    enqueueProcessBatchTask.mockResolvedValue(undefined);

    const res = await request(buildServer()).post('/api/volunteer/upload/complete').send(body);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/saving in the background/);
    expect(enqueueProcessBatchTask).toHaveBeenCalledTimes(1);
    expect(enqueueProcessBatchTask.mock.calls[0]?.[0].batchId).toMatch(/^b1-p[0-9a-f]{16}$/);
    expect(enqueueStagedBatch).not.toHaveBeenCalled();
  });

  it('falls back to an inline copy when enqueue fails', async () => {
    isUploadDispatchConfigured.mockReturnValue(true);
    enqueueProcessBatchTask.mockRejectedValue(new Error('tasks down'));

    const res = await request(buildServer()).post('/api/volunteer/upload/complete').send(body);

    expect(res.status).toBe(200);
    expect(enqueueProcessBatchTask).toHaveBeenCalledTimes(1);
    expect(enqueueStagedBatch).toHaveBeenCalledTimes(1);
    expect(res.body.accepted).toBe(1);
  });

  it('copies inline (unchanged) when dispatch is not configured', async () => {
    isUploadDispatchConfigured.mockReturnValue(false);

    const res = await request(buildServer()).post('/api/volunteer/upload/complete').send(body);

    expect(res.status).toBe(200);
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
    expect(enqueueStagedBatch).toHaveBeenCalledTimes(1);
    expect(res.body.accepted).toBe(1);
  });

  it('splits a big upload into 100-file chunks, each its own task in the SAME folder', async () => {
    isUploadDispatchConfigured.mockReturnValue(true);
    enqueueProcessBatchTask.mockResolvedValue(undefined);
    const items = Array.from({ length: 250 }, (_, i) => ({
      uploadId: `u${i}`,
      objectName: `vol/ev1/b1/u${i}.jpg`,
      fileName: `${i}.jpg`,
      bytes: 10,
    }));

    const res = await request(buildServer())
      .post('/api/volunteer/upload/complete')
      .send({ ...body, items, sessionTotal: 900 });

    expect(res.status).toBe(200);
    // The receipt counts the whole session, not just this flush.
    expect(res.body.message).toMatch(/^Received 900 files/);
    expect(prepareSessionFolder).toHaveBeenCalledTimes(1);
    const tasks = enqueueProcessBatchTask.mock.calls.map((c) => c[0] as { batchId: string; objectNames: string[] });
    expect(tasks.map((t) => t.objectNames.length)).toEqual([100, 100, 50]);
    expect(new Set(tasks.map((t) => t.batchId)).size).toBe(3);
    // Every chunk is seeded with the session's folder name and points back at the session.
    for (const [chunkId, parent, , , total, folder] of seedChunkBatch.mock.calls) {
      expect(parent).toBe('b1');
      expect(folder).toBe('20261102-041130_dannyzeng');
      expect(tasks.some((t) => t.batchId === chunkId && t.objectNames.length === total)).toBe(true);
    }
    expect(enqueueStagedBatch).not.toHaveBeenCalled();
  });

  it('gives a repeated /complete the same chunk ids, so Cloud Tasks dedupes it', async () => {
    isUploadDispatchConfigured.mockReturnValue(true);
    enqueueProcessBatchTask.mockResolvedValue(undefined);

    await request(buildServer()).post('/api/volunteer/upload/complete').send(body);
    await request(buildServer()).post('/api/volunteer/upload/complete').send(body);

    const ids = enqueueProcessBatchTask.mock.calls.map((c) => (c[0] as { batchId: string }).batchId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('copies inline only the chunk that could not be queued', async () => {
    isUploadDispatchConfigured.mockReturnValue(true);
    enqueueProcessBatchTask.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('tasks down'));
    const items = Array.from({ length: 150 }, (_, i) => ({
      uploadId: `u${i}`,
      objectName: `vol/ev1/b1/u${i}.jpg`,
      fileName: `${i}.jpg`,
      bytes: 10,
    }));

    const res = await request(buildServer()).post('/api/volunteer/upload/complete').send({ ...body, items });

    expect(res.status).toBe(200);
    expect(enqueueStagedBatch).toHaveBeenCalledTimes(1);
    expect(enqueueStagedBatch.mock.calls[0]?.[2]).toHaveLength(50);
  });
});
