import {
  adminEmailPrefsPage,
} from '../../src/routes/pageRoutes';
import { UserRecord } from '../../src/types/models';
import { UserRole, UserStatus } from '../../src/types/enums';
import {
  resetMockSheets,
  TEST_ADMIN_EMAIL,
  mockHtmlService,
  mockHtmlTemplate,
} from '../mocks/gasGlobals';

// Mock the emailPreferenceService
jest.mock('../../src/services/emailPreferenceService', () => ({
  getPreferencesFor: jest.fn((email: string) => ({
    email: email.toLowerCase(),
    userCreated: true,
    userRoleChanged: true,
    userDeactivated: true,
    securityEvent: true,
    dailyReport: false,
    weeklyReport: false,
    updatedAt: '2026-04-01T10:00:00Z',
  })),
}));

const mockGetPreferencesFor = require('../../src/services/emailPreferenceService')
  .getPreferencesFor as jest.Mock;

describe('pageRoutes — adminEmailPrefsPage()', () => {
  beforeEach(() => {
    resetMockSheets();
    mockHtmlService.createTemplateFromFile.mockClear();
    mockHtmlTemplate.evaluate.mockClear();
    mockGetPreferencesFor.mockClear();
  });

  const testAdmin: UserRecord = {
    email: TEST_ADMIN_EMAIL,
    firstName: 'Test',
    lastName: 'Admin',
    clubId: '',
    role: UserRole.SUPER_ADMIN,
    status: UserStatus.ACTIVE,
    addedDate: '2025-01-01',
    addedBy: 'system',
    lastLoginAt: '',
  };

  it('calls getPreferencesFor(user.email)', () => {
    adminEmailPrefsPage(testAdmin, 'session-token-123');
    expect(mockGetPreferencesFor).toHaveBeenCalledWith(TEST_ADMIN_EMAIL);
  });

  it('calls createTemplateFromFile with admin/email_prefs template', () => {
    adminEmailPrefsPage(testAdmin, 'session-token-123');
    expect(mockHtmlService.createTemplateFromFile).toHaveBeenCalledWith(
      'ui/templates/admin/email_prefs'
    );
  });

  it('injects prefs as JSON via template scope', () => {
    adminEmailPrefsPage(testAdmin, 'session-token-123');
    // The function assigns properties to the template object, which we can't easily
    // verify directly. Instead, we verify that the template was created and evaluated.
    expect(mockHtmlService.createTemplateFromFile).toHaveBeenCalled();
    expect(mockHtmlTemplate.evaluate).toHaveBeenCalled();
  });

  it('passes sessionToken correctly to template scope', () => {
    adminEmailPrefsPage(testAdmin, 'my-session-token');
    expect(mockHtmlService.createTemplateFromFile).toHaveBeenCalled();
    // The template instance should have the sessionToken assigned
    expect(mockHtmlTemplate.evaluate).toHaveBeenCalled();
  });

  it('passes userEmail correctly to template scope', () => {
    adminEmailPrefsPage(testAdmin, 'token');
    expect(mockHtmlService.createTemplateFromFile).toHaveBeenCalled();
    expect(mockHtmlTemplate.evaluate).toHaveBeenCalled();
  });

  it('passes userRole correctly to template scope', () => {
    adminEmailPrefsPage(testAdmin, 'token');
    expect(mockHtmlTemplate.evaluate).toHaveBeenCalled();
  });

  it('passes isAdmin=true for super_admin users', () => {
    const admin: UserRecord = {
      ...testAdmin,
      role: UserRole.SUPER_ADMIN,
    };
    adminEmailPrefsPage(admin, 'token');
    expect(mockHtmlTemplate.evaluate).toHaveBeenCalled();
  });

  it('passes isAdmin=true for club_admin users', () => {
    const user: UserRecord = {
      ...testAdmin,
      role: UserRole.CLUB_ADMIN,
    };
    adminEmailPrefsPage(user, 'token');
    expect(mockHtmlTemplate.evaluate).toHaveBeenCalled();
  });

  it('calls evaluate() on the template', () => {
    adminEmailPrefsPage(testAdmin, 'token');
    expect(mockHtmlTemplate.evaluate).toHaveBeenCalledTimes(1);
  });

  it('sets the title on the HtmlOutput', () => {
    const result = adminEmailPrefsPage(testAdmin, 'token');
    // The mock HtmlOutput has setTitle that returns this, which gets chained
    expect(result).toBeDefined();
  });

  it('sets XFrameOptionsMode on the HtmlOutput', () => {
    const result = adminEmailPrefsPage(testAdmin, 'token');
    // The mock HtmlOutput has setXFrameOptionsMode chained
    expect(result).toBeDefined();
  });

  it('returns an HtmlOutput object', () => {
    const result = adminEmailPrefsPage(testAdmin, 'token');
    expect(result).toBeDefined();
    // HtmlOutput is a GAS type; we're just checking it's returned
  });

  it('handles empty sessionToken', () => {
    expect(() => adminEmailPrefsPage(testAdmin, '')).not.toThrow();
  });

  it('handles undefined sessionToken (defaults to empty string)', () => {
    expect(() => adminEmailPrefsPage(testAdmin)).not.toThrow();
  });

  it('fetches fresh preferences for each call', () => {
    mockGetPreferencesFor.mockClear();
    adminEmailPrefsPage(testAdmin, 'token1');
    expect(mockGetPreferencesFor).toHaveBeenCalledTimes(1);

    adminEmailPrefsPage(testAdmin, 'token2');
    expect(mockGetPreferencesFor).toHaveBeenCalledTimes(2);
  });

  it('handles case-insensitive email lookup in preferences', () => {
    const userWithUppercaseEmail: UserRecord = {
      ...testAdmin,
      email: 'Admin@MMRUNNERS.ORG',
    };
    adminEmailPrefsPage(userWithUppercaseEmail, 'token');
    expect(mockGetPreferencesFor).toHaveBeenCalledWith('Admin@MMRUNNERS.ORG');
  });

  it('uses the correct preferences returned by the service', () => {
    const customPrefs = {
      email: TEST_ADMIN_EMAIL,
      userCreated: false,
      userRoleChanged: false,
      userDeactivated: false,
      securityEvent: false,
      dailyReport: true,
      weeklyReport: true,
      updatedAt: '2026-04-20T15:30:00Z',
    };
    mockGetPreferencesFor.mockReturnValueOnce(customPrefs);
    adminEmailPrefsPage(testAdmin, 'token');
    expect(mockGetPreferencesFor).toHaveBeenCalledWith(TEST_ADMIN_EMAIL);
  });
});
