import {
  findByEmail,
  listAll,
  createUser,
  updateUser,
  deactivateUser,
  reactivateUser,
  validateCreateInput,
} from '../../src/services/userService';
import {
  mockSheets,
  resetMockSheets,
  createMockSheet,
  DEFAULT_USERS_ROWS,
  TEST_ADMIN_EMAIL,
  TEST_USER_EMAIL,
  TEST_INACTIVE_EMAIL,
} from '../mocks/gasGlobals';
import { ResultStatus, UserRole, UserStatus } from '../../src/types/enums';

// Grab the SpreadsheetApp mock to override per test
const mockSpreadsheetApp = (global as Record<string, unknown>)['SpreadsheetApp'] as {
  openById: jest.Mock;
};

function useMockSheets() {
  mockSpreadsheetApp.openById.mockReturnValue({
    getSheetByName: jest.fn().mockImplementation((name: string) => mockSheets[name] ?? null),
  });
}

describe('userService', () => {
  beforeEach(() => {
    resetMockSheets();
    useMockSheets();
  });

  // ── findByEmail ───────────────────────────────────────────────────────────

  describe('findByEmail()', () => {
    it('returns the matching UserRecord for a known email', () => {
      const user = findByEmail(TEST_ADMIN_EMAIL);
      expect(user).not.toBeNull();
      expect(user!.email).toBe(TEST_ADMIN_EMAIL);
      expect(user!.role).toBe(UserRole.ADMIN);
    });

    it('is case-insensitive (normalizes to lowercase)', () => {
      const user = findByEmail('ADMIN@MMRUNNERS.ORG');
      expect(user).not.toBeNull();
      expect(user!.email).toBe(TEST_ADMIN_EMAIL);
    });

    it('strips whitespace before lookup', () => {
      const user = findByEmail('  admin@mmrunners.org  ');
      expect(user).not.toBeNull();
    });

    it('returns null for an unregistered email', () => {
      expect(findByEmail('nobody@example.com')).toBeNull();
    });

    it('returns null when the Users sheet is empty', () => {
      const emptySheet = createMockSheet([]);
      emptySheet.getLastRow.mockReturnValue(1);
      mockSpreadsheetApp.openById.mockReturnValue({
        getSheetByName: jest.fn().mockReturnValue(emptySheet),
      });
      expect(findByEmail(TEST_ADMIN_EMAIL)).toBeNull();
    });
  });

  // ── listAll ───────────────────────────────────────────────────────────────

  describe('listAll()', () => {
    it('returns all valid users with correct pagination metadata', () => {
      const result = listAll(1, 10);
      expect(result.total).toBe(DEFAULT_USERS_ROWS.length);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(10);
      expect(result.items.length).toBe(DEFAULT_USERS_ROWS.length);
    });

    it('paginates correctly: page 1 of 2 items each', () => {
      const result = listAll(1, 2);
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(3);
    });

    it('paginates correctly: page 2 of 2 items each', () => {
      const result = listAll(2, 2);
      expect(result.items).toHaveLength(1);
    });

    it('returns empty items array beyond the last page', () => {
      const result = listAll(10, 10);
      expect(result.items).toHaveLength(0);
    });

    it('includes both active and inactive users', () => {
      const result = listAll();
      const statuses = result.items.map((u) => u.status);
      expect(statuses).toContain(UserStatus.ACTIVE);
      expect(statuses).toContain(UserStatus.INACTIVE);
    });
  });

  // ── createUser ────────────────────────────────────────────────────────────

  describe('createUser()', () => {
    it('creates a user and returns SUCCESS with the new record', () => {
      const result = createUser(
        { email: 'new@example.com', runningClub: 'New_Bee', role: UserRole.USER },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toBeDefined();
      expect(result.data!.email).toBe('new@example.com');
      expect(result.data!.status).toBe(UserStatus.ACTIVE);
      expect(result.data!.addedBy).toBe(TEST_ADMIN_EMAIL);
      expect(mockSheets['Users'].appendRow).toHaveBeenCalledTimes(1);
    });

    it('normalizes the email to lowercase', () => {
      const result = createUser(
        { email: 'New@Example.COM', runningClub: 'New_Bee', role: UserRole.USER },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.email).toBe('new@example.com');
    });

    it('returns ERROR and does NOT append if email already exists', () => {
      const result = createUser(
        { email: TEST_USER_EMAIL, runningClub: 'New_Bee', role: UserRole.USER },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('already exists');
      expect(mockSheets['Users'].appendRow).not.toHaveBeenCalled();
    });

    it('returns ERROR with field errors for invalid email format', () => {
      const result = createUser(
        { email: 'not-an-email', runningClub: 'New_Bee', role: UserRole.USER },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some((e) => e.field === 'email')).toBe(true);
    });

    it('returns ERROR when runningClub is empty', () => {
      const result = createUser(
        { email: 'x@x.com', runningClub: '', role: UserRole.USER },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'runningClub')).toBe(true);
    });

    it('returns ERROR for an invalid role', () => {
      const result = createUser(
        { email: 'x@x.com', runningClub: 'New_Bee', role: 'superadmin' as UserRole },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'role')).toBe(true);
    });

    it('accumulates multiple validation errors in a single response', () => {
      const result = createUser(
        { email: '', runningClub: '', role: 'bad' as UserRole },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.length).toBeGreaterThanOrEqual(2);
    });

    it('sets addedDate to today in ISO format', () => {
      const today = new Date().toISOString().split('T')[0];
      const result = createUser(
        { email: 'dated@x.com', runningClub: 'New_Bee', role: UserRole.USER },
        TEST_ADMIN_EMAIL
      );
      expect(result.data!.addedDate).toBe(today);
    });
  });

  // ── updateUser ────────────────────────────────────────────────────────────

  describe('updateUser()', () => {
    beforeEach(() => {
      // Mock findRowIndex to return row 2 (the first user row after header)
      mockSheets['Users'].getRange.mockImplementation(
        (_r: number, _c: number, _nr?: number, _nc?: number) => ({
          getValues: jest.fn().mockReturnValue(DEFAULT_USERS_ROWS),
          setValues: jest.fn(),
        })
      );
    });

    it('updates runningClub and returns the updated record', () => {
      const result = updateUser(
        { email: TEST_USER_EMAIL, runningClub: 'Misty_Mountain' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.runningClub).toBe('Misty_Mountain');
    });

    it('updates role to admin', () => {
      const result = updateUser(
        { email: TEST_USER_EMAIL, role: UserRole.ADMIN },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.role).toBe(UserRole.ADMIN);
    });

    it('returns ERROR for unknown email', () => {
      const result = updateUser(
        { email: 'ghost@example.com', runningClub: 'New_Bee' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('not found');
    });

    it('returns ERROR for invalid role value', () => {
      const result = updateUser(
        { email: TEST_USER_EMAIL, role: 'overlord' as UserRole },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'role')).toBe(true);
    });

    it('returns ERROR for invalid status value', () => {
      const result = updateUser(
        { email: TEST_USER_EMAIL, status: 'suspended' as UserStatus },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'status')).toBe(true);
    });

    it('preserves unchanged fields when only updating one field', () => {
      const result = updateUser(
        { email: TEST_USER_EMAIL, role: UserRole.ADMIN },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      // runningClub unchanged
      expect(result.data!.runningClub).toBe('New_Bee');
    });
  });

  // ── deactivateUser ────────────────────────────────────────────────────────

  describe('deactivateUser()', () => {
    it('deactivates an active user', () => {
      const result = deactivateUser(TEST_USER_EMAIL);
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.status).toBe(UserStatus.INACTIVE);
    });

    it('returns ERROR for unknown email', () => {
      const result = deactivateUser('ghost@example.com');
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('not found');
    });

    it('returns ERROR when user is already inactive', () => {
      const result = deactivateUser(TEST_INACTIVE_EMAIL);
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('already inactive');
    });
  });

  // ── reactivateUser ────────────────────────────────────────────────────────

  describe('reactivateUser()', () => {
    it('reactivates an inactive user', () => {
      const result = reactivateUser(TEST_INACTIVE_EMAIL);
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.status).toBe(UserStatus.ACTIVE);
    });

    it('returns ERROR for unknown email', () => {
      const result = reactivateUser('ghost@example.com');
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('returns ERROR when user is already active', () => {
      const result = reactivateUser(TEST_USER_EMAIL);
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('already active');
    });
  });

  // ── validateCreateInput ───────────────────────────────────────────────────

  describe('validateCreateInput()', () => {
    it('returns empty array for fully valid input', () => {
      const errors = validateCreateInput({
        email: 'valid@example.com',
        runningClub: 'New_Bee',
        role: UserRole.USER,
      });
      expect(errors).toHaveLength(0);
    });

    it('flags invalid email formats', () => {
      const cases = ['', 'no-at-sign', '@missing-local', 'missing@', 'a@b'];
      cases.forEach((email) => {
        const errors = validateCreateInput({ email, runningClub: 'New_Bee', role: UserRole.USER });
        expect(errors.some((e) => e.field === 'email')).toBe(true);
      });
    });

    it('flags missing runningClub', () => {
      const errors = validateCreateInput({ email: 'a@b.com', runningClub: '', role: UserRole.USER });
      expect(errors.some((e) => e.field === 'runningClub')).toBe(true);
    });

    it('flags invalid role', () => {
      const errors = validateCreateInput({
        email: 'a@b.com',
        runningClub: 'New_Bee',
        role: 'god' as UserRole,
      });
      expect(errors.some((e) => e.field === 'role')).toBe(true);
    });

    it('accepts all defined UserRole values', () => {
      Object.values(UserRole).forEach((role) => {
        const errors = validateCreateInput({ email: 'a@b.com', runningClub: 'New_Bee', role });
        expect(errors.some((e) => e.field === 'role')).toBe(false);
      });
    });
  });
});
