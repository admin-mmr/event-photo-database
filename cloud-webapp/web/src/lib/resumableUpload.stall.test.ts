import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// uploadFileResumable end to end against a fake XHR: the regression these pin is
// a chunk PUT that goes silent. Before the watchdog it never settled, so the
// upload page's /complete never ran and a whole session stayed in staging.

vi.mock('./uploadDb.js', () => ({
  getSession: vi.fn(async () => undefined),
  putSession: vi.fn(async () => undefined),
  deleteSession: vi.fn(async () => undefined),
  sessionKey: () => 'k',
}));
vi.mock('./recaptcha.js', () => ({ getRecaptchaToken: vi.fn(async () => undefined) }));
const apiPost = vi.fn();
vi.mock('./api.js', () => ({ apiPost: (...a: unknown[]) => apiPost(...a) }));

const { uploadFileResumable, AbortError } = await import('./resumableUpload.js');
const { STALL_MS, StallError } = await import('./stallWatchdog.js');

/** Each PUT gets the next behaviour: 'ok' answers 200, 'hang' never answers. */
let script: Array<'ok' | 'hang'> = [];
let sent = 0;
const xhrs: FakeXhr[] = [];

class FakeXhr {
  status = 0;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(): void {}
  setRequestHeader(): void {}
  getResponseHeader(): string | null {
    return null;
  }
  abort(): void {
    this.onabort?.();
  }
  send(): void {
    sent += 1;
    xhrs.push(this);
    if ((script.shift() ?? 'ok') === 'hang') return;
    queueMicrotask(() => {
      this.status = 200;
      this.onload?.();
    });
  }
}

const file = new File([new Uint8Array(1024)], 'a.jpg', { type: 'image/jpeg' });

beforeEach(() => {
  vi.useFakeTimers();
  script = [];
  sent = 0;
  xhrs.length = 0;
  apiPost.mockResolvedValue({
    ok: true,
    uploadId: 'u1',
    sessionUri: 'https://gcs/session',
    objectName: 'staging/e/b/u1.jpg',
    batchId: 'b',
    protocol: 'gcs-resumable',
  });
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  // Status probes: nothing committed yet.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ status: 308, headers: { get: () => null } }) as unknown as Response),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('uploadFileResumable — stalled connections', () => {
  it('abandons a silent chunk after STALL_MS and retries it, instead of hanging forever', async () => {
    script = ['hang', 'ok'];
    const p = uploadFileResumable('tok', 'b', file, 'image/jpeg');
    await vi.advanceTimersByTimeAsync(STALL_MS + 30_000);
    await expect(p).resolves.toEqual({
      uploadId: 'u1',
      objectName: 'staging/e/b/u1.jpg',
      bytes: 1024,
    });
    expect(sent).toBe(2);
  });

  it('gives up with StallError once the retries are spent, so the page can still finalize the rest', async () => {
    script = Array(10).fill('hang');
    const p = uploadFileResumable('tok', 'b', file, 'image/jpeg');
    const settled = expect(p).rejects.toBeInstanceOf(StallError);
    await vi.advanceTimersByTimeAsync(20 * STALL_MS);
    await settled;
  });

  it('upload progress keeps a slow chunk alive', async () => {
    script = ['hang'];
    const p = uploadFileResumable('tok', 'b', file, 'image/jpeg');
    await vi.advanceTimersByTimeAsync(0); // probe done, PUT in flight
    // Three ticks of progress, each just inside the window: never declared dead.
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(STALL_MS - 1000);
      xhrs
        .at(-1)
        ?.upload.onprogress?.({ lengthComputable: true, loaded: 100 * (i + 1) } as ProgressEvent);
    }
    expect(sent).toBe(1);
    const xhr = xhrs.at(-1)!;
    xhr.status = 200;
    xhr.onload?.();
    await expect(p).resolves.toMatchObject({ bytes: 1024 });
  });

  it('a user Cancel still surfaces as AbortError, not a retryable stall', async () => {
    script = ['hang'];
    const ctrl = new AbortController();
    const p = uploadFileResumable('tok', 'b', file, 'image/jpeg', { signal: ctrl.signal });
    const settled = expect(p).rejects.toBeInstanceOf(AbortError);
    await vi.advanceTimersByTimeAsync(1000);
    ctrl.abort();
    await settled;
    expect(sent).toBe(1);
  });

  it('a session mint that never answers fails the file instead of parking the worker', async () => {
    apiPost.mockImplementation(
      (_p: string, _b: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise((_r, reject) =>
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    const p = uploadFileResumable('tok', 'b', file, 'image/jpeg');
    const settled = expect(p).rejects.toBeInstanceOf(StallError);
    await vi.advanceTimersByTimeAsync(STALL_MS);
    await settled;
  });
});
