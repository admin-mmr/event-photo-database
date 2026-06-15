import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mocks (must precede the service import) ─────────────────────────────────

const fakeDb = {
  events: new Map<string, Record<string, unknown>>(),
  sets: [] as Array<{ id: string; data: Record<string, unknown>; merge: boolean | undefined }>,
};

vi.mock('../src/lib/firestore.js', () => ({
  firestore: () => ({
    collection: (name: string) => {
      if (name !== 'events') throw new Error(`unexpected collection ${name}`);
      return {
        get: async () => ({
          docs: [...fakeDb.events.entries()].map(([id, data]) => ({ id, data: () => data })),
        }),
        doc: (id: string) => ({
          set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
            fakeDb.sets.push({ id, data, merge: opts?.merge });
            fakeDb.events.set(id, { ...fakeDb.events.get(id), ...data });
          },
        }),
      };
    },
  }),
}));

// Sheet fixtures keyed by the A1 range the service requests.
const sheetData: Record<string, string[][]> = {};
vi.mock('../src/services/sheetsService.js', () => ({
  getSheetValues: async (_spreadsheetId: string, range: string) => sheetData[range] ?? [],
}));

const { reconcile, parseEventRows, parseTagsByEvent, contentEquals, buildContent } = await import(
  '../src/services/reconcileService.js'
);

const EVENTS_RANGE = 'Events!A1:G';
const LINKS_RANGE = 'Upload_Links!A1:K';

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('parseEventRows', () => {
  it('skips the header and blank rows', () => {
    const rows = parseEventRows([
      ['EVENT_ID', 'EVENT_NAME', 'EVENT_DATE', 'FOLDER_NAME', 'DRIVE_FOLDER_ID', 'CREATED_BY', 'CREATED_AT'],
      ['ev1', 'Spring Run', '2026-04-01', '2026-04-01_SpringRun', 'folderA', 'a@x', 't'],
      [], // blank spacer
      ['', 'orphan name with no id'],
    ]);
    expect(rows).toEqual([
      { eventId: 'ev1', name: 'Spring Run', date: '2026-04-01', folderName: '2026-04-01_SpringRun', driveFolderId: 'folderA' },
    ]);
  });

  it('handles a sheet with no header row', () => {
    const rows = parseEventRows([['ev9', 'No Header Event', '2026-01-01', 'f', 'fid', 'a', 't']]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventId).toBe('ev9');
  });
});

describe('parseTagsByEvent', () => {
  it('returns distinct, sorted, non-empty tags per event', () => {
    const map = parseTagsByEvent([
      ['LINK_ID', 'EVENT_ID', 'CLUB_NAME', 'TOKEN', 'VERSION', 'GEN_BY', 'GEN_AT', 'REVOKED_AT', 'REVOKED_BY', 'REASON', 'TAG'],
      ['l1', 'ev1', 'New_Bee', 't', '1', 'a', 'ts', '', '', '', 'finish_line'],
      ['l2', 'ev1', 'New_Bee', 't', '1', 'a', 'ts', '', '', '', 'mile_10'],
      ['l3', 'ev1', 'CHI', 't', '1', 'a', 'ts', 'revoked', 'a', 'r', 'finish_line'], // dup + revoked still counts
      ['l4', 'ev1', 'CHI', 't', '1', 'a', 'ts', '', '', '', ''], // empty tag skipped
      ['l5', 'ev2', 'New_Bee', 't', '1', 'a', 'ts', '', '', '', 'ALL'],
    ]);
    expect(map.get('ev1')).toEqual(['finish_line', 'mile_10']);
    expect(map.get('ev2')).toEqual(['ALL']);
  });
});

describe('contentEquals', () => {
  const next = buildContent(
    { eventId: 'e', name: 'N', date: 'd', folderName: 'f', driveFolderId: 'fid' },
    ['a', 'b'],
  );
  it('treats missing fields as empty and order-insensitive tags as equal', () => {
    expect(contentEquals({ name: 'N', date: 'd', folderName: 'f', driveFolderId: 'fid', tags: ['b', 'a'] }, next)).toBe(true);
  });
  it('detects a changed field', () => {
    expect(contentEquals({ name: 'OTHER', date: 'd', folderName: 'f', driveFolderId: 'fid', tags: ['a', 'b'] }, next)).toBe(false);
  });
  it('detects a changed tag set', () => {
    expect(contentEquals({ name: 'N', date: 'd', folderName: 'f', driveFolderId: 'fid', tags: ['a'] }, next)).toBe(false);
  });
  it('returns false when the doc does not exist', () => {
    expect(contentEquals(undefined, next)).toBe(false);
  });
});

// ── reconcile orchestrator ───────────────────────────────────────────────────

describe('reconcile', () => {
  beforeEach(() => {
    fakeDb.events.clear();
    fakeDb.sets.length = 0;
    for (const k of Object.keys(sheetData)) delete sheetData[k];

    sheetData[EVENTS_RANGE] = [
      ['EVENT_ID', 'EVENT_NAME', 'EVENT_DATE', 'FOLDER_NAME', 'DRIVE_FOLDER_ID', 'CREATED_BY', 'CREATED_AT'],
      ['ev1', 'Spring Run 2026', '2026-04-01', '2026-04-01_SpringRun', 'folderA', 'a@x', 't1'],
      ['ev2', 'Summer 5K', '2026-07-04', '2026-07-04_Summer5K', 'folderB', 'a@x', 't2'],
    ];
    sheetData[LINKS_RANGE] = [
      ['LINK_ID', 'EVENT_ID', 'CLUB_NAME', 'TOKEN', 'VERSION', 'GEN_BY', 'GEN_AT', 'REVOKED_AT', 'REVOKED_BY', 'REASON', 'TAG'],
      ['l1', 'ev1', 'New_Bee', 't', '1', 'a', 'ts', '', '', '', 'finish_line'],
    ];
  });

  it('creates new events with tags and preserves cloud-owned fields via merge', async () => {
    // ev1 already exists with an indexState the indexer wrote.
    fakeDb.events.set('ev1', { name: 'old name', indexState: { status: 'done', photoCount: 9 }, visibility: 'link' });

    const r = await reconcile('sheet-123');

    expect(r.scanned).toBe(2);
    expect(r.created).toBe(1); // ev2
    expect(r.updated).toBe(1); // ev1 name changed
    expect(r.unchanged).toBe(0);
    expect(r.tagsLinked).toBe(1);
    expect(r.orphans).toEqual([]);

    // every write is a merge (never clobbers indexState/visibility)
    expect(fakeDb.sets.every((s) => s.merge === true)).toBe(true);
    const ev1 = fakeDb.events.get('ev1')!;
    expect(ev1.name).toBe('Spring Run 2026');
    expect(ev1.tags).toEqual(['finish_line']);
    expect(ev1.indexState).toEqual({ status: 'done', photoCount: 9 }); // survived
    expect(ev1.visibility).toBe('link'); // survived
    expect(ev1.source).toBe('sheet-sync');
  });

  it('is a no-op on the second run (idempotent, no writes when unchanged)', async () => {
    await reconcile('sheet-123');
    fakeDb.sets.length = 0;
    const r2 = await reconcile('sheet-123');
    expect(r2.created).toBe(0);
    expect(r2.updated).toBe(0);
    expect(r2.unchanged).toBe(2);
    expect(fakeDb.sets).toHaveLength(0);
  });

  it('reports events missing from the Sheet as orphans without deleting them', async () => {
    fakeDb.events.set('ev_gone', { name: 'Deleted from sheet', indexState: { status: 'done' } });
    const r = await reconcile('sheet-123');
    expect(r.orphans).toEqual(['ev_gone']);
    // not deleted — still present in the store
    expect(fakeDb.events.has('ev_gone')).toBe(true);
    // and never written to
    expect(fakeDb.sets.find((s) => s.id === 'ev_gone')).toBeUndefined();
  });
});
