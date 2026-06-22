import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mocks (must precede the service import) ─────────────────────────────────
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

const fsSets: Array<{ id: string; data: Record<string, unknown> }> = [];
vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: () => ({
      doc: (id: string) => ({
        set: async (data: Record<string, unknown>) => {
          fsSets.push({ id, data });
        },
      }),
    }),
  }),
}));

const {
  listUsers,
  getUserByEmail,
  createUser,
  updateUser,
  setUserStatus,
  UserStoreError,
  __clearUserCache,
} = await import('../src/services/userStore.js');

const RANGE = 'Users!A1:K';
const HEADER = ['email', 'first', 'last', 'role', 'club', '', '', 'status', 'added', 'addedby', 'lastlogin'];
const SID = 'sheet1';

function userRow(email: string, role: string, club: string, status = 'active'): string[] {
  const r = new Array(11).fill('');
  r[0] = email;
  r[1] = 'Jane';
  r[2] = 'Doe';
  r[3] = role;
  r[4] = club;
  r[7] = status;
  return r;
}

beforeEach(() => {
  for (const k of Object.keys(sheetData)) delete sheetData[k];
  appendCalls.length = 0;
  updateCalls.length = 0;
  fsSets.length = 0;
  __clearUserCache();
});

describe('listUsers / getUserByEmail', () => {
  it('maps rows, skips header, filters by club + status', async () => {
    sheetData[RANGE] = [
      HEADER,
      userRow('a@x.org', 'super_admin', ''),
      userRow('b@x.org', 'club_admin', 'New_Bee'),
      userRow('c@x.org', 'club_admin', 'New_Bee', 'inactive'),
    ];
    const all = await listUsers(SID);
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({ email: 'a@x.org', role: 'super_admin', clubId: '' });

    const newbeeActive = await listUsers(SID, { clubId: 'New_Bee', status: 'active' });
    expect(newbeeActive.map((u) => u.email)).toEqual(['b@x.org']);
  });

  it('getUserByEmail is case-insensitive', async () => {
    sheetData[RANGE] = [HEADER, userRow('Mixed@X.org', 'club_admin', 'CHI')];
    const u = await getUserByEmail(SID, 'mixed@x.ORG');
    expect(u?.clubId).toBe('CHI');
  });
});

describe('createUser', () => {
  it('appends a row and mirrors to Firestore', async () => {
    sheetData[RANGE] = [HEADER];
    const u = await createUser(
      SID,
      { email: 'New@x.org', firstName: 'New', lastName: 'User', role: 'club_admin', clubId: 'CHI' },
      'admin@x.org',
    );
    expect(u.email).toBe('new@x.org');
    expect(appendCalls).toHaveLength(1);
    const row = appendCalls[0]!.rows[0] as string[];
    expect(row[0]).toBe('new@x.org');
    expect(row[3]).toBe('club_admin');
    expect(row[4]).toBe('CHI');
    expect(row[7]).toBe('active');
    expect(row[9]).toBe('admin@x.org');
    expect(fsSets[0]?.id).toBe('new@x.org');
  });

  it('rejects a duplicate email', async () => {
    sheetData[RANGE] = [HEADER, userRow('dupe@x.org', 'club_admin', 'CHI')];
    await expect(
      createUser(SID, { email: 'dupe@x.org', firstName: 'D', lastName: 'U', role: 'club_admin', clubId: 'CHI' }, 'a@x.org'),
    ).rejects.toMatchObject({ code: 'duplicate' });
    expect(appendCalls).toHaveLength(0);
  });

  it('rejects an invalid email and a club_admin without club', async () => {
    sheetData[RANGE] = [HEADER];
    await expect(
      createUser(SID, { email: 'not-an-email', firstName: 'A', lastName: 'B', role: 'club_admin', clubId: 'CHI' }, 'a@x.org'),
    ).rejects.toBeInstanceOf(UserStoreError);
    await expect(
      createUser(SID, { email: 'ok@x.org', firstName: 'A', lastName: 'B', role: 'club_admin' }, 'a@x.org'),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('clears clubId for a super_admin', async () => {
    sheetData[RANGE] = [HEADER];
    const u = await createUser(
      SID,
      { email: 's@x.org', firstName: 'S', lastName: 'A', role: 'super_admin', clubId: 'CHI' },
      'a@x.org',
    );
    expect(u.clubId).toBe('');
    expect((appendCalls[0]!.rows[0] as string[])[4]).toBe('');
  });
});

describe('updateUser / setUserStatus', () => {
  it('updates the matching row in place (row 2) and keeps super_admin clubless', async () => {
    sheetData[RANGE] = [HEADER, userRow('e@x.org', 'club_admin', 'CHI')];
    await updateUser(SID, 'e@x.org', { firstName: 'Renamed', role: 'super_admin' });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.range).toBe('Users!A2:K2');
    const row = updateCalls[0]!.rows[0] as string[];
    expect(row[1]).toBe('Renamed');
    expect(row[3]).toBe('super_admin');
    expect(row[4]).toBe(''); // clubId cleared for super_admin
  });

  it('setUserStatus flips the status cell', async () => {
    sheetData[RANGE] = [HEADER, userRow('e@x.org', 'club_admin', 'CHI')];
    await setUserStatus(SID, 'e@x.org', 'inactive');
    expect((updateCalls[0]!.rows[0] as string[])[7]).toBe('inactive');
  });

  it('throws not_found for an unknown email', async () => {
    sheetData[RANGE] = [HEADER];
    await expect(setUserStatus(SID, 'ghost@x.org', 'inactive')).rejects.toMatchObject({ code: 'not_found' });
  });
});
