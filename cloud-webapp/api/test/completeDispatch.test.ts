import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const validateUploadLink = vi.fn();
const enqueueStagedBatch = vi.fn();
const isUploadDispatchConfigured = vi.fn();
const enqueueProcessBatchTask = vi.fn();
const initUploadBatch = vi.fn();

vi.mock('../src/services/volunteerUploadService.js', () => ({
  validateUploadLink,
  enqueueStagedBatch,
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
  initUploadBatch,
  getUploadBatch: vi.fn(),
  updateUploadBatch: vi.fn(),
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
  initUploadBatch.mockReset().mockResolvedValue(undefined);
});

describe('POST /api/volunteer/upload/complete dispatch behaviour', () => {
  it('queues to the worker and returns "received" without copying inline', async () => {
    isUploadDispatchConfigured.mockReturnValue(true);
    enqueueProcessBatchTask.mockResolvedValue(undefined);

    const res = await request(buildServer()).post('/api/volunteer/upload/complete').send(body);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/saving in the background/);
    expect(initUploadBatch).toHaveBeenCalledWith('b1', 'ev1', 'link1', 1, 'received');
    expect(enqueueProcessBatchTask).toHaveBeenCalledTimes(1);
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
});
