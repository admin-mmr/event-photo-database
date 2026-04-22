import {
  checkAndIncrementRateLimit,
} from '../../src/services/rateLimitService';
import {
  resetMockSheets,
  mockSheets,
  createMockSheet,
  TEST_CLUB_ADMIN_EMAIL,
} from '../mocks/gasGlobals';
import { ResultStatus } from '../../src/types/enums';
import { RATE_LIMIT_WINDOW_MS } from '../../src/config/constants';

// ─── Rate_Limit sheet seeder ──────────────────────────────────────────────────

function seedRateLimitRow(
  apiKey: string,
  windowStart: Date,
  count: number
): void {
  const row = [apiKey, windowStart.toISOString(), count];
  mockSheets.Rate_Limit = createMockSheet([row]);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('checkAndIncrementRateLimit()', () => {
  beforeEach(() => {
    resetMockSheets();
  });

  it('allows a new key and creates a row with count = 1', () => {
    const result = checkAndIncrementRateLimit(TEST_CLUB_ADMIN_EMAIL);
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.allowed).toBe(true);
    expect(result.data!.requestCount).toBe(1);
    // appendRow was called on the Rate_Limit sheet mock
    expect(mockSheets.Rate_Limit.appendRow).toHaveBeenCalledTimes(1);
  });

  it('increments count for an existing key within the window', () => {
    const now = new Date();
    seedRateLimitRow(TEST_CLUB_ADMIN_EMAIL, now, 5);

    const result = checkAndIncrementRateLimit(TEST_CLUB_ADMIN_EMAIL);
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.allowed).toBe(true);
    expect(result.data!.requestCount).toBe(6);
  });

  it('resets the window and allows when window has expired', () => {
    // Window started 2 hours ago — should be expired
    const oldWindow = new Date(Date.now() - 2 * RATE_LIMIT_WINDOW_MS);
    seedRateLimitRow(TEST_CLUB_ADMIN_EMAIL, oldWindow, 59);

    const result = checkAndIncrementRateLimit(TEST_CLUB_ADMIN_EMAIL);
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.allowed).toBe(true);
    expect(result.data!.requestCount).toBe(1); // reset to 1
  });

  it('denies the request when count equals the limit (60)', () => {
    const now = new Date();
    seedRateLimitRow(TEST_CLUB_ADMIN_EMAIL, now, 60);

    const result = checkAndIncrementRateLimit(TEST_CLUB_ADMIN_EMAIL);
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.allowed).toBe(false);
    expect(result.data!.requestCount).toBe(60); // not incremented
  });

  it('includes limitPerHour in the result', () => {
    const result = checkAndIncrementRateLimit(TEST_CLUB_ADMIN_EMAIL);
    expect(result.data!.limitPerHour).toBe(60);
  });

  it('includes windowStart as a valid ISO string', () => {
    const result = checkAndIncrementRateLimit(TEST_CLUB_ADMIN_EMAIL);
    expect(new Date(result.data!.windowStart).getTime()).not.toBeNaN();
  });

  it('includes windowResetsAt approximately 1 hour after windowStart', () => {
    const result = checkAndIncrementRateLimit(TEST_CLUB_ADMIN_EMAIL);
    const start  = new Date(result.data!.windowStart).getTime();
    const resets = new Date(result.data!.windowResetsAt).getTime();
    expect(resets - start).toBeCloseTo(RATE_LIMIT_WINDOW_MS, -3); // within 1 second
  });

  it('returns ERROR when the Rate_Limit sheet cannot be read', () => {
    // Remove the sheet from the mock
    delete mockSheets.Rate_Limit;
    const result = checkAndIncrementRateLimit(TEST_CLUB_ADMIN_EMAIL);
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toMatch(/Rate limit sheet unavailable/i);
    // Restore for other tests
    mockSheets.Rate_Limit = createMockSheet([]);
  });
});
