/**
 * requestLogLevel — a 5xx pages (ERROR) unless the route said it was expected.
 * 2026-11-05/06: Find-Me's handled 503 matcher_warming_up paged on every
 * matcher cold start.
 */
import { describe, it, expect } from 'vitest';
import type { ServerResponse } from 'node:http';

import { requestLogLevel } from '../src/lib/requestLogLevel.js';

const res = (statusCode: number, locals?: Record<string, unknown>) =>
  ({ statusCode, ...(locals ? { locals } : {}) }) as unknown as ServerResponse;

describe('requestLogLevel', () => {
  it('keeps 5xx at ERROR, 4xx at WARN, the rest at INFO', () => {
    expect(requestLogLevel(res(503), undefined)).toBe('error');
    expect(requestLogLevel(res(500, {}), undefined)).toBe('error');
    expect(requestLogLevel(res(422), undefined)).toBe('warn');
    expect(requestLogLevel(res(200), undefined)).toBe('info');
    expect(requestLogLevel(res(200), new Error('boom'))).toBe('error');
  });

  it('logs a 5xx the route marked expected at WARN', () => {
    expect(requestLogLevel(res(503, { expectedFailure: true }), undefined)).toBe('warn');
    // pino-http passes an Error for every 5xx; the mark still wins.
    expect(requestLogLevel(res(503, { expectedFailure: true }), new Error('failed with status code 503'))).toBe('warn');
  });
});
