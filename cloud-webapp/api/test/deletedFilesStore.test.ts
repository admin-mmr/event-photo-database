import { describe, it, expect, vi, beforeEach } from 'vitest';

const sheetData: Record<string, string[][]> = {};
const appendCalls: Array<{ rows: unknown[][] }> = [];
const updateCalls: Array<{ range: string; rows: unknown[][] }> = [];

vi.mock('../src/services/sheetsService.js', () => ({
  getSheetValues: async (_id: string, range: string) => sheetData[range] ?? [],
  appendSheetValues: async (_id: string, _range: string, rows: unknown[][]) => {
    appendCalls.push({ rows });
    return rows.length;
  },
  updateSheetValues: async (_id: string, range: string, rows: unknown[][]) => {
    updateCalls.push({ range, rows });
    return 1;
  },
}));

const { recordSoftDelete, listDeleted, markRestored, markPurged, findExpired, DeletedFilesError } = await import(
  '../src/services/deletedFilesStore.js'
);

const RANGE = 'Deleted_Files!A1:N';
const HEADER = ['delete_id', 'drive_file_id', 'file_name', 'event_id', 'club_name', 'batch', 'uploaded_by', 'deleted_at', 'deleted_by', 'reason', 'restored_at', 'restored_by', 'purged_at', 'status'];
const SID = 'sheet1';

function row(o: Partial<Record<string, string>>): string[] {
  const r = new Array(14).fill('');
  r[0] = o.deleteId ?? 'd1';
  r[1] = o.driveFileId ?? 'f1';
  r[4] = o.clubName ?? 'CHI';
  r[7] = o.deletedAt ?? '2026-06-20T00:00:00Z';
  r[13] = o.status ?? 'deleted';
  return r;
}

beforeEach(() => {
  for (const k of Object.keys(sheetData)) delete sheetData[k];
  appendCalls.length = 0;
  updateCalls.length = 0;
});

describe('recordSoftDelete / listDeleted', () => {
  it('appends a deleted row and lists with filters', async () => {
    sheetData[RANGE] = [HEADER];
    const rec = await recordSoftDelete(SID, { driveFileId: 'fX', clubName: 'CHI', reason: 'dup' }, 'admin@x.org');
    expect(rec.status).toBe('deleted');
    expect(appendCalls).toHaveLength(1);

    sheetData[RANGE] = [HEADER, row({ deleteId: 'a', clubName: 'CHI' }), row({ deleteId: 'b', clubName: 'NYC', status: 'restored' })];
    expect((await listDeleted(SID, { clubName: 'CHI' })).map((r) => r.deleteId)).toEqual(['a']);
    expect((await listDeleted(SID, { status: 'restored' })).map((r) => r.deleteId)).toEqual(['b']);
  });

  it('rejects a missing driveFileId', async () => {
    sheetData[RANGE] = [HEADER];
    await expect(recordSoftDelete(SID, { driveFileId: '', clubName: 'CHI' }, 'a@x.org')).rejects.toBeInstanceOf(
      DeletedFilesError,
    );
  });
});

describe('markRestored / markPurged', () => {
  it('restores a deleted record', async () => {
    sheetData[RANGE] = [HEADER, row({ deleteId: 'd1', status: 'deleted' })];
    const rec = await markRestored(SID, 'd1', 'admin@x.org');
    expect(rec.status).toBe('restored');
    expect(updateCalls[0]!.range).toBe('Deleted_Files!A2:N2');
  });

  it('refuses to restore a non-deleted record + 404 unknown', async () => {
    sheetData[RANGE] = [HEADER, row({ deleteId: 'd1', status: 'restored' })];
    await expect(markRestored(SID, 'd1', 'a@x.org')).rejects.toMatchObject({ code: 'bad_state' });
    await expect(markRestored(SID, 'nope', 'a@x.org')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('marks purged', async () => {
    sheetData[RANGE] = [HEADER, row({ deleteId: 'd1' })];
    const rec = await markPurged(SID, 'd1');
    expect(rec.status).toBe('purged');
  });
});

describe('findExpired', () => {
  it('returns deleted rows older than the retention window', async () => {
    const old = '2020-01-01T00:00:00Z';
    const recent = new Date().toISOString();
    sheetData[RANGE] = [
      HEADER,
      row({ deleteId: 'old', deletedAt: old, status: 'deleted' }),
      row({ deleteId: 'new', deletedAt: recent, status: 'deleted' }),
      row({ deleteId: 'restored', deletedAt: old, status: 'restored' }),
    ];
    const expired = await findExpired(SID, 30);
    expect(expired.map((r) => r.deleteId)).toEqual(['old']);
  });
});
