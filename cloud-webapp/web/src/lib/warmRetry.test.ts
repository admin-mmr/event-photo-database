import { describe, it, expect, vi } from 'vitest';

import { ApiError } from './api.js';
import { retryWhileWarming } from './warmRetry.js';

// 2026-11-04 12:27: the first search after the matcher scaled from zero took
// 81.6s at the api and the user saw "search failed". The api now answers 503
// matcher_warming_up before the 60s Hosting cutoff, and the page retries once.
const warming = (retryAfterSec?: number) =>
  new ApiError(503, 'matcher_warming_up', 'warming', retryAfterSec === undefined ? {} : { retryAfterSec });

describe('retryWhileWarming', () => {
  it('retries once, after the wait the api asked for, and returns the second answer', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(warming(3)).mockResolvedValueOnce('results');
    const sleep = vi.fn(async () => undefined);
    const onWait = vi.fn();
    await expect(retryWhileWarming(attempt, { sleep, onWait })).resolves.toBe('results');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(onWait).toHaveBeenCalledTimes(1);
  });

  it('gives up after one retry', async () => {
    const attempt = vi.fn().mockRejectedValue(warming());
    await expect(retryWhileWarming(attempt, { sleep: async () => undefined })).rejects.toMatchObject({
      code: 'matcher_warming_up',
    });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('never retries any other failure', async () => {
    const attempt = vi.fn().mockRejectedValue(new ApiError(422, 'no_usable_face', 'no face'));
    await expect(retryWhileWarming(attempt, { sleep: async () => undefined })).rejects.toMatchObject({
      code: 'no_usable_face',
    });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
