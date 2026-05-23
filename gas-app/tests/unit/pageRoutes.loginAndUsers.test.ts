/**
 * Tests for loginPage() and adminUsersPage() covering the changes made to:
 *   - loginPage: always exposes buildTime / buildCommit (no SHOW_LOGIN_BUILD_STAMP gate)
 *   - adminUsersPage: passes userRole, userClubId, isSuperAdmin to template so
 *     the Add User form can be scoped to the caller's club when role = club_admin
 *
 * These tests also serve as regression guards for the login block reported after
 * the role-scoped nav rollout: if either page handler throws, login is broken.
 */
import {
  loginPage,
  adminUsersPage,
} from '../../src/routes/pageRoutes';
import { UserRecord } from '../../src/types/models';
import { UserRole, UserStatus } from '../../src/types/enums';
import {
  resetMockSheets,
  TEST_ADMIN_EMAIL,
  TEST_CLUB_ADMIN_EMAIL,
  mockHtmlService,
  mockHtmlTemplate,
} from '../mocks/gasGlobals';

// ── Service mocks ─────────────────────────────────────────────────────────────

jest.mock('../../src/services/publicSpreadsheetService', () => ({
  getPublicSpreadsheetUrl: jest.fn().mockReturnValue(''),
}));

jest.mock('../../src/services/userService', () => ({
  listAll: jest.fn().mockReturnValue({ items: [], total: 0 }),
}));

jest.mock('../../src/services/clubService', () => ({
  listActive: jest.fn().mockReturnValue([]),
  listAll: jest.fn().mockReturnValue({ items: [], total: 0 }),
}));

jest.mock('../../src/utils/scriptUrl', () => ({
  getCanonicalScriptUrl: jest.fn().mockReturnValue('https://script.google.com/test'),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const superAdmin: UserRecord = {
  email:       TEST_ADMIN_EMAIL,
  firstName:   'Super',
  lastName:    'Admin',
  clubId:      '',
  role:        UserRole.SUPER_ADMIN,
  status:      UserStatus.ACTIVE,
  addedDate:   '2025-01-01',
  addedBy:     'system',
  lastLoginAt: '',
};

const clubAdmin: UserRecord = {
  email:       TEST_CLUB_ADMIN_EMAIL,
  firstName:   'Club',
  lastName:    'Admin',
  clubId:      'New_Bee',
  role:        UserRole.CLUB_ADMIN,
  status:      UserStatus.ACTIVE,
  addedDate:   '2025-02-01',
  addedBy:     TEST_ADMIN_EMAIL,
  lastLoginAt: '',
};

// ── loginPage() ───────────────────────────────────────────────────────────────

describe('pageRoutes — loginPage()', () => {
  beforeEach(() => {
    resetMockSheets();
    mockHtmlService.createTemplateFromFile.mockClear();
    mockHtmlTemplate.evaluate.mockClear();
  });

  it('renders without throwing', () => {
    expect(() => loginPage()).not.toThrow();
  });

  it('renders with an error message without throwing', () => {
    expect(() => loginPage('Invalid credentials')).not.toThrow();
  });

  it('uses the login template', () => {
    loginPage();
    expect(mockHtmlService.createTemplateFromFile).toHaveBeenCalledWith(
      'ui/templates/login'
    );
  });

  it('always injects buildTime into template scope (no SHOW_LOGIN_BUILD_STAMP gate)', () => {
    loginPage();
    const tpl = mockHtmlService.createTemplateFromFile.mock.results[0].value;
    // buildTime must be a non-empty string so the build stamp renders
    expect(typeof tpl.buildTime).toBe('string');
    expect(tpl.buildTime.length).toBeGreaterThan(0);
  });

  it('always injects buildCommit into template scope', () => {
    loginPage();
    const tpl = mockHtmlService.createTemplateFromFile.mock.results[0].value;
    expect(typeof tpl.buildCommit).toBe('string');
    expect(tpl.buildCommit.length).toBeGreaterThan(0);
  });

  it('injects errorMessage into template scope', () => {
    loginPage('Bad token');
    const tpl = mockHtmlService.createTemplateFromFile.mock.results[0].value;
    expect(tpl.errorMessage).toBe('Bad token');
  });

  it('injects empty errorMessage when called with no argument', () => {
    loginPage();
    const tpl = mockHtmlService.createTemplateFromFile.mock.results[0].value;
    expect(tpl.errorMessage).toBe('');
  });

  it('calls evaluate() on the template', () => {
    loginPage();
    expect(mockHtmlTemplate.evaluate).toHaveBeenCalledTimes(1);
  });

  it('returns an HtmlOutput object', () => {
    expect(loginPage()).toBeDefined();
  });
});

// ── adminUsersPage() ──────────────────────────────────────────────────────────

describe('pageRoutes — adminUsersPage()', () => {
  beforeEach(() => {
    resetMockSheets();
    mockHtmlService.createTemplateFromFile.mockClear();
    mockHtmlTemplate.evaluate.mockClear();
  });

  it('renders without throwing for super_admin', () => {
    expect(() => adminUsersPage(superAdmin, 'token')).not.toThrow();
  });

  it('renders without throwing for club_admin', () => {
    expect(() => adminUsersPage(clubAdmin, 'token')).not.toThrow();
  });

  it('uses the admin/users template', () => {
    adminUsersPage(superAdmin, 'token');
    expect(mockHtmlService.createTemplateFromFile).toHaveBeenCalledWith(
      'ui/templates/admin/users'
    );
  });

  // ── isSuperAdmin ───────────────────────────────────────────────────────────

  it('sets isSuperAdmin=true for super_admin', () => {
    adminUsersPage(superAdmin, 'token');
    const tpl = mockHtmlService.createTemplateFromFile.mock.results[0].value;
    expect(tpl.isSuperAdmin).toBe(true);
  });

  it('sets isSuperAdmin=false for club_admin', () => {
    adminUsersPage(clubAdmin, 'token');
    const tpl = mockHtmlService.createTemplateFromFile.mock.results[0].value;
    expect(tpl.isSuperAdmin).toBe(false);
  });

  // ── userRole ───────────────────────────────────────────────────────────────

  it('passes userRole=super_admin for super_admin', () => {
    adminUsersPage(superAdmin, 'token');
    const tpl = mockHtmlService.createTemplateFromFile.mock.results[0].value;
    expect(tpl.userRole).toBe(UserRole.SUPER_ADMIN);
  });

  it('passes userRole=club_admin for club_admin', () => {
    adminUsersPage(clubAdmin, 'token');
    const tpl = mockHtmlService.createTemplateFromFile.mock.results[0].value;
    expect(tpl.userRole).toBe(UserRole.CLUB_ADMIN);
  });

  // ── userClubId ─────────────────────────────────────────────────────────────
  // The template uses this to lock the Add User form to the caller's own club.
  // A wrong or missing clubId would silently allow cross-club user creation.

  it('passes correct clubId for club_admin (New_Bee)', () => {
    adminUsersPage(clubAdmin, 'token');
    const tpl = mockHtmlService.createTemplateFromFile.mock.results[0].value;
    expect(tpl.userClubId).toBe('New_Bee');
  });

  it('passes empty string clubId for super_admin (no fixed club)', () => {
    adminUsersPage(superAdmin, 'token');
    const tpl = mockHtmlService.createTemplateFromFile.mock.results[0].value;
    expect(tpl.userClubId).toBe('');
  });

  it('passes empty string clubId when user.clubId is falsy (defensive)', () => {
    // In practice a super_admin may have an empty or missing clubId; the ?? ''
    // guard in adminUsersPage must coerce it to '' so the template value=""
    // attribute doesn't render as "undefined".
    const adminNoClub: UserRecord = { ...superAdmin, clubId: '' };
    adminUsersPage(adminNoClub, 'token');
    const tpl = mockHtmlService.createTemplateFromFile.mock.results[0].value;
    expect(tpl.userClubId).toBe('');
  });

  // ── other required template vars ───────────────────────────────────────────

  it('passes userEmail to template scope', () => {
    adminUsersPage(clubAdmin, 'token');
    const tpl = mockHtmlService.createTemplateFromFile.mock.results[0].value;
    expect(tpl.userEmail).toBe(TEST_CLUB_ADMIN_EMAIL);
  });

  it('passes sessionToken to template scope', () => {
    adminUsersPage(superAdmin, 'my-session-token');
    const tpl = mockHtmlService.createTemplateFromFile.mock.results[0].value;
    expect(tpl.sessionToken).toBe('my-session-token');
  });

  it('passes users array to template scope', () => {
    adminUsersPage(superAdmin, 'token');
    const tpl = mockHtmlService.createTemplateFromFile.mock.results[0].value;
    expect(Array.isArray(tpl.users)).toBe(true);
  });
});
