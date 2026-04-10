import { ResultStatus } from '../types/enums';
import { ServiceResult } from '../types/responses';
import { getAllRows, appendRow, updateRow, findRowIndex } from './sheetService';
import { getConfig, COLUMNS, RATE_LIMIT_WINDOW_MS } from '../config/constants';

/**
 * RateLimitService — per-API-key hourly request counter.
 *
 * Storage: a "Rate_Limit" Google Sheet with columns:
 *   API_KEY (string) | WINDOW_START (ISO 8601) | REQUEST_COUNT (number)
 *
 * Algorithm (sliding fixed-window):
 *   1. Find the row for the given key.
 *   2. If no row exists → create one, count = 1 → allow.
 *   3. If the current time is past WINDOW_START + 1 hour → reset window, count = 1 → allow.
 *   4. If count < MAX_API_REQUESTS_PER_HOUR → increment → allow.
 *   5. Otherwise → reject with 429.
 *
 * Concurrency: GAS scripts execute single-threaded per deployment, so no
 * lock is required for the Sheet read-increment-write cycle.
 */

/** Result shape for the rate-limit check */
export interface RateLimitCheckResult {
  readonly allowed: boolean;
  readonly requestCount: number;
  readonly limitPerHour: number;
  readonly windowStart: string;
  readonly windowResetsAt: string;
}

/**
 * Checks whether the given API key is within its hourly request limit,
 * and if allowed, increments the counter.
 *
 * Returns SUCCESS (data.allowed === true) or SUCCESS (data.allowed === false).
 * Returns ERROR only if the Sheet cannot be read (infrastructure failure).
 */
export function checkAndIncrementRateLimit(
  apiKey: string
): ServiceResult<RateLimitCheckResult> {
  const config = getConfig();
  const sheetName = config.SHEET_NAMES.RATE_LIMIT;
  const limit = config.MAX_API_REQUESTS_PER_HOUR;
  const now = Date.now();
  const C = COLUMNS.RATE_LIMIT;

  let rows: unknown[][];
  try {
    rows = getAllRows(sheetName);
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Rate limit sheet unavailable: ${String(err)}`,
    };
  }

  // Find existing row for this key
  const rowIndex = findRowIndex(sheetName, C.API_KEY, apiKey);

  let windowStart: number;
  let count: number;

  if (rowIndex === -1) {
    // Brand new key — create row, count = 1
    windowStart = now;
    count = 1;
    try {
      appendRow(sheetName, [apiKey, new Date(windowStart).toISOString(), count]);
    } catch (err) {
      return { status: ResultStatus.ERROR, message: `Failed to write rate limit row: ${String(err)}` };
    }
  } else {
    // Existing row — read it
    // rows is 0-based; rowIndex is 1-based Sheets row → rows[rowIndex - 2]
    const dataRow = rows[rowIndex - 2];
    const storedWindowStart = String(dataRow?.[C.WINDOW_START] ?? '');
    const storedCount = Number(dataRow?.[C.REQUEST_COUNT] ?? 0);

    const parsedWindowStart = new Date(storedWindowStart).getTime();
    const windowExpired = isNaN(parsedWindowStart) || (now - parsedWindowStart) >= RATE_LIMIT_WINDOW_MS;

    if (windowExpired) {
      // Reset window
      windowStart = now;
      count = 1;
    } else {
      windowStart = parsedWindowStart;
      count = storedCount + 1;
    }

    // Reject before writing if over limit
    if (count > limit) {
      const windowResetsAt = new Date(windowStart + RATE_LIMIT_WINDOW_MS).toISOString();
      return {
        status: ResultStatus.SUCCESS,
        message: `Rate limit exceeded: ${limit} requests/hour`,
        data: {
          allowed: false,
          requestCount: count - 1, // current count without this request
          limitPerHour: limit,
          windowStart: new Date(windowStart).toISOString(),
          windowResetsAt,
        },
      };
    }

    try {
      updateRow(sheetName, rowIndex, [apiKey, new Date(windowStart).toISOString(), count]);
    } catch (err) {
      return { status: ResultStatus.ERROR, message: `Failed to update rate limit row: ${String(err)}` };
    }
  }

  const windowResetsAt = new Date(windowStart + RATE_LIMIT_WINDOW_MS).toISOString();
  return {
    status: ResultStatus.SUCCESS,
    message: `Request ${count}/${limit} in current window`,
    data: {
      allowed: true,
      requestCount: count,
      limitPerHour: limit,
      windowStart: new Date(windowStart).toISOString(),
      windowResetsAt,
    },
  };
}
