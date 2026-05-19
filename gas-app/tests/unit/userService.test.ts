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
      expect(user!.role).toBe(UserRole.SUPER_ADMIN);
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
      expect(result.total).toBe(DEFAULT_USERS_ROWS.length);
    });

    it('paginates correctly: page 2 of 2 items each', () => {
      const result = listAll(2, 2);
      expect(result.items).toHaveLength(1); // 3 rows total → page 2 has 1
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
    it('creates a club_admin and returns SUCCESS with the new record', () => {
      const result = createUser(
        { email: 'new@example.com', firstName: 'New', lastName: 'User', role: UserRole.CLUB_ADMIN, clubId: 'Freshpix' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toBeDefined();
      expect(result.data!.email).toBe('new@example.com');
      expect(result.data!.status).toBe(UserStatus.ACTIVE);
      expect(result.data!.addedBy).toBe(TEST_ADMIN_EMAIL);
      expect(mockSheets['Users'].appendRow).toHaveBeenCalledTimes(1);
    });

    it('creates a super_admin (no clubId required)', () => {
      const result = createUser(
        { email: 'super@example.com', firstName: 'Super', lastName: 'Admin', role: UserRole.SUPER_ADMIN },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.role).toBe(UserRole.SUPER_ADMIN);
      expect(result.data!.clubId).toBe('');
    });

    it('normalizes the email to lowercase', () => {
      const result = createUser(
        { email: 'New@Example.COM', firstName: 'New', lastName: 'User', role: UserRole.CLUB_ADMIN, clubId: 'Freshpix' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.email).toBe('new@example.com');
    });

    it('returns ERROR and does NOT append if email already exists', () => {
      const result = createUser(
        { email: TEST_USER_EMAIL, firstName: 'Dup', lastName: 'User', role: UserRole.CLUB_ADMIN, clubId: 'New_Bee' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('already exists');
      expect(mockSheets['Users'].appendRow).not.toHaveBeenCalled();
    });

    it('returns ERROR with field errors for invalid email format', () => {
      const result = createUser(
        { email: 'not-an-email', firstName: 'Test', lastName: 'User', role: UserRole.CLUB_ADMIN, clubId: 'New_Bee' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some((e) => e.field === 'email')).toBe(true);
    });

    it('returns ERROR when firstName is empty', () => {
      const result = createUser(
        { email: 'x@x.com', firstName: '', lastName: 'User', role: UserRole.CLUB_ADMIN, clubId: 'New_Bee' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'firstName')).toBe(true);
    });

    it('returns ERROR when club_admin has no clubId', () => {
      const result = createUser(
        { email: 'x@x.com', firstName: 'X', lastName: 'Y', role: UserRole.CLUB_ADMIN },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'clubId')).toBe(true);
    });

    it('returns ERROR when super_admin has a clubId', () => {
      const result = createUser(
        { email: 'x@x.com', firstName: 'X', lastName: 'Y', role: UserRole.SUPER_ADMIN, clubId: 'SomeClub' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'clubId')).toBe(true);
    });

    it('returns ERROR for an invalid role', () => {
      const result = createUser(
        { email: 'x@x.com', firstName: 'X', lastName: 'Y', role: 'superadmin' as UserRole },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.some((e) => e.field === 'role')).toBe(true);
    });

    it('accumulates multiple validation errors in a single response', () => {
      const result = createUser(
        { email: '', firstName: '', lastName: '', role: 'bad' as UserRole },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.errors!.length).toBeGreaterThanOrEqual(3);
    });

    it('sets addedDate to today in ISO format', () => {
      const { toIsoDate } = require('../../src/utils/dateFormatter') as
        { toIsoDate: (d: Date) => string };
      const today = toIsoDate(new Date());
      const result = createUser(
        { email: 'dated@x.com', firstName: 'Dated', lastName: 'User', role: UserRole.CLUB_ADMIN, clubId: 'Freshpix' },
        TEST_ADMIN_EMAIL
      );
      expect(result.data!.addedDate).toBe(today);
    });

    it('allows multiple active club_admins for the same club', () => {
      // TEST_USER_EMAIL is already club_admin for New_Bee. Adding another
      // club_admin to the same club must now succeed — cross-club authorization
      // is enforced at the route-handler layer, not in the service.
      const result = createUser(
        { email: 'another@x.com', firstName: 'Another', lastName: 'Admin', role: UserRole.CLUB_ADMIN, clubId: 'New_Bee' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.email).toBe('another@x.com');
      expect(result.data!.clubId).toBe('New_Bee');
      expect(result.data!.role).toBe(UserRole.CLUB_ADMIN);
    });
  });

  // ── updateUser ────────────────────────────────────────────────────────────

  describe('updateUser()', () => {
    beforeEach(() => {
      mockSheets['Users'].getRange.mockImplementation(
        (_r: number, _c: number, _nr?: number, _nc?: number) => ({
          getValues: jest.fn().mockReturnValue(DEFAULT_USERS_ROWS),
          setValues: jest.fn(),
        })
      );
    });

    it('updates firstName and returns the updated record', () => {
      const result = updateUser(
        { email: TEST_USER_EMAIL, firstName: 'Updated' },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.firstName).toBe('Updated');
    });

    it('updates role to super_admin and clears clubId', () => {
      const result = updateUser(
        { email: TEST_USER_EMAIL, role: UserRole.SUPER_ADMIN },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.role).toBe(UserRole.SUPER_ADMIN);
      expect(result.data!.clubId).toBe('');
    });

    it('returns ERROR for unknown email', () => {
      const result = updateUser(
        { email: 'ghost@example.com', firstName: 'Ghost' },
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
        { email: TEST_USER_EMAIL, role: UserRole.SUPER_ADMIN },
        TEST_ADMIN_EMAIL
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      // lastName unchanged
      expect(result.data!.lastName).toBe('User');
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
    it('returns empty array for valid club_admin input', () => {
      const errors = validateCreateInput({
        email:     'valid@example.com',
        firstName: 'Valid',
        lastName:  'User',
        role:      UserRole.CLUB_ADMIN,
        clubId:    'New_Bee',
      });
      expect(errors).toHaveLength(0);
    });

    it('returns empty array for valid super_admin input (no clubId)', () => {
      const errors = validateCreateInput({
        email:     'super@example.com',
        firstName: 'Super',
        lastName:  'Admin',
        role:      UserRole.SUPER_ADMIN,
      });
      expect(errors).toHaveLength(0);
    });

    it('flags invalid email formats', () => {
      const cases = ['', 'no-at-sign', '@missing-local', 'missing@', 'a@b'];
      cases.forEach((email) => {
        const errors = validateCreateInput({ email, firstName: 'F', lastName: 'L', role: UserRole.CLUB_ADMIN, clubId: 'X' });
        expect(errors.some((e) => e.field === 'email')).toBe(true);
      });
    });

    it('flags missing firstName', () => {
      const errors = validateCreateInput({ email: 'a@b.com', firstName: '', lastName: 'L', role: UserRole.CLUB_ADMIN, clubId: 'X' });
      expect(errors.some((e) => e.field === 'firstName')).toBe(true);
    });

    it('flags missing lastName', () => {
      const errors = validateCreateInput({ email: 'a@b.com', firstName: 'F', lastName: '', role: UserRole.CLUB_ADMIN, clubId: 'X' });
      expect(errors.some((e) => e.field === 'lastName')).toBe(true);
    });

    it('flags club_admin missing clubId', () => {
      const errors = validateCreateInput({ email: 'a@b.com', firstName: 'F', lastName: 'L', role: UserRole.CLUB_ADMIN });
      expect(errors.some((e) => e.field === 'clubId')).toBe(true);
    });

    it('flags super_admin with non-empty clubId', () => {
      const errors = validateCreateInput({ email: 'a@b.com', firstName: 'F', lastName: 'L', role: UserRole.SUPER_ADMIN, clubId: 'SomeClub' });
      expect(errors.some((e) => e.field === 'clubId')).toBe(true);
    });

    it('flags invalid role', () => {
      const errors = validateCreateInput({
        email: 'a@b.com', firstName: 'F', lastName: 'L',
        role: 'god' as UserRole,
      });
      expect(errors.some((e) => e.field === 'role')).toBe(true);
    });

    it('accepts all defined UserRole values with appropriate clubId', () => {
      // super_admin — no clubId
      expect(validateCreateInput({ email: 'a@b.com', firstName: 'F', lastName: 'L', role: UserRole.SUPER_ADMIN })
        .some((e) => e.field === 'role')).toBe(false);
      // club_admin — requires clubId
      expect(validateCreateInput({ email: 'a@b.com', firstName: 'F', lastName: 'L', role: UserRole.CLUB_ADMIN, clubId: 'X' })
        .some((e) => e.field === 'role')).toBe(false);
    });
  });
});
