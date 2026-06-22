import { describe, it, expect, vi, beforeEach } from 'vitest';

const sheetData: Record<string, string[][]> = {};
vi.mock('../src/services/sheetsService.js', () => ({
  getSheetValues: async (_id: string, range: string) => sheetData[range] ?? [],
}));

const { summarize } = await import('../src/services/summaryService.js');

const RANGE = 'Upload_Log!A1:N';
const HEADER = ['log_id', 'event_id', 'club_name', 'uploaded_by', 'batch', 'batch_id', 'file_count', 'size_mb', 'sk1', 'sk2', 'upload_ts', 'source', 'link_id', 'duration'];
const SID = 'sheet1';

function logRow(club: string, files: string, size: string, ts: string, id = 'l'): string[] {
  const r = new Array(14).fill('');
  r[0] = id;
  r[2] = club;
  r[6] = files;
  r[7] = size;
  r[10] = ts;
  return r;
}

beforeEach(() => {
  for (const k of Object.keys(sheetData)) delete sheetData[k];
});

describe('summarize', () => {
  it('aggregates totals and per-club, sorted by files desc', async () => {
    sheetData[RANGE] = [
      HEADER,
      logRow('CHI', '10', '5.5', '2026-06-10T00:00:00Z', 'a'),
      logRow('CHI', '20', '4.5', '2026-06-11T00:00:00Z', 'b'),
      logRow('NYC', '5', '1', '2026-06-12T00:00:00Z', 'c'),
    ];
    const s = await summarize(SID);
    expect(s.totals).toEqual({ sessions: 3, files: 35, sizeMb: 11 });
    expect(s.byClub.map((c) => c.clubName)).toEqual(['CHI', 'NYC']);
    expect(s.byClub[0]).toMatchObject({ clubName: 'CHI', sessions: 2, files: 30, sizeMb: 10 });
  });

  it('applies date + club filters', async () => {
    sheetData[RANGE] = [
      HEADER,
      logRow('CHI', '10', '1', '2026-06-01T00:00:00Z', 'a'),
      logRow('CHI', '20', '2', '2026-06-15T00:00:00Z', 'b'),
      logRow('NYC', '7', '3', '2026-06-15T00:00:00Z', 'c'),
    ];
    const ranged = await summarize(SID, { since: '2026-06-10', until: '2026-06-20' });
    expect(ranged.totals.sessions).toBe(2);
    expect(ranged.totals.files).toBe(27);

    const chi = await summarize(SID, { clubName: 'CHI' });
    expect(chi.totals.files).toBe(30);
    expect(chi.byClub).toHaveLength(1);
  });
});
