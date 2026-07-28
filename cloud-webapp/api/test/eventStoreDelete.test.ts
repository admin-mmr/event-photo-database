/**
 * eventStore.deleteEventRow — the clear-then-rewrite of the Events tab.
 *
 * The trap this pins down: the rewrite has to be anchored below the header, and a
 * header-less tab must anchor at row 1 instead. Get that wrong and the first data
 * row is left uncleared and then re-appended, silently duplicating an event.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sheetData: Record<string, string[][]> = {};
const clearCalls: string[] = [];
const updateCalls: Array<{ range: string; rows: unknown[][] }> = [];

vi.mock('../src/services/sheetsService.js', () => ({
  getSheetValues: async (_id: string, range: string) => sheetData[range] ?? [],
  appendSheetValues: async () => 0,
  updateSheetValues: async (_id: string, range: string, rows: unknown[][]) => {
    updateCalls.push({ range, rows });
    return rows.length;
  },
  clearSheetValues: async (_id: string, range: string) => {
    clearCalls.push(range);
  },
}));

const { deleteEventRow, findById, EventStoreError } = await import('../src/services/eventStore.js');

const RANGE = 'Events!A1:G';
const SID = 'sheet1';
const HEADER = ['event_id', 'event_name', 'event_date', 'folder_name', 'drive_folder_id', 'created_by', 'created_at'];

const row = (id: string, name: string): string[] => [id, name, '2026-05-01', `2026-05-01_${name}`, `folder-${id}`, 'a@x.org', 't'];

beforeEach(() => {
  for (const k of Object.keys(sheetData)) delete sheetData[k];
  clearCalls.length = 0;
  updateCalls.length = 0;
});

describe('deleteEventRow', () => {
  it('removes the row and rewrites survivors below the header, in order', async () => {
    sheetData[RANGE] = [HEADER, row('e1', 'Test'), row('e2', 'Real'), row('e3', 'Other')];

    expect(await deleteEventRow(SID, 'e2')).toBe(1);
    expect(clearCalls).toEqual(['Events!A2:G']);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.range).toBe('Events!A2:G3');
    expect(updateCalls[0]?.rows.map((r) => (r as string[])[0])).toEqual(['e1', 'e3']);
    // Rows are padded to the full width so values.update matches the range.
    expect((updateCalls[0]?.rows[0] as unknown[]).length).toBe(7);
  });

  it('anchors at row 1 when the tab has no header row', async () => {
    sheetData[RANGE] = [row('e1', 'Test'), row('e2', 'Real')];

    expect(await deleteEventRow(SID, 'e1')).toBe(1);
    expect(clearCalls).toEqual(['Events!A1:G']);
    expect(updateCalls[0]?.range).toBe('Events!A1:G1');
    expect(updateCalls[0]?.rows.map((r) => (r as string[])[0])).toEqual(['e2']);
  });

  it('clears without rewriting when the last event goes', async () => {
    sheetData[RANGE] = [HEADER, row('e1', 'Test')];

    expect(await deleteEventRow(SID, 'e1')).toBe(1);
    expect(clearCalls).toEqual(['Events!A2:G']);
    expect(updateCalls).toHaveLength(0);
  });

  it('is a no-op (0, no writes) for an unknown event — deleting twice is safe', async () => {
    sheetData[RANGE] = [HEADER, row('e1', 'Test')];

    expect(await deleteEventRow(SID, 'nope')).toBe(0);
    expect(clearCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });

  it('rejects a blank eventId rather than clearing the tab', async () => {
    sheetData[RANGE] = [HEADER, row('e1', 'Test')];
    await expect(deleteEventRow(SID, '  ')).rejects.toBeInstanceOf(EventStoreError);
    expect(clearCalls).toHaveLength(0);
  });
});

describe('findById', () => {
  it('returns the Sheet row (SSOT) for an event, or null', async () => {
    sheetData[RANGE] = [HEADER, row('e1', 'Test')];
    expect(await findById(SID, 'e1')).toMatchObject({ eventId: 'e1', name: 'Test', driveFolderId: 'folder-e1' });
    expect(await findById(SID, 'e9')).toBeNull();
  });
});
