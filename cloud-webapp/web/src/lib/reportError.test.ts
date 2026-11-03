import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Per-page dedupe + cap for client error reports. The regression this pins: one
// iPhone Safari tab on the Find-Me page sent 60 identical "Connection to Indexed
// Database server lost" rejections to /api/client-errors, each logged at ERROR
// by the api and each a potential alert email.

const apiPost = vi.fn(async (_path: string, _body: unknown): Promise<unknown> => ({ ok: true }));
vi.mock('./api.js', () => ({ apiPost: (path: string, body: unknown) => apiPost(path, body) }));

const {
  reportClientError,
  resetClientErrorReporting,
  installGlobalErrorReporting,
  MAX_REPORTS_PER_PAGE,
  REPEAT_FOLLOWUP_AT,
  ACTION_REPEAT_WINDOW_MS,
} = await import('./reportError.js');

const IDB_LOST = 'Connection to Indexed Database server lost. Refresh the page to try again';

/** Let the previous POST settle so the in-flight guard is clear — a real flood
 *  is sequential, and the old guard already stopped overlapping reports. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function posted(): Array<{ kind: string; message: string; repeatCount?: number }> {
  return apiPost.mock.calls.map(
    (c) => c[1] as { kind: string; message: string; repeatCount?: number },
  );
}

beforeEach(() => {
  resetClientErrorReporting();
  apiPost.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reportClientError dedupe', () => {
  it('60 identical rejections in a row produce two POSTs: the first and one follow-up with the count', async () => {
    for (let i = 0; i < 60; i += 1) {
      reportClientError('unhandled_rejection', IDB_LOST);
      await settle();
    }
    expect(apiPost).toHaveBeenCalledTimes(2);
    const [first, followup] = posted();
    expect(first?.message).toBe(IDB_LOST);
    expect(first?.repeatCount).toBeUndefined();
    expect(followup?.message).toBe(IDB_LOST);
    expect(followup?.repeatCount).toBe(REPEAT_FOLLOWUP_AT);
    expect(apiPost.mock.calls[0]?.[0]).toBe('/api/client-errors');
  });

  it('the same flood through the real unhandledrejection handler is deduped too', async () => {
    installGlobalErrorReporting();
    for (let i = 0; i < 60; i += 1) {
      const e = new Event('unhandledrejection') as Event & { reason: unknown };
      e.reason = new Error(IDB_LOST);
      window.dispatchEvent(e);
      await settle();
    }
    expect(apiPost).toHaveBeenCalledTimes(2);
  });

  it('does not report a cancelled Google sign-in popup', async () => {
    installGlobalErrorReporting();
    for (const code of ['auth/cancelled-popup-request', 'auth/popup-closed-by-user']) {
      const e = new Event('unhandledrejection') as Event & { reason: unknown };
      e.reason = Object.assign(new Error(`Firebase: Error (${code}).`), { code });
      window.dispatchEvent(e);
      await settle();
    }
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('keys on a normalised message: whitespace differences and text past 200 chars do not split it', async () => {
    const base = 'x'.repeat(200);
    reportClientError('unhandled_error', `${base} tail one`);
    await settle();
    reportClientError('unhandled_error', `  ${base}   tail two`);
    await settle();
    reportClientError('unhandled_error', `${base}\ttail three`);
    await settle();
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('a different kind or a different message is reported separately', async () => {
    reportClientError('unhandled_rejection', IDB_LOST);
    await settle();
    reportClientError('unhandled_error', IDB_LOST);
    await settle();
    reportClientError('unhandled_rejection', 'something else');
    await settle();
    expect(apiPost).toHaveBeenCalledTimes(3);
  });

  it('a global-handler error stays suppressed for the whole page load, however long it lasts', async () => {
    vi.useFakeTimers();
    reportClientError('unhandled_rejection', IDB_LOST);
    await settle();
    vi.advanceTimersByTime(60 * 60_000);
    reportClientError('unhandled_rejection', IDB_LOST);
    await settle();
    expect(apiPost).toHaveBeenCalledTimes(1);
  });
});

describe('action-scoped kinds (download_failed, selfie_stuck)', () => {
  const MSG = 'Save to Photos: every original failed to load';

  it('a new action after the window reports again', async () => {
    vi.useFakeTimers();
    reportClientError('download_failed', MSG);
    await settle();
    vi.advanceTimersByTime(ACTION_REPEAT_WINDOW_MS);
    reportClientError('download_failed', MSG);
    await settle();
    reportClientError('selfie_stuck', 'Selfie rejected 3 times in a row');
    await settle();
    vi.advanceTimersByTime(ACTION_REPEAT_WINDOW_MS + 1);
    reportClientError('selfie_stuck', 'Selfie rejected 3 times in a row');
    await settle();
    expect(apiPost).toHaveBeenCalledTimes(4);
  });

  it('an exact repeat inside the window is dropped', async () => {
    vi.useFakeTimers();
    reportClientError('download_failed', MSG);
    await settle();
    vi.advanceTimersByTime(ACTION_REPEAT_WINDOW_MS - 1);
    reportClientError('download_failed', MSG);
    await settle();
    expect(apiPost).toHaveBeenCalledTimes(1);
  });
});

describe('per-page cap', () => {
  it(`sends at most ${MAX_REPORTS_PER_PAGE} reports per page load, whatever they are`, async () => {
    for (let i = 0; i < 50; i += 1) {
      reportClientError('unhandled_error', `distinct error ${i}`);
      await settle();
    }
    expect(apiPost).toHaveBeenCalledTimes(MAX_REPORTS_PER_PAGE);
  });

  it('a fresh page load (reset) starts over', async () => {
    reportClientError('unhandled_rejection', IDB_LOST);
    await settle();
    resetClientErrorReporting();
    reportClientError('unhandled_rejection', IDB_LOST);
    await settle();
    expect(apiPost).toHaveBeenCalledTimes(2);
  });
});

describe('hard rules', () => {
  it('never throws, even when the POST throws synchronously', async () => {
    apiPost.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() => reportClientError('unhandled_error', 'first')).not.toThrow();
    // The in-flight flag was released, so the next report still goes out.
    reportClientError('unhandled_error', 'second');
    await settle();
    expect(apiPost).toHaveBeenCalledTimes(2);
  });

  it('never throws when the POST rejects', async () => {
    apiPost.mockImplementationOnce(async () => {
      throw new Error('network down');
    });
    expect(() => reportClientError('unhandled_error', 'x')).not.toThrow();
    await settle();
  });

  it('drops a report while one is in flight (no recursion)', async () => {
    let release: () => void = () => {};
    apiPost.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ ok: true }))),
    );
    reportClientError('unhandled_error', 'outer');
    reportClientError('unhandled_error', 'inner');
    expect(apiPost).toHaveBeenCalledTimes(1);
    release();
    await settle();
  });
});
