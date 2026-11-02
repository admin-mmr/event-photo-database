import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { STALL_MS, StallError, fetchWithStall, watchXhr } from './stallWatchdog.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('watchXhr', () => {
  it('aborts after STALL_MS of silence and reports it as a stall', () => {
    const abort = vi.fn();
    const w = watchXhr({ abort });
    vi.advanceTimersByTime(STALL_MS - 1);
    expect(abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(w.stalled).toBe(true);
  });

  it('touch() restarts the countdown — silence, not total time, is what counts', () => {
    const abort = vi.fn();
    const w = watchXhr({ abort });
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(STALL_MS - 1);
      w.touch();
    }
    expect(abort).not.toHaveBeenCalled();
    expect(w.stalled).toBe(false);
  });

  it('stop() disarms it', () => {
    const abort = vi.fn();
    const w = watchXhr({ abort });
    w.stop();
    vi.advanceTimersByTime(10 * STALL_MS);
    expect(abort).not.toHaveBeenCalled();
  });
});

describe('fetchWithStall', () => {
  it('rejects with StallError when the request never answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_u: string, init?: RequestInit) =>
          new Promise((_r, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
      ),
    );
    const p = fetchWithStall('Probe', 'https://x');
    const settled = expect(p).rejects.toBeInstanceOf(StallError);
    await vi.advanceTimersByTimeAsync(STALL_MS);
    await settled;
  });

  it('passes a real network error through unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await expect(fetchWithStall('Probe', 'https://x')).rejects.toThrow('Failed to fetch');
  });
});
