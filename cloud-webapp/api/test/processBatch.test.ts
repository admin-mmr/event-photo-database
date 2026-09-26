import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Machine-auth secret must be set before config.ts is imported by the server.
process.env.SYNC_TRIGGER_TOKEN = 'cron-secret';

const enqueueStagedBatch = vi.fn();
const validateUploadLink = vi.fn();
const loadUploadLinkById = vi.fn();
const isUploadDispatchConfigured = vi.fn();
const enqueueProcessBatchTask = vi.fn();
const updateUploadBatch = vi.fn();

vi.mock('../src/services/volunteerUploadService.js', () => ({
  validateUploadLink,
  loadUploadLinkById,
  enqueueStagedBatch,
  createResumableSession: vi.fn(),
  // Real error class shape so the route's `instanceof` check still type-checks.
  UploadLinkError: class UploadLinkError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
// The worker reads/writes status via uploadBatchService inside enqueueStagedBatch,
// which is mocked above — but the status GET endpoint imports getUploadBatch, so
// keep the module importable.
vi.mock('../src/services/uploadBatchService.js', () => ({
  getUploadBatch: vi.fn(),
  initUploadBatch: vi.fn(),
  updateUploadBatch,
}));
vi.mock('../src/services/uploadDispatch.js', () => ({
  isUploadDispatchConfigured,
  enqueueProcessBatchTask,
  processBatchTaskId: (batchId: string, chunk = 0) => (chunk > 0 ? `${batchId}-c${chunk}` : batchId),
}));

const { buildServer } = await import('../src/server.js');

const LINK = { eventId: 'ev1', linkId: 'link1', clubName: 'ClubA', tag: '' };

beforeEach(() => {
  enqueueStagedBatch.mockReset();
  validateUploadLink.mockReset();
  loadUploadLinkById.mockReset();
  enqueueProcessBatchTask.mockReset();
  updateUploadBatch.mockReset();
  isUploadDispatchConfigured.mockReset().mockReturnValue(false);
});

describe('POST /api/internal/process-batch', () => {
  it('401s without a valid machine token', async () => {
    const app = buildServer();
    const res = await request(app)
      .post('/api/internal/process-batch')
      .send({ token: 't', batchId: 'b1', objectNames: ['vol/ev1/b1/u1.jpg'] });
    expect(res.status).toBe(401);
    expect(enqueueStagedBatch).not.toHaveBeenCalled();
  });

  it('400s on a malformed body even with a valid token', async () => {
    const app = buildServer();
    const res = await request(app)
      .post('/api/internal/process-batch')
      .set('x-sync-token', 'cron-secret')
      .send({ token: 't', batchId: 'b1' }); // missing objectNames
    expect(res.status).toBe(400);
    expect(enqueueStagedBatch).not.toHaveBeenCalled();
  });

  it('processes the batch and returns counts with a valid token', async () => {
    validateUploadLink.mockResolvedValue({ eventId: 'ev1', linkId: 'link1', clubName: 'ClubA', tag: '' });
    enqueueStagedBatch.mockResolvedValue({
      copied: 2,
      skippedDuplicates: 1,
      skippedDuplicateNames: ['dup.jpg'],
      remaining: [],
    });
    const app = buildServer();
    const res = await request(app)
      .post('/api/internal/process-batch')
      .set('x-sync-token', 'cron-secret')
      .send({ token: 't', batchId: 'b1', objectNames: ['vol/ev1/b1/u1.jpg', 'vol/ev1/b1/u2.jpg'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, copied: 2, skippedDuplicates: 1 });
    expect(res.body.skippedDuplicateNames).toEqual(['dup.jpg']);
    // Not under Cloud Tasks (dispatch unconfigured) → one piece, no limits.
    expect(enqueueStagedBatch).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'ev1' }),
      'b1',
      ['vol/ev1/b1/u1.jpg', 'vol/ev1/b1/u2.jpg'],
      { chunk: 0 },
    );
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
  });
});

describe('POST /api/internal/process-batch — chunked under Cloud Tasks', () => {
  const names = ['vol/ev1/b1/u1.jpg', 'vol/ev1/b1/u2.jpg', 'vol/ev1/b1/u3.jpg'];

  it('runs one bounded chunk and hands the rest to a continuation task', async () => {
    isUploadDispatchConfigured.mockReturnValue(true);
    validateUploadLink.mockResolvedValue(LINK);
    enqueueStagedBatch.mockResolvedValue({
      copied: 1,
      skippedDuplicates: 0,
      skippedDuplicateNames: [],
      remaining: names.slice(1),
    });

    const res = await request(buildServer())
      .post('/api/internal/process-batch')
      .set('x-sync-token', 'cron-secret')
      .send({ token: 't', batchId: 'b1', objectNames: names });

    expect(res.status).toBe(200);
    expect(enqueueStagedBatch).toHaveBeenCalledWith(LINK, 'b1', names, {
      chunk: 0,
      maxFiles: 300,
      budgetMs: 15 * 60_000,
    });
    expect(enqueueProcessBatchTask).toHaveBeenCalledWith({
      token: 't',
      batchId: 'b1',
      objectNames: names.slice(1),
      chunk: 1,
    });
    expect(updateUploadBatch).toHaveBeenCalledWith('b1', { pendingTask: 'b1-c1' });
  });

  it('keeps a recovery batch on its linkId when it continues', async () => {
    isUploadDispatchConfigured.mockReturnValue(true);
    loadUploadLinkById.mockResolvedValue(LINK);
    enqueueStagedBatch.mockResolvedValue({
      copied: 1,
      skippedDuplicates: 0,
      skippedDuplicateNames: [],
      remaining: names.slice(2),
    });

    const res = await request(buildServer())
      .post('/api/internal/process-batch')
      .set('x-sync-token', 'cron-secret')
      .send({ linkId: 'link1', batchId: 'b1-rec1', objectNames: names.slice(1), chunk: 2 });

    expect(res.status).toBe(200);
    expect(enqueueProcessBatchTask).toHaveBeenCalledWith({
      linkId: 'link1',
      batchId: 'b1-rec1',
      objectNames: names.slice(2),
      chunk: 3,
    });
  });

  it('does not enqueue anything once the batch is finished', async () => {
    isUploadDispatchConfigured.mockReturnValue(true);
    validateUploadLink.mockResolvedValue(LINK);
    enqueueStagedBatch.mockResolvedValue({ copied: 3, skippedDuplicates: 0, skippedDuplicateNames: [], remaining: [] });

    const res = await request(buildServer())
      .post('/api/internal/process-batch')
      .set('x-sync-token', 'cron-secret')
      .send({ token: 't', batchId: 'b1', objectNames: names, chunk: 4 });

    expect(res.status).toBe(200);
    expect(enqueueProcessBatchTask).not.toHaveBeenCalled();
  });

  it('500s when the hand-off fails, so Cloud Tasks retries the chunk instead of dropping the rest', async () => {
    isUploadDispatchConfigured.mockReturnValue(true);
    validateUploadLink.mockResolvedValue(LINK);
    enqueueStagedBatch.mockResolvedValue({
      copied: 1,
      skippedDuplicates: 0,
      skippedDuplicateNames: [],
      remaining: names.slice(1),
    });
    enqueueProcessBatchTask.mockRejectedValue(new Error('tasks down'));

    const res = await request(buildServer())
      .post('/api/internal/process-batch')
      .set('x-sync-token', 'cron-secret')
      .send({ token: 't', batchId: 'b1', objectNames: names });

    expect(res.status).toBe(500);
    expect(updateUploadBatch).not.toHaveBeenCalledWith('b1', expect.objectContaining({ pendingTask: expect.anything() }));
  });

  it('rejects a negative chunk index', async () => {
    const res = await request(buildServer())
      .post('/api/internal/process-batch')
      .set('x-sync-token', 'cron-secret')
      .send({ token: 't', batchId: 'b1', objectNames: names, chunk: -1 });
    expect(res.status).toBe(400);
    expect(enqueueStagedBatch).not.toHaveBeenCalled();
  });
});
