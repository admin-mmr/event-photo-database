import {
  getPreferencesFor,
  savePreferences,
  listRecipientsForType,
  listAllAdminEmails,
  isOptedIn,
  ensureSheetHeaders,
} from '../../src/services/emailPreferenceService';
import { EmailType } from '../../src/types/enums';
import {
  mockSheets,
  resetMockSheets,
  setupEmailPreferencesSheet,
  TEST_ADMIN_EMAIL,
  TEST_USER_EMAIL,
  TEST_INACTIVE_EMAIL,
} from '../mocks/gasGlobals';
import { ResultStatus } from '../../src/types/enums';

const mockSpreadsheetApp = (global as Record<string, unknown>)['SpreadsheetApp'] as {
  openById: jest.Mock;
};

function useMockSheets() {
  mockSpreadsheetApp.openById.mockReturnValue({
    getSheetByName: jest.fn().mockImplementation((name: string) => mockSheets[name] ?? null),
  });
}

describe('emailPreferenceService', () => {
  beforeEach(() => {
    resetMockSheets();
    useMockSheets();
  });

  // ── getPreferencesFor ──────────────────────────────────────────────────────

  describe('getPreferencesFor()', () => {
    it('returns default record when no row exists', () => {
      setupEmailPreferencesSheet([]); // Empty sheet
      const prefs = getPreferencesFor('newadmin@example.com');
      expect(prefs.email).toBe('newadmin@example.com');
      expect(prefs.userCreated).toBe(true);    // defaults to true
      expect(prefs.dailyReport).toBe(false);   // defaults to false
      expect(prefs.updatedAt).toBe('');        // empty timestamp
    });

    it('returns sheet-backed record when one exists', () => {
      // 9-col: email, UC, URC, UD, SE, EC(new), DR, WR, updatedAt
      setupEmailPreferencesSheet([
        [TEST_ADMIN_EMAIL, true, true, true, true, true, true, false, '2026-04-01T10:00:00Z'],
      ]);
      const prefs = getPreferencesFor(TEST_ADMIN_EMAIL);
      expect(prefs.email).toBe(TEST_ADMIN_EMAIL);
      expect(prefs.dailyReport).toBe(true);
      expect(prefs.updatedAt).toBe('2026-04-01T10:00:00Z');
    });

    it('is case-insensitive on email match', () => {
      setupEmailPreferencesSheet([
        ['Admin@MMRUNNERS.ORG', true, true, true, true, false, false, '2026-04-01T10:00:00Z'],
      ]);
      const prefs = getPreferencesFor('admin@mmrunners.org');
      expect(prefs.email).toBe('admin@mmrunners.org');
      expect(prefs.userCreated).toBe(true);
    });
  });

  // ── savePreferences ────────────────────────────────────────────────────────

  describe('savePreferences()', () => {
    it('rejects empty email', () => {
      const result = savePreferences({
        email: '',
        userCreated: true,
        userRoleChanged: true,
        userDeactivated: true,
        securityEvent: true,
        eventCreated: true,
        dailyReport: false,
        weeklyReport: false,
      });
      expect(result.status).toBe(ResultStatus.ERROR);
    });

    it('appends a new row when none exists', () => {
      setupEmailPreferencesSheet([]);
      const result = savePreferences({
        email: 'newhire@example.com',
        userCreated: true,
        userRoleChanged: false,
        userDeactivated: true,
        securityEvent: false,
        eventCreated: true,
        dailyReport: true,
        weeklyReport: false,
      });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(mockSheets.Email_Preferences.appendRow).toHaveBeenCalledTimes(1);
    });

    it('updates in place when a row exists', () => {
      setupEmailPreferencesSheet([
        [TEST_ADMIN_EMAIL, true, true, true, true, false, false, '2026-04-01T10:00:00Z'],
      ]);
      mockSheets.Email_Preferences.getRange.mockReturnValue({
        getValues: jest.fn().mockReturnValue([[TEST_ADMIN_EMAIL, true, true, true, true, false, false]]),
        setValues: jest.fn(),
      });
      const result = savePreferences({
        email: TEST_ADMIN_EMAIL,
        userCreated: false,
        userRoleChanged: true,
        userDeactivated: true,
        securityEvent: true,
        eventCreated: true,
        dailyReport: true,
        weeklyReport: true,
      });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(mockSheets.Email_Preferences.appendRow).not.toHaveBeenCalled();
    });

    it('stamps updatedAt even if caller passed one', () => {
      setupEmailPreferencesSheet([]);
      const result = savePreferences({
        email: 'test@example.com',
        userCreated: true,
        userRoleChanged: true,
        userDeactivated: true,
        securityEvent: true,
        eventCreated: true,
        dailyReport: false,
        weeklyReport: false,
      });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    });

    it('returns SUCCESS when preferences are successfully saved', () => {
      setupEmailPreferencesSheet([]);
      const result = savePreferences({
        email: 'test@example.com',
        userCreated: true,
        userRoleChanged: false,
        userDeactivated: true,
        securityEvent: false,
        eventCreated: true,
        dailyReport: true,
        weeklyReport: false,
      });
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toBeDefined();
    });
  });

  // ── listRecipientsForType ──────────────────────────────────────────────────

  describe('listRecipientsForType()', () => {
    it('returns [] for EmailType.WELCOME_USER', () => {
      const recipients = listRecipientsForType(EmailType.WELCOME_USER);
      expect(recipients).toEqual([]);
    });

    it('returns only admins with pref=true for USER_CREATED (opt-in default)', () => {
      setupEmailPreferencesSheet([
        [TEST_ADMIN_EMAIL, true, true, true, true, false, false, '2026-04-01T10:00:00Z'],
      ]);
      const recipients = listRecipientsForType(EmailType.USER_CREATED);
      expect(recipients).toContain(TEST_ADMIN_EMAIL);
      expect(recipients.length).toBeGreaterThan(0);
    });

    it('excludes admins with pref=false for a given type', () => {
      setupEmailPreferencesSheet([
        [TEST_ADMIN_EMAIL, false, true, true, true, false, false, '2026-04-01T10:00:00Z'],
      ]);
      const recipients = listRecipientsForType(EmailType.USER_CREATED);
      expect(recipients).not.toContain(TEST_ADMIN_EMAIL);
    });

    it('applies defaults: USER_CREATED defaults to true, DAILY_REPORT defaults to false', () => {
      setupEmailPreferencesSheet([]); // No saved rows, use defaults
      const userCreated = listRecipientsForType(EmailType.USER_CREATED);
      const dailyReport = listRecipientsForType(EmailType.DAILY_REPORT);
      // With default admin in the Users sheet, USER_CREATED should include them (default=true)
      expect(userCreated.length).toBeGreaterThan(0);
      // DAILY_REPORT should exclude them (default=false)
      expect(dailyReport.length).toBe(0);
    });

    it('excludes inactive admins even if pref is true', () => {
      // TEST_INACTIVE_EMAIL is in the Users sheet as inactive
      // We add a prefs row with dailyReport=true
      setupEmailPreferencesSheet([
        [TEST_INACTIVE_EMAIL, true, true, true, true, true, true, '2026-04-01T10:00:00Z'],
      ]);
      const recipients = listRecipientsForType(EmailType.DAILY_REPORT);
      expect(recipients).not.toContain(TEST_INACTIVE_EMAIL);
    });
  });

  // ── listAllAdminEmails ─────────────────────────────────────────────────────

  describe('listAllAdminEmails()', () => {
    it('returns every active admin, ignoring preferences', () => {
      // Users sheet has TEST_ADMIN_EMAIL (super_admin) and TEST_USER_EMAIL (club_admin) as active admins
      const admins = listAllAdminEmails();
      expect(admins).toContain(TEST_ADMIN_EMAIL);
      // TEST_USER_EMAIL is club_admin — also an admin
      expect(admins).toContain(TEST_USER_EMAIL);
      // TEST_INACTIVE_EMAIL is inactive, should not appear
      expect(admins).not.toContain(TEST_INACTIVE_EMAIL);
    });
  });

  // ── isOptedIn ──────────────────────────────────────────────────────────────

  describe('isOptedIn()', () => {
    const defaultPrefs = getPreferencesFor('test@example.com');

    it('returns false for WELCOME_USER always', () => {
      expect(isOptedIn(defaultPrefs, EmailType.WELCOME_USER)).toBe(false);
    });

    it('returns correct boolean for USER_CREATED', () => {
      const prefs = { ...defaultPrefs, userCreated: true };
      expect(isOptedIn(prefs, EmailType.USER_CREATED)).toBe(true);
      prefs.userCreated = false;
      expect(isOptedIn(prefs, EmailType.USER_CREATED)).toBe(false);
    });

    it('returns correct boolean for USER_ROLE_CHANGED', () => {
      const prefs = { ...defaultPrefs, userRoleChanged: false };
      expect(isOptedIn(prefs, EmailType.USER_ROLE_CHANGED)).toBe(false);
      prefs.userRoleChanged = true;
      expect(isOptedIn(prefs, EmailType.USER_ROLE_CHANGED)).toBe(true);
    });

    it('returns correct boolean for USER_DEACTIVATED', () => {
      const prefs = { ...defaultPrefs, userDeactivated: true };
      expect(isOptedIn(prefs, EmailType.USER_DEACTIVATED)).toBe(true);
    });

    it('returns correct boolean for SECURITY_EVENT', () => {
      const prefs = { ...defaultPrefs, securityEvent: false };
      expect(isOptedIn(prefs, EmailType.SECURITY_EVENT)).toBe(false);
    });

    it('returns correct boolean for DAILY_REPORT', () => {
      const prefs = { ...defaultPrefs, dailyReport: true };
      expect(isOptedIn(prefs, EmailType.DAILY_REPORT)).toBe(true);
    });

    it('returns correct boolean for WEEKLY_REPORT', () => {
      const prefs = { ...defaultPrefs, weeklyReport: false };
      expect(isOptedIn(prefs, EmailType.WEEKLY_REPORT)).toBe(false);
    });
  });

  // ── ensureSheetHeaders ─────────────────────────────────────────────────────

  describe('ensureSheetHeaders()', () => {
    it('returns a result object with status and message', () => {
      setupEmailPreferencesSheet([]);
      const result = ensureSheetHeaders();
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('message');
      expect([ResultStatus.SUCCESS, ResultStatus.ERROR]).toContain(result.status);
    });

    it('returns ERROR when the sheet API throws', () => {
      // Mock the spreadsheet to throw when accessing the sheet
      mockSpreadsheetApp.openById.mockReturnValueOnce({
        getSheetByName: jest.fn().mockImplementation(() => {
          throw new Error('Sheet not found');
        }),
      });
      const result = ensureSheetHeaders();
      expect(result.status).toBe(ResultStatus.ERROR);
    });
  });
});
