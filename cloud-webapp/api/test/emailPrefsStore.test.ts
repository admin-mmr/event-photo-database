import { describe, it, expect, vi, beforeEach } from 'vitest';

const sheetData: Record<string, string[][]> = {};
const appendCalls: Array<{ range: string; rows: unknown[][] }> = [];
const updateCalls: Array<{ range: string; rows: unknown[][] }> = [];

vi.mock('../src/services/sheetsService.js', () => ({
  getSheetValues: async (_id: string, range: string) => sheetData[range] ?? [],
  appendSheetValues: async (_id: string, range: string, rows: unknown[][]) => {
    appendCalls.push({ range, rows });
    return rows.length;
  },
  updateSheetValues: async (_id: string, range: string, rows: unknown[][]) => {
    updateCalls.push({ range, rows });
    return 1;
  },
}));
vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({ collection: () => ({ doc: () => ({ set: async () => undefined }) }) }),
}));

const { defaultPrefs, getPrefs, setPrefs, optedInAmong } = await import('../src/services/emailPrefsStore.js');

const RANGE = 'Email_Preferences!A1:I';
const HEADER = ['email', 'user_created', 'user_role_changed', 'user_deactivated', 'security_event', 'event_created', 'daily_report', 'weekly_report', 'updated_at'];
const SID = 'sheet1';

beforeEach(() => {
  for (const k of Object.keys(sheetData)) delete sheetData[k];
  appendCalls.length = 0;
  updateCalls.length = 0;
});

describe('defaultPrefs', () => {
  it('transactional ON, digests OFF', () => {
    const p = defaultPrefs('a@x.org');
    expect(p.userCreated).toBe(true);
    expect(p.eventCreated).toBe(true);
    expect(p.dailyReport).toBe(false);
    expect(p.weeklyReport).toBe(false);
  });
});

describe('getPrefs', () => {
  it('returns defaults when no row exists', async () => {
    sheetData[RANGE] = [HEADER];
    const p = await getPrefs(SID, 'New@X.org');
    expect(p.email).toBe('new@x.org');
    expect(p.userCreated).toBe(true);
    expect(p.dailyReport).toBe(false);
  });

  it('reads stored flags', async () => {
    sheetData[RANGE] = [HEADER, ['b@x.org', 'FALSE', '', '', '', '', 'TRUE', '', 't']];
    const p = await getPrefs(SID, 'b@x.org');
    expect(p.userCreated).toBe(false); // explicit
    expect(p.dailyReport).toBe(true); // explicit
    expect(p.eventCreated).toBe(true); // blank → default ON
  });
});

describe('setPrefs', () => {
  it('appends a new row when none exists', async () => {
    sheetData[RANGE] = [HEADER];
    const p = await setPrefs(SID, 'c@x.org', { dailyReport: true });
    expect(p.dailyReport).toBe(true);
    expect(p.userCreated).toBe(true); // untouched default
    expect(appendCalls).toHaveLength(1);
    expect(updateCalls).toHaveLength(0);
  });

  it('updates an existing row in place', async () => {
    sheetData[RANGE] = [HEADER, ['d@x.org', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'FALSE', 'FALSE', 't']];
    await setPrefs(SID, 'd@x.org', { userCreated: false });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.range).toBe('Email_Preferences!A2:I2');
    expect((updateCalls[0]!.rows[0] as string[])[1]).toBe('FALSE');
  });
});

describe('optedInAmong', () => {
  it('applies defaults for rowless admins', async () => {
    sheetData[RANGE] = [HEADER, ['b@x.org', 'FALSE', '', '', '', '', 'TRUE', '', 't']];
    expect(await optedInAmong(SID, 'userCreated', ['a@x.org', 'b@x.org'])).toEqual(['a@x.org']);
    expect(await optedInAmong(SID, 'dailyReport', ['a@x.org', 'b@x.org'])).toEqual(['b@x.org']);
  });
});
