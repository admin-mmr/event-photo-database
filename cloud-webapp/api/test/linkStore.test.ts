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

const { listLinks, findActiveLink, findByToken, generateLink, revokeLink, rotateLink, LinkStoreError, DEFAULT_TAG } =
  await import('../src/services/linkStore.js');

const RANGE = 'Upload_Links!A1:K';
const HEADER = ['linkid', 'eventid', 'clubname', 'token', 'version', 'genby', 'genat', 'revokedat', 'revokedby', 'reason', 'tag'];
const SID = 'sheet1';

function linkRow(o: Partial<Record<string, string>>): string[] {
  const r = new Array(11).fill('');
  r[0] = o.linkId ?? 'l1';
  r[1] = o.eventId ?? 'ev1';
  r[2] = o.clubName ?? 'CHI';
  r[3] = o.token ?? 'tok1';
  r[4] = o.version ?? '1';
  r[7] = o.revokedAt ?? '';
  r[10] = o.tag ?? 'ALL';
  return r;
}

beforeEach(() => {
  for (const k of Object.keys(sheetData)) delete sheetData[k];
  appendCalls.length = 0;
  updateCalls.length = 0;
});

describe('listLinks / findActiveLink / findByToken', () => {
  it('maps rows, derives status, filters', async () => {
    sheetData[RANGE] = [
      HEADER,
      linkRow({ linkId: 'a', token: 'ta' }),
      linkRow({ linkId: 'b', token: 'tb', revokedAt: '2026-01-01' }),
      linkRow({ linkId: 'c', token: 'tc', eventId: 'ev2' }),
    ];
    const all = await listLinks(SID);
    expect(all).toHaveLength(3);
    expect(all.find((l) => l.linkId === 'a')?.status).toBe('active');
    expect(all.find((l) => l.linkId === 'b')?.status).toBe('inactive');

    expect((await listLinks(SID, { eventId: 'ev2' })).map((l) => l.linkId)).toEqual(['c']);
    expect((await listLinks(SID, { status: 'active' })).map((l) => l.linkId)).toEqual(['a', 'c']);

    expect((await findActiveLink(SID, 'ev1', 'CHI', 'ALL'))?.linkId).toBe('a');
    expect((await findByToken(SID, 'tb'))).toBeNull(); // revoked token not returned
    expect((await findByToken(SID, 'ta'))?.linkId).toBe('a');
  });
});

describe('generateLink', () => {
  it('appends a new active link (v1) with default tag', async () => {
    sheetData[RANGE] = [HEADER];
    const link = await generateLink(SID, { eventId: 'ev1', clubName: 'CHI' }, 'admin@x.org');
    expect(link.version).toBe(1);
    expect(link.tag).toBe(DEFAULT_TAG);
    expect(link.status).toBe('active');
    expect(link.token.length).toBeGreaterThan(20);
    expect(appendCalls).toHaveLength(1);
  });

  it('is idempotent: returns the existing active link for the same triple', async () => {
    sheetData[RANGE] = [HEADER, linkRow({ linkId: 'exists', tag: 'finish' })];
    const link = await generateLink(SID, { eventId: 'ev1', clubName: 'CHI', tag: 'finish' }, 'a@x.org');
    expect(link.linkId).toBe('exists');
    expect(appendCalls).toHaveLength(0);
  });

  it('rejects an invalid tag', async () => {
    sheetData[RANGE] = [HEADER];
    await expect(generateLink(SID, { eventId: 'ev1', clubName: 'CHI', tag: 'bad tag!' }, 'a@x.org')).rejects.toMatchObject({
      code: 'invalid',
    });
  });
});

describe('revokeLink / rotateLink', () => {
  it('revoke stamps revokedAt + flips status', async () => {
    sheetData[RANGE] = [HEADER, linkRow({ linkId: 'l1' })];
    const link = await revokeLink(SID, 'l1', 'leaked', 'admin@x.org');
    expect(link.status).toBe('inactive');
    expect(updateCalls[0]!.range).toBe('Upload_Links!A2:K2');
    expect((updateCalls[0]!.rows[0] as string[])[7]).not.toBe(''); // revokedAt set
    expect((updateCalls[0]!.rows[0] as string[])[9]).toBe('leaked');
  });

  it('revoke errors on unknown + already revoked', async () => {
    sheetData[RANGE] = [HEADER, linkRow({ linkId: 'l1', revokedAt: '2026-01-01' })];
    await expect(revokeLink(SID, 'nope', '', 'a@x.org')).rejects.toMatchObject({ code: 'not_found' });
    await expect(revokeLink(SID, 'l1', '', 'a@x.org')).rejects.toMatchObject({ code: 'already_revoked' });
  });

  it('rotate revokes the old link and appends a new one at v+1', async () => {
    sheetData[RANGE] = [HEADER, linkRow({ linkId: 'l1', version: '2', tag: 'finish' })];
    const fresh = await rotateLink(SID, 'l1', 'admin@x.org');
    expect(updateCalls).toHaveLength(1); // old revoked
    expect(appendCalls).toHaveLength(1); // new appended
    expect(fresh.version).toBe(3);
    expect(fresh.tag).toBe('finish');
    expect(fresh.linkId).not.toBe('l1');
    expect(fresh.status).toBe('active');
  });
});

describe('LinkStoreError', () => {
  it('is thrown for bad input', async () => {
    sheetData[RANGE] = [HEADER];
    await expect(generateLink(SID, { eventId: '', clubName: 'CHI' }, 'a@x.org')).rejects.toBeInstanceOf(LinkStoreError);
  });
});
