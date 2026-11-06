/**
 * requestLogLevel.ts — the severity pino-http logs a finished request at.
 *
 * Every 5xx is ERROR, which the Cloud Monitoring `severity>=ERROR` policy emails
 * on. A route can mark a 5xx it answered ON PURPOSE as expected by setting
 * `res.locals.expectedFailure = true`; that one is logged at WARN instead.
 * The first user of it: Find-Me's 503 `matcher_warming_up`, which the page
 * retries on its own. Logged at ERROR, it paged on every matcher cold start
 * (3 on 2026-11-05/06) although nothing had failed.
 */
import type { ServerResponse } from 'node:http';

type Level = 'error' | 'warn' | 'info';

export function requestLogLevel(res: ServerResponse, err: Error | undefined): Level {
  const status = res.statusCode ?? 0;
  const expected = Boolean((res as ServerResponse & { locals?: { expectedFailure?: boolean } }).locals?.expectedFailure);
  if (err && !expected) return 'error';
  if (status >= 500) return expected ? 'warn' : 'error';
  if (status >= 400) return 'warn';
  return 'info';
}
