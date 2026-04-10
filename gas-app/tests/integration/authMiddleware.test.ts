/**
 * Integration tests for the AuthMiddleware pipeline.
 *
 * These tests exercise the full chain:
 *   getCurrentUser() → Session mock
 *   resolveUser()    → SheetService mock → SheetMapper
 *   authenticateRequest() → both steps combined
 *
 * They use the GAS global mocks installed by gasGlobals.ts and override
 * the active user via setMockUser() to simulate different auth scenarios.
 */

import {
  getCurrentUser,
  resolveUser,
  authenticateRequest,
} from '../../src/middleware/authMiddleware';
import {
  setMockUser,
  resetMockSheets,
  createMockSheet,
  DEFAULT_USERS_ROWS,
  TEST_ADMIN_EMAIL,
  TEST_USER_EMAIL,
  TEST_INACTIVE_EMAIL,
} from '../mocks/gasGlobals';
import { ResultStatus, UserRole, UserStatus } from '../../src/types/enums';

const mockSpreadsheetApp = (global as Record<string, unknown>)['SpreadsheetApp'] as {
  openById: jest.Mock;
};

// Helper: configure SpreadsheetApp to serve the given rows for the Users sheet
function setupUsersSheet(rows: unknown[][]): void {
  const sheet = createMockSheet(rows);
  mockSpreadsheetApp.openById.mockReturnValue({
    getSheetByName: jest.fn().mockImplementation((name: string) =>
      name === 'Users' ? sheet : null
    ),
  });
}

describe('AuthMiddleware — getCurrentUser()', () => {
  beforeEach(() => {
    resetMockSheets();
    setMockUser(TEST_ADMIN_EMAIL);
  });

  it('returns SUCCESS with email when session is active', () => {
    const result = getCurrentUser();
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data?.email).toBe(TEST_ADMIN_EMAIL);
  });

  it('normalizes email to lowercase', () => {
    setMockUser('Admin@MMRUNNERS.ORG');
    const result = getCurrentUser();
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data?.email).toBe('admin@mmrunners.org');
  });

  it('returns ERROR when session email is empty', () => {
    setMockUser('');
    const result = getCurrentUser();
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('Not authenticated');
  });

  it('returns ERROR when Session.getActiveUser throws', () => {
    const mockSession = (global as Record<string, unknown>)['Session'] as {
      getActiveUser: jest.Mock;
    };
    mockSession.getActiveUser.mockImplementationOnce(() => {
      throw new Error('Session not available');
    });
    const result = getCurrentUser();
    expect(result.status).toBe(ResultStatus.ERROR);
  });
});

describe('AuthMiddleware — resolveUser()', () => {
  beforeEach(() => {
    resetMockSheets();
    setupUsersSheet(DEFAULT_USERS_ROWS);
  });

  it('returns SUCCESS with full UserRecord for registered active user', () => {
    const result = resolveUser(TEST_ADMIN_EMAIL);
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data?.email).toBe(TEST_ADMIN_EMAIL);
    expect(result.data?.role).toBe(UserRole.ADMIN);
    expect(result.data?.status).toBe(UserStatus.ACTIVE);
  });

  it('returns SUCCESS for a registered active regular user', () => {
    const result = resolveUser(TEST_USER_EMAIL);
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data?.role).toBe(UserRole.USER);
  });

  it('returns ERROR for an unregistered email', () => {
    const result = resolveUser('nobody@example.com');
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('not registered');
  });

  it('returns ERROR for an inactive user', () => {
    const result = resolveUser(TEST_INACTIVE_EMAIL);
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('deactivated');
  });

  it('returns ERROR when the Users sheet read fails', () => {
    mockSpreadsheetApp.openById.mockReturnValue({
      getSheetByName: jest.fn().mockReturnValue(null), // sheet not found → throws
    });
    const result = resolveUser(TEST_ADMIN_EMAIL);
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('Failed to read Users sheet');
  });

  it('is case-sensitive for email lookup (emails are stored lowercase)', () => {
    // The mock data has 'admin@mmrunners.org' (lowercase)
    // Looking up with uppercase should fail (use normalized form in practice)
    const result = resolveUser('Admin@mmrunners.org');
    expect(result.status).toBe(ResultStatus.ERROR);
  });

  it('handles an empty Users sheet gracefully', () => {
    setupUsersSheet([]);
    const result = resolveUser(TEST_ADMIN_EMAIL);
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('not registered');
  });
});

describe('AuthMiddleware — authenticateRequest()', () => {
  beforeEach(() => {
    resetMockSheets();
    setupUsersSheet(DEFAULT_USERS_ROWS);
    setMockUser(TEST_ADMIN_EMAIL);
  });

  it('returns SUCCESS with UserRecord for authenticated, registered, active user', () => {
    const result = authenticateRequest();
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data?.email).toBe(TEST_ADMIN_EMAIL);
    expect(result.data?.role).toBe(UserRole.ADMIN);
  });

  it('returns ERROR when session has no email (step 1 fails)', () => {
    setMockUser('');
    const result = authenticateRequest();
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('Not authenticated');
  });

  it('returns ERROR when user is not in the Users sheet (step 2 fails)', () => {
    setMockUser('stranger@gmail.com');
    const result = authenticateRequest();
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('not registered');
  });

  it('returns ERROR when user is inactive (step 2 fails)', () => {
    setMockUser(TEST_INACTIVE_EMAIL);
    const result = authenticateRequest();
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('deactivated');
  });

  it('propagates step 1 errors without reaching step 2', () => {
    setMockUser('');
    // Even if the sheet read would fail, we should get the auth error first
    mockSpreadsheetApp.openById.mockReturnValue({
      getSheetByName: jest.fn().mockReturnValue(null),
    });
    const result = authenticateRequest();
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('Not authenticated');
  });
});
