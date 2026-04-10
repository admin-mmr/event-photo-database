import { authenticateApiKey } from '../../src/middleware/authMiddleware';
import {
  resetMockSheets,
  TEST_API_CLIENT_EMAIL,
  TEST_USER_EMAIL,
  TEST_ADMIN_EMAIL,
} from '../mocks/gasGlobals';
import { ResultStatus, UserRole, UserStatus } from '../../src/types/enums';

// ─── authenticateApiKey ───────────────────────────────────────────────────────

describe('authenticateApiKey()', () => {
  beforeEach(() => {
    resetMockSheets();
  });

  it('returns SUCCESS for a valid, active api_client key', () => {
    const result = authenticateApiKey(TEST_API_CLIENT_EMAIL);
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data).toBeDefined();
    expect(result.data!.email).toBe(TEST_API_CLIENT_EMAIL);
    expect(result.data!.role).toBe(UserRole.API_CLIENT);
  });

  it('is case-insensitive — upper-case key matches lower-case record', () => {
    const result = authenticateApiKey(TEST_API_CLIENT_EMAIL.toUpperCase());
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.email).toBe(TEST_API_CLIENT_EMAIL);
  });

  it('trims whitespace from the key', () => {
    const result = authenticateApiKey(`  ${TEST_API_CLIENT_EMAIL}  `);
    expect(result.status).toBe(ResultStatus.SUCCESS);
  });

  it('returns ERROR for an empty key', () => {
    const result = authenticateApiKey('');
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toMatch(/Missing api_key/i);
  });

  it('returns ERROR for an unregistered key', () => {
    const result = authenticateApiKey('unknown@nowhere.com');
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toMatch(/Invalid API key/i);
  });

  it('returns ERROR when the key belongs to a regular user (not api_client)', () => {
    const result = authenticateApiKey(TEST_USER_EMAIL);
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toMatch(/API_CLIENT/i);
  });

  it('returns ERROR when the key belongs to an admin user (not api_client)', () => {
    const result = authenticateApiKey(TEST_ADMIN_EMAIL);
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toMatch(/API_CLIENT/i);
  });

  it('returns ERROR when the api_client account is inactive', () => {
    // The default mock has TEST_INACTIVE_EMAIL as role=user; we need an
    // inactive api_client. Override the Users sheet for this test.
    const { mockSheets, createMockSheet, DEFAULT_USERS_ROWS } = require('../mocks/gasGlobals');
    const inactiveApiClient = 'inactive-api@partnerorg.com';
    mockSheets.Users = createMockSheet([
      ...DEFAULT_USERS_ROWS,
      [inactiveApiClient, 'New_Bee', 'api_client', 'inactive', '2025-06-01', 'admin@mmrunners.org'],
    ]);

    const result = authenticateApiKey(inactiveApiClient);
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toMatch(/deactivated/i);
  });

  it('returns the full UserRecord including runningClub', () => {
    const result = authenticateApiKey(TEST_API_CLIENT_EMAIL);
    expect(result.data!.runningClub).toBeDefined();
    expect(result.data!.status).toBe(UserStatus.ACTIVE);
  });
});
