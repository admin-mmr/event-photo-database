/**
 * auditStore.test.ts — `listAudit` filtering over the Audit_Log tab.
 *
 * The route test mocks `listAudit` wholesale, so the date-range logic itself
 * was never exercised. `AuditFilter.until` is documented as an INCLUSIVE upper
 * bound, and the admin screen feeds it a bare `YYYY-MM-DD` from an
 * `<input type="date">`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sheetData: Record<string, string[][]> = {};
vi.mock('../src/services/sheetsService.js', () => ({
  getSheetValues: async (_id: string, range: string) => sheetData[range] ?? [],
  appendSheetValues: async () => undefined,
}));

const { listAudit } = await import('../src/services/auditStore.js');

const RANGE = 'Audit_Log!A1:J';
const HEADER = ['auditid', 'timestamp', 'actor_email', 'action', 'resource_type', 'resource_id', 'details', 'link_id', 'ip', 'reason'];
const SID = 'sheet1';

function auditRow(auditId: string, timestamp: string, actorEmail = 'boss@x.org'): string[] {
  const r = new Array(10).fill('');
  r[0] = auditId;
  r[1] = timestamp;
  r[2] = actorEmail;
  r[3] = 'USER_CREATED';
  r[4] = 'user';
  return r;
}

beforeEach(() => {
  for (const k of Object.keys(sheetData)) delete sheetData[k];
});

describe('listAudit date range', () => {
  it('includes the whole final day for a date-only until', async () => {
    sheetData[RANGE] = [
      HEADER,
      auditRow('a', '2026-06-15T09:30:00.000Z'),
      auditRow('b', '2026-06-15T23:59:59.000Z'),
      auditRow('c', '2026-06-16T00:00:00.000Z'),
    ];
    const recs = await listAudit(SID, { since: '2026-06-15', until: '2026-06-15' });
    expect(recs.map((r) => r.auditId).sort()).toEqual(['a', 'b']);
  });

  it('leaves an until that already carries a time exactly as given', async () => {
    sheetData[RANGE] = [
      HEADER,
      auditRow('a', '2026-06-15T09:00:00.000Z'),
      auditRow('b', '2026-06-15T11:00:00.000Z'),
    ];
    const recs = await listAudit(SID, { until: '2026-06-15T10:00:00.000Z' });
    expect(recs.map((r) => r.auditId)).toEqual(['a']);
  });

  it('keeps the since bound inclusive', async () => {
    sheetData[RANGE] = [
      HEADER,
      auditRow('a', '2026-06-14T23:59:59.000Z'),
      auditRow('b', '2026-06-15T00:00:00.000Z'),
    ];
    const recs = await listAudit(SID, { since: '2026-06-15' });
    expect(recs.map((r) => r.auditId)).toEqual(['b']);
  });
});
