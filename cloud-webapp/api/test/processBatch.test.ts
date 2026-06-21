import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Machine-auth secret must be set before config.ts is imported by the server.
process.env.SYNC_TRIGGER_TOKEN = 'cron-secret';

const enqueueStagedBatch = vi.fn();
const validateUploadLink = vi.fn();

vi.mock('../src/services/volunteerUploadService.js', () => ({
  validateUploadLink,
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
  updateUploadBatch: vi.fn(),
}));

const { buildServer } = await import('../src/server.js');

beforeEach(() => {
  enqueueStagedBatch.mockReset();
  validateUploadLink.mockReset();
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
    });
    const app = buildServer();
    const res = await request(app)
      .post('/api/internal/process-batch')
      .set('x-sync-token', 'cron-secret')
      .send({ token: 't', batchId: 'b1', objectNames: ['vol/ev1/b1/u1.jpg', 'vol/ev1/b1/u2.jpg'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, copied: 2, skippedDuplicates: 1 });
    expect(res.body.skippedDuplicateNames).toEqual(['dup.jpg']);
    expect(enqueueStagedBatch).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'ev1' }),
      'b1',
      ['vol/ev1/b1/u1.jpg', 'vol/ev1/b1/u2.jpg'],
    );
  });
});
