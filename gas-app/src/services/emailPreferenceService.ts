import { ResultStatus, UserStatus, EmailType } from '../types/enums';
import { EmailPreferenceRecord, UserRecord } from '../types/models';
import { ServiceResult } from '../types/responses';
import { getConfig, EMAIL_PREFERENCES_HEADERS } from '../config/constants';
import { getAllRows, appendRow, findRowIndex, updateRow, ensureHeaders } from './sheetService';
import { toEmailPreferenceRecord, fromEmailPreferenceRecord } from '../utils/sheetMapper';
import { listAll as listAllUsers } from './userService';
import { nowIsoTimestamp } from '../utils/dateFormatter';
import { isAdmin } from '../middleware/roleGuard';

/**
 * EmailPreferenceService — manages per-admin opt-in settings for
 * notification emails.
 *
 * Backed by the "Email_Preferences" sheet, keyed by admin email.
 * Missing rows are treated as "use defaults" — callers should never rely on
 * every admin having a row; instead they call getPreferencesFor(email), which
 * synthesises a default record on demand.
 *
 * Default policy (applied when no row exists):
 *   • Transactional user-management alerts → OPTED IN
 *     (USER_CREATED, USER_ROLE_CHANGED, USER_DEACTIVATED, SECURITY_EVENT)
 *   • Recurring digests → OPTED OUT  (DAILY_REPORT, WEEKLY_REPORT)
 *
 * The admin must visit the Email Preferences page to opt IN to digests;
 * once they do, an explicit row is written to the sheet.
 */

// ─── Defaults ─────────────────────────────────────────────────────────────────

/**
 * Returns the default preference set for an admin with no saved row.
 * Transactional alerts are on by default; recurring digests are off so
 * admins don't receive mail they never asked for.
 */
function defaultPreferences(email: string): EmailPreferenceRecord {
  return {
    email: email.trim().toLowerCase(),
    userCreated:     true,
    userRoleChanged: true,
    userDeactivated: true,
    securityEvent:   true,
    eventCreated:    true,   // default ON — event creation is a key coordination signal
    dailyReport:     false,
    weeklyReport:    false,
    updatedAt:       '',  // empty = never set explicitly
  };
}

// ─── Loaders ──────────────────────────────────────────────────────────────────

/**
 * Returns every EmailPreferenceRecord in the sheet.
 * Malformed rows are silently skipped.
 */
function loadAllPreferences(): EmailPreferenceRecord[] {
  const config = getConfig();
  try {
    const rows = getAllRows(config.SHEET_NAMES.EMAIL_PREFERENCES);
    return rows
      .map(toEmailPreferenceRecord)
      .filter((r): r is EmailPreferenceRecord => r !== null);
  } catch {
    // Sheet may not exist yet on fresh deploys — surface as "no rows".
    return [];
  }
}

/**
 * Loads every ADMIN user from the Users sheet.
 * Used as the candidate pool when resolving recipients for admin notifications.
 */
function loadActiveAdmins(): UserRecord[] {
  const all = listAllUsers(1, 500).items;
  return all.filter(
    (u) => isAdmin(u.role) && u.status === UserStatus.ACTIVE,
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensures the Email_Preferences sheet has the canonical header row.
 * Call once during initial setup (or from a one-off GAS editor function).
 * Safe to run repeatedly — only writes headers when the sheet is empty.
 */
export function ensureSheetHeaders(): ServiceResult<undefined> {
  try {
    const config = getConfig();
    ensureHeaders(config.SHEET_NAMES.EMAIL_PREFERENCES, [...EMAIL_PREFERENCES_HEADERS]);
    return { status: ResultStatus.SUCCESS, message: 'Email_Preferences headers verified' };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to verify Email_Preferences headers: ${String(err)}`,
    };
  }
}

/**
 * Returns the preferences for a single admin, falling back to defaults when
 * no row is present.
 *
 * Case-insensitive match on email.
 */
export function getPreferencesFor(email: string): EmailPreferenceRecord {
  const normalized = email.trim().toLowerCase();
  const existing = loadAllPreferences().find((p) => p.email === normalized);
  return existing ?? defaultPreferences(normalized);
}

/**
 * Upserts a preference row for one admin.
 *
 * If the row doesn't exist, appends it. Otherwise overwrites every column.
 * `updatedAt` is stamped automatically.
 */
export function savePreferences(
  input: Omit<EmailPreferenceRecord, 'updatedAt'>,
): ServiceResult<EmailPreferenceRecord> {
  const record: EmailPreferenceRecord = {
    ...input,
    email: input.email.trim().toLowerCase(),
    updatedAt: nowIsoTimestamp(),
  };

  if (!record.email) {
    return { status: ResultStatus.ERROR, message: 'email is required' };
  }

  try {
    const config = getConfig();
    ensureSheetHeaders(); // lazy auto-create headers on first use

    const rowIndex = findRowIndex(
      config.SHEET_NAMES.EMAIL_PREFERENCES,
      0, // EMAIL column
      record.email,
    );

    if (rowIndex < 0) {
      appendRow(config.SHEET_NAMES.EMAIL_PREFERENCES, fromEmailPreferenceRecord(record));
    } else {
      updateRow(config.SHEET_NAMES.EMAIL_PREFERENCES, rowIndex, fromEmailPreferenceRecord(record));
    }

    return {
      status: ResultStatus.SUCCESS,
      message: 'Email preferences saved',
      data: record,
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to save email preferences: ${String(err)}`,
    };
  }
}

/**
 * Returns the list of admin emails that should receive a given EmailType.
 *
 * Pipeline:
 *   1. Start with every active ADMIN user.
 *   2. Resolve their preferences (with defaults applied).
 *   3. Drop anyone who has opted out of this EmailType.
 *
 * For WELCOME_USER, returns an empty list — that event targets the new
 * user directly, not admins. Callers handle the "to" list separately.
 */
export function listRecipientsForType(type: EmailType): string[] {
  if (type === EmailType.WELCOME_USER) {
    // Welcome mail is addressed to the new user, not admins.
    return [];
  }

  const admins = loadActiveAdmins();
  return admins
    .filter((admin) => {
      const prefs = getPreferencesFor(admin.email);
      return isOptedIn(prefs, type);
    })
    .map((admin) => admin.email);
}

/**
 * Returns the list of all admin emails regardless of preferences — used for
 * the initial "add a user" CC line when the admin hasn't yet chosen their
 * preferences. For every subsequent call use listRecipientsForType().
 */
export function listAllAdminEmails(): string[] {
  return loadActiveAdmins().map((u) => u.email);
}

/**
 * Returns true if the preference record opts the admin in to the given type.
 */
export function isOptedIn(prefs: EmailPreferenceRecord, type: EmailType): boolean {
  switch (type) {
    case EmailType.USER_CREATED:      return prefs.userCreated;
    case EmailType.USER_ROLE_CHANGED: return prefs.userRoleChanged;
    case EmailType.USER_DEACTIVATED:  return prefs.userDeactivated;
    case EmailType.SECURITY_EVENT:    return prefs.securityEvent;
    case EmailType.EVENT_CREATED:     return prefs.eventCreated;
    case EmailType.DAILY_REPORT:      return prefs.dailyReport;
    case EmailType.WEEKLY_REPORT:     return prefs.weeklyReport;
    case EmailType.UPLOAD_ERROR:      return prefs.securityEvent; // reuse security-event opt-in; no schema change needed
    case EmailType.WELCOME_USER:      return false; // never routed through opt-in
    default:                          return false;
  }
}
