import { describe, it, expect, vi, beforeEach } from 'vitest';

// Configure dispatch before config.ts is imported.
process.env.UPLOAD_DISPATCH_TO_WORKER = 'true';
process.env.GCP_PROJECT_ID = 'proj';
process.env.UPLOAD_TASKS_QUEUE = 'upload-process';
process.env.UPLOAD_TASKS_LOCATION = 'us-central1';
process.env.UPLOAD_WORKER_URL = 'https://api.example.com';
process.env.SYNC_TRIGGER_TOKEN = 'cron-secret';

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getClient() {
      return { getAccessToken: async () => ({ token: 'access-token' }) };
    }
  },
}));
vi.mock('../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { isUploadDispatchConfigured, enqueueProcessBatchTask, processBatchTaskExists, processBatchTaskId } =
  await import('../src/services/uploadDispatch.js');

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('isUploadDispatchConfigured', () => {
  it('is true when flag + queue + worker URL + token are all set', () => {
    expect(isUploadDispatchConfigured()).toBe(true);
  });
});

describe('enqueueProcessBatchTask', () => {
  it('POSTs a base64 HTTP-target task to the Cloud Tasks queue', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchSpy);

    await enqueueProcessBatchTask({
      token: 'link-tok',
      batchId: 'b1',
      objectNames: ['vol/ev1/b1/u1.jpg'],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://cloudtasks.googleapis.com/v2/projects/proj/locations/us-central1/queues/upload-process/tasks',
    );
    expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer access-token');
    const sent = JSON.parse(String(opts.body));
    expect(sent.task.name).toBe(
      'projects/proj/locations/us-central1/queues/upload-process/tasks/b1',
    );
    expect(sent.task.httpRequest.url).toBe('https://api.example.com/api/internal/process-batch');
    expect(sent.task.httpRequest.headers['X-Sync-Token']).toBe('cron-secret');
    const decoded = JSON.parse(Buffer.from(sent.task.httpRequest.body, 'base64').toString('utf8'));
    expect(decoded).toEqual({ token: 'link-tok', batchId: 'b1', objectNames: ['vol/ev1/b1/u1.jpg'] });
  });

  it('treats a 409 (task already exists) as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 409, text: async () => 'ALREADY_EXISTS' }),
    );
    await expect(
      enqueueProcessBatchTask({ token: 't', batchId: 'b1', objectNames: ['x'] }),
    ).resolves.toBeUndefined();
  });

  it('throws on a non-2xx (non-409) so the caller can fall back to inline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }),
    );
    await expect(
      enqueueProcessBatchTask({ token: 't', batchId: 'b1', objectNames: ['x'] }),
    ).rejects.toThrow(/Cloud Tasks create 500/);
  });
});

describe('chunk task naming', () => {
  it('keeps the bare batchId for the first chunk, so a double /complete still dedups', () => {
    expect(processBatchTaskId('b1')).toBe('b1');
    expect(processBatchTaskId('b1', 0)).toBe('b1');
  });

  it('gives a continuation its own task, carrying its chunk index', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchSpy);

    await enqueueProcessBatchTask({ token: 'link-tok', batchId: 'b1', objectNames: ['vol/ev1/b1/u9.jpg'], chunk: 2 });

    const sent = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent.task.name).toBe('projects/proj/locations/us-central1/queues/upload-process/tasks/b1-c2');
    const decoded = JSON.parse(Buffer.from(sent.task.httpRequest.body, 'base64').toString('utf8'));
    expect(decoded).toEqual({ token: 'link-tok', batchId: 'b1', objectNames: ['vol/ev1/b1/u9.jpg'], chunk: 2 });
  });
});

describe('processBatchTaskExists', () => {
  const TASK_URL = 'https://cloudtasks.googleapis.com/v2/projects/proj/locations/us-central1/queues/upload-process/tasks/b1-c1';

  it('is true while the task is queued, backing off, or running', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
    vi.stubGlobal('fetch', fetchSpy);
    expect(await processBatchTaskExists('b1-c1')).toBe(true);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(TASK_URL);
  });

  it('is false once the queue no longer has it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' }));
    expect(await processBatchTaskExists('b1-c1')).toBe(false);
  });

  it('throws on any other answer, so "unknown" can never read as "dead"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'unavailable' }));
    await expect(processBatchTaskExists('b1-c1')).rejects.toThrow(/503/);
  });
});
