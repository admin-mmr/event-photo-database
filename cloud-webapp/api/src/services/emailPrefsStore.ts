/**
 * emailPrefsStore.ts — per-admin email opt-in flags, Google Sheet as SSOT (dev
 * plan G4.1). Reads/writes the `Email_Preferences` tab; column layout mirrors
 * gas-app COLUMNS.EMAIL_PREFERENCES.
 *
 * Default policy (gas-app EMAIL_SERVICE.md): transactional notifications default
 * ON (you hear about account/event changes unless you opt out); the daily/weekly
 * digests default OFF (you only get them if you opt in). So an admin with no row
 * is treated as opted-IN for transactional types and opted-OUT for digests.
 */

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { appendSheetValues, updateSheetValues } from './sheetsService.js';
import { cell, readTab, rowRange, withTabLock } from './sheetTable.js';

const TAB = 'Email_Preferences';
const LAST_COL = 'I';
const COL = {
  EMAIL: 0,
  USER_CREATED: 1,
  USER_ROLE_CHANGED: 2,
  USER_DEACTIVATED: 3,
  SECURITY_EVENT: 4,
  EVENT_CREATED: 5,
  DAILY_REPORT: 6,
  WEEKLY_REPORT: 7,
  UPDATED_AT: 8,
} as const;
const WIDTH = 9; // A..I

export type EmailPrefKey =
  | 'userCreated'
  | 'userRoleChanged'
  | 'userDeactivated'
  | 'securityEvent'
  | 'eventCreated'
  | 'dailyReport'
  | 'weeklyReport';

export interface EmailPrefs {
  email: string;
  userCreated: boolean;
  userRoleChanged: boolean;
  userDeactivated: boolean;
  securityEvent: boolean;
  eventCreated: boolean;
  dailyReport: boolean;
  weeklyReport: boolean;
  updatedAt: string;
}

/** Default flags for an admin with no stored row (transactional ON, digests OFF). */
export function defaultPrefs(email: string): EmailPrefs {
  return {
    email,
    userCreated: true,
    userRoleChanged: true,
    userDeactivated: true,
    securityEvent: true,
    eventCreated: true,
    dailyReport: false,
    weeklyReport: false,
    updatedAt: '',
  };
}

const normEmail = (e: string): string => e.trim().toLowerCase();
// Sheet stores booleans as 'TRUE'/'FALSE' (or '1'/'0'); read leniently.
const parseBool = (s: string, dflt: boolean): boolean => {
  const v = s.trim().toLowerCase();
  if (v === '') return dflt;
  return v === 'true' || v === '1' || v === 'yes';
};
const boolCell = (b: boolean): string => (b ? 'TRUE' : 'FALSE');

function rowToPrefs(cells: string[]): EmailPrefs {
  const d = defaultPrefs(normEmail(cell(cells, COL.EMAIL)));
  return {
    email: d.email,
    userCreated: parseBool(cell(cells, COL.USER_CREATED), d.userCreated),
    userRoleChanged: parseBool(cell(cells, COL.USER_ROLE_CHANGED), d.userRoleChanged),
    userDeactivated: parseBool(cell(cells, COL.USER_DEACTIVATED), d.userDeactivated),
    securityEvent: parseBool(cell(cells, COL.SECURITY_EVENT), d.securityEvent),
    eventCreated: parseBool(cell(cells, COL.EVENT_CREATED), d.eventCreated),
    dailyReport: parseBool(cell(cells, COL.DAILY_REPORT), d.dailyReport),
    weeklyReport: parseBool(cell(cells, COL.WEEKLY_REPORT), d.weeklyReport),
    updatedAt: cell(cells, COL.UPDATED_AT),
  };
}

function prefsToRow(p: EmailPrefs): string[] {
  const row = new Array(WIDTH).fill('');
  row[COL.EMAIL] = p.email;
  row[COL.USER_CREATED] = boolCell(p.userCreated);
  row[COL.USER_ROLE_CHANGED] = boolCell(p.userRoleChanged);
  row[COL.USER_DEACTIVATED] = boolCell(p.userDeactivated);
  row[COL.SECURITY_EVENT] = boolCell(p.securityEvent);
  row[COL.EVENT_CREATED] = boolCell(p.eventCreated);
  row[COL.DAILY_REPORT] = boolCell(p.dailyReport);
  row[COL.WEEKLY_REPORT] = boolCell(p.weeklyReport);
  row[COL.UPDATED_AT] = p.updatedAt;
  return row;
}

/** All stored preference rows, keyed by lowercased email. */
export async function listAllPrefs(spreadsheetId: string): Promise<Map<string, EmailPrefs>> {
  const rows = await readTab(spreadsheetId, TAB, LAST_COL, COL.EMAIL, 'email');
  const out = new Map<string, EmailPrefs>();
  for (const r of rows) out.set(normEmail(cell(r.cells, COL.EMAIL)), rowToPrefs(r.cells));
  return out;
}

/** Prefs for one admin (defaults if no row). */
export async function getPrefs(spreadsheetId: string, email: string): Promise<EmailPrefs> {
  const all = await listAllPrefs(spreadsheetId);
  return all.get(normEmail(email)) ?? defaultPrefs(normEmail(email));
}

/** Upsert one admin's prefs with a partial patch; returns the merged prefs. */
export async function setPrefs(
  spreadsheetId: string,
  email: string,
  patch: Partial<Record<EmailPrefKey, boolean | undefined>>,
): Promise<EmailPrefs> {
  const target = normEmail(email);
  return withTabLock(TAB, async () => {
    const rows = await readTab(spreadsheetId, TAB, LAST_COL, COL.EMAIL, 'email');
    const hit = rows.find((r) => normEmail(cell(r.cells, COL.EMAIL)) === target);
    const base = hit ? rowToPrefs(hit.cells) : defaultPrefs(target);
    const merged: EmailPrefs = { ...base, email: target, updatedAt: new Date().toISOString() };
    for (const k of Object.keys(patch) as EmailPrefKey[]) {
      const v = patch[k];
      if (typeof v === 'boolean') merged[k] = v;
    }
    if (hit) {
      await updateSheetValues(spreadsheetId, rowRange(TAB, 'A', LAST_COL, hit.rowNumber), [prefsToRow(merged)]);
    } else {
      await appendSheetValues(spreadsheetId, `${TAB}!A1`, [prefsToRow(merged)]);
    }
    try {
      await firestore().collection('emailPrefs').doc(target).set(merged, { merge: true });
    } catch (err) {
      logger.warn({ err, email: target }, 'email prefs cache mirror failed (non-fatal)');
    }
    return merged;
  });
}

/**
 * Of `candidateEmails`, those opted-in for `key` (applying defaults for admins
 * with no row). Used to fan out a notification/digest to the right recipients.
 */
export async function optedInAmong(
  spreadsheetId: string,
  key: EmailPrefKey,
  candidateEmails: string[],
): Promise<string[]> {
  const all = await listAllPrefs(spreadsheetId);
  return candidateEmails.filter((e) => (all.get(normEmail(e)) ?? defaultPrefs(normEmail(e)))[key]);
}
