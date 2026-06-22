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

const { listClubs, getClub, createClub, updateClub, setClubStatus, ClubStoreError, NORMALIZED_NAME_RE } =
  await import('../src/services/clubStore.js');

const RANGE = 'Clubs!A1:E';
const HEADER = ['displayname', 'normalizedname', 'status', 'added', 'addedby'];
const SID = 'sheet1';

function clubRow(display: string, norm: string, status = 'active'): string[] {
  return [display, norm, status, '2026-01-01', 'a@x.org'];
}

beforeEach(() => {
  for (const k of Object.keys(sheetData)) delete sheetData[k];
  appendCalls.length = 0;
  updateCalls.length = 0;
});

describe('NORMALIZED_NAME_RE', () => {
  it('accepts alphanumeric underscore-joined names, rejects edge/double underscores', () => {
    expect(NORMALIZED_NAME_RE.test('New_Bee')).toBe(true);
    expect(NORMALIZED_NAME_RE.test('CHI')).toBe(true);
    expect(NORMALIZED_NAME_RE.test('_Bad')).toBe(false);
    expect(NORMALIZED_NAME_RE.test('Bad_')).toBe(false);
    expect(NORMALIZED_NAME_RE.test('a__b')).toBe(false);
    expect(NORMALIZED_NAME_RE.test('has space')).toBe(false);
  });
});

describe('listClubs / getClub', () => {
  it('maps rows, skips header, filters by status', async () => {
    sheetData[RANGE] = [HEADER, clubRow('New Bee', 'New_Bee'), clubRow('Old', 'Old', 'inactive')];
    expect(await listClubs(SID)).toHaveLength(2);
    expect((await listClubs(SID, { status: 'active' })).map((c) => c.normalizedName)).toEqual(['New_Bee']);
    expect((await getClub(SID, 'New_Bee'))?.displayName).toBe('New Bee');
  });
});

describe('createClub', () => {
  it('appends and returns the club', async () => {
    sheetData[RANGE] = [HEADER];
    const c = await createClub(SID, { displayName: 'Chicago', normalizedName: 'CHI' }, 'admin@x.org');
    expect(c.status).toBe('active');
    expect((appendCalls[0]!.rows[0] as string[])[1]).toBe('CHI');
  });

  it('rejects bad normalizedName and duplicates', async () => {
    sheetData[RANGE] = [HEADER, clubRow('Chicago', 'CHI')];
    await expect(createClub(SID, { displayName: 'X', normalizedName: 'bad name' }, 'a@x.org')).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(createClub(SID, { displayName: 'X', normalizedName: 'CHI' }, 'a@x.org')).rejects.toMatchObject({
      code: 'duplicate',
    });
  });
});

describe('updateClub / setClubStatus', () => {
  it('updates displayName in place; normalizedName immutable', async () => {
    sheetData[RANGE] = [HEADER, clubRow('Chicago', 'CHI')];
    await updateClub(SID, 'CHI', { displayName: 'Chicago Runners' });
    expect(updateCalls[0]!.range).toBe('Clubs!A2:E2');
    const row = updateCalls[0]!.rows[0] as string[];
    expect(row[0]).toBe('Chicago Runners');
    expect(row[1]).toBe('CHI');
  });

  it('setClubStatus flips status; not_found throws', async () => {
    sheetData[RANGE] = [HEADER, clubRow('Chicago', 'CHI')];
    await setClubStatus(SID, 'CHI', 'inactive');
    expect((updateCalls[0]!.rows[0] as string[])[2]).toBe('inactive');
    await expect(setClubStatus(SID, 'NOPE', 'inactive')).rejects.toBeInstanceOf(ClubStoreError);
  });
});
