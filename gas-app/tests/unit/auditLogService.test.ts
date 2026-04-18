import {
  appendAuditLog,
  getAuditLogs,
  CreateAuditLogInput,
} from '../../src/services/auditLogService';
import {
  resetMockSheets,
  mockSheets,
  createMockSheet,
  DEFAULT_AUDIT_ROWS,
  TEST_ADMIN_EMAIL,
} from '../mocks/gasGlobals';
import { ResultStatus, AuditAction } from '../../src/types/enums';
import { AuditLogRecord } from '../../src/types/models';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<CreateAuditLogInput> = {}): CreateAuditLogInput {
  return {
    actorEmail:   TEST_ADMIN_EMAIL,
    action:       AuditAction.USER_CREATED,
    resourceType: 'user',
    resourceId:   'newuser@example.com',
    details:      { email: 'newuser@example.com', runningClub: 'New_Bee', role: 'user' },
    ...overrides,
  };
}

/**
 * Returns the mockSpreadsheetApp's openById mock, configured so that a given
 * sheet name returns the supplied mock sheet (all others return null).
 */
function mockSpreadsheetWith(sheetName: string, sheet: ReturnType<typeof createMockSheet>) {
  const sa = (global as Record<string, unknown>)['SpreadsheetApp'] as { openById: jest.Mock };
  sa.openById.mockReturnValueOnce({
    getSheetByName: jest.fn().mockImplementation((name: string) =>
      name === sheetName ? sheet : null
    ),
  });
}

// ─── appendAuditLog ───────────────────────────────────────────────────────────

describe('appendAuditLog()', () => {
  beforeEach(() => {
    resetMockSheets();
  });

  it('appends exactly one row to the Audit_Log sheet', () => {
    appendAuditLog(makeInput());
    expect(mockSheets.Audit_Log.appendRow).toHaveBeenCalledTimes(1);
  });

  it('the appended row has 7 columns matching the schema', () => {
    appendAuditLog(makeInput());
    const row = mockSheets.Audit_Log.appendRow.mock.calls[0][0] as unknown[];
    expect(row).toHaveLength(7);
  });

  it('writes the correct action string to column 3', () => {
    appendAuditLog(makeInput({ action: AuditAction.EVENT_CREATED }));
    const row = mockSheets.Audit_Log.appendRow.mock.calls[0][0] as unknown[];
    expect(row[3]).toBe('EVENT_CREATED');
  });

  it('normalises actorEmail to lowercase', () => {
    appendAuditLog(makeInput({ actorEmail: 'Admin@MMRUNNERS.ORG' }));
    const row = mockSheets.Audit_Log.appendRow.mock.calls[0][0] as unknown[];
    expect(row[2]).toBe('admin@mmrunners.org');
  });

  it('generates a non-empty auditId (column 0)', () => {
    appendAuditLog(makeInput());
    const row = mockSheets.Audit_Log.appendRow.mock.calls[0][0] as unknown[];
    expect(typeof row[0]).toBe('string');
    expect((row[0] as string).length).toBeGreaterThan(0);
  });

  it('generates a timestamp in ISO 8601 format (column 1)', () => {
    appendAuditLog(makeInput());
    const row = mockSheets.Audit_Log.appendRow.mock.calls[0][0] as unknown[];
    expect(row[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('serialises details as a JSON string (column 6)', () => {
    const details = { email: 'x@x.com', role: 'user' };
    appendAuditLog(makeInput({ details }));
    const row = mockSheets.Audit_Log.appendRow.mock.calls[0][0] as unknown[];
    expect(() => JSON.parse(row[6] as string)).not.toThrow();
    expect(JSON.parse(row[6] as string)).toEqual(details);
  });

  it('writes resourceType and resourceId to columns 4 and 5', () => {
    appendAuditLog(makeInput({ resourceType: 'club', resourceId: 'New_Bee' }));
    const row = mockSheets.Audit_Log.appendRow.mock.calls[0][0] as unknown[];
    expect(row[4]).toBe('club');
    expect(row[5]).toBe('New_Bee');
  });

  it('accepts empty resourceId (used by report actions)', () => {
    appendAuditLog(makeInput({ resourceType: 'report', resourceId: '' }));
    const row = mockSheets.Audit_Log.appendRow.mock.calls[0][0] as unknown[];
    expect(row[5]).toBe('');
    // Must not throw — no error row appended elsewhere
    expect(mockSheets.Audit_Log.appendRow).toHaveBeenCalledTimes(1);
  });

  it('silently swallows sheet write errors (non-fatal)', () => {
    // Force the sheet lookup to return null → sheetService will throw
    const sa = (global as Record<string, unknown>)['SpreadsheetApp'] as { openById: jest.Mock };
    sa.openById.mockReturnValueOnce({
      getSheetByName: jest.fn().mockReturnValue(null),
    });

    // Must not throw
    expect(() => appendAuditLog(makeInput())).not.toThrow();
  });

  it('logs a non-fatal warning when the write fails', () => {
    const logger = (global as Record<string, unknown>)['Logger'] as { log: jest.Mock };
    const sa = (global as Record<string, unknown>)['SpreadsheetApp'] as { openById: jest.Mock };
    sa.openById.mockReturnValueOnce({
      getSheetByName: jest.fn().mockReturnValue(null),
    });

    appendAuditLog(makeInput());
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('[AuditLog] appendAuditLog failed')
    );
  });

  it('generates unique auditIds across multiple calls', () => {
    appendAuditLog(makeInput());
    appendAuditLog(makeInput());
    const id1 = mockSheets.Audit_Log.appendRow.mock.calls[0][0][0];
    const id2 = mockSheets.Audit_Log.appendRow.mock.calls[1][0][0];
    expect(id1).not.toBe(id2);
  });

  it('supports all AuditAction values without error', () => {
    for (const action of Object.values(AuditAction)) {
      expect(() => appendAuditLog(makeInput({ action }))).not.toThrow();
    }
  });
});

// ─── getAuditLogs ─────────────────────────────────────────────────────────────

describe('getAuditLogs()', () => {
  beforeEach(() => {
    resetMockSheets();
  });

  // ── Empty sheet ─────────────────────────────────────────────────────────────

  it('returns SUCCESS with an empty items array when the sheet is empty', () => {
    const result = getAuditLogs({ page: 1, pageSize: 50 });
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.items).toEqual([]);
    expect(result.data!.total).toBe(0);
  });

  // ── Basic read ──────────────────────────────────────────────────────────────

  it('returns all records when the sheet has rows', () => {
    mockSheets.Audit_Log = createMockSheet(DEFAULT_AUDIT_ROWS);
    mockSpreadsheetWith('Audit_Log', mockSheets.Audit_Log);

    const result = getAuditLogs({ page: 1, pageSize: 50 });

    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.items).toHaveLength(DEFAULT_AUDIT_ROWS.length);
    expect(result.data!.total).toBe(DEFAULT_AUDIT_ROWS.length);
  });

  it('returns records sorted newest-first by timestamp', () => {
    const older: unknown[] = [
      'id-old', '2026-01-01T08:00:00.000Z', TEST_ADMIN_EMAIL,
      'USER_UPDATED', 'user', 'a@b.com', '{}',
    ];
    const newer: unknown[] = [
      'id-new', '2026-04-18T10:00:00.000Z', TEST_ADMIN_EMAIL,
      'CLUB_CREATED', 'club', 'NewClub', '{}',
    ];
    mockSheets.Audit_Log = createMockSheet([older, newer]);
    mockSpreadsheetWith('Audit_Log', mockSheets.Audit_Log);

    const result = getAuditLogs({ page: 1, pageSize: 50 });

    expect(result.data!.items[0].auditId).toBe('id-new');
    expect(result.data!.items[1].auditId).toBe('id-old');
  });

  it('deserialises each record with the correct field types', () => {
    mockSheets.Audit_Log = createMockSheet([DEFAULT_AUDIT_ROWS[0]]);
    mockSpreadsheetWith('Audit_Log', mockSheets.Audit_Log);

    const result = getAuditLogs({ page: 1, pageSize: 50 });
    const item = result.data!.items[0] as AuditLogRecord;

    expect(item.auditId).toBe('audit-uuid-001');
    expect(item.actorEmail).toBe(TEST_ADMIN_EMAIL);
    expect(item.action).toBe(AuditAction.USER_CREATED);
    expect(item.resourceType).toBe('user');
    expect(item.resourceId).toBe('newuser@example.com');
    expect(typeof item.details).toBe('string');
  });

  // ── Pagination ──────────────────────────────────────────────────────────────

  it('paginates correctly — returns page 1 items only', () => {
    const rows = Array.from({ length: 10 }, (_, i) => [
      `id-${i}`,
      `2026-04-${String(18 - i).padStart(2, '0')}T10:00:00.000Z`,
      TEST_ADMIN_EMAIL, 'EXPORT_CSV', 'report', '', '{}',
    ]);
    mockSheets.Audit_Log = createMockSheet(rows);
    mockSpreadsheetWith('Audit_Log', mockSheets.Audit_Log);

    const result = getAuditLogs({ page: 1, pageSize: 3 });

    expect(result.data!.items).toHaveLength(3);
    expect(result.data!.total).toBe(10);
    expect(result.data!.page).toBe(1);
    expect(result.data!.pageSize).toBe(3);
  });

  it('paginates correctly — returns page 2 items', () => {
    const rows = Array.from({ length: 10 }, (_, i) => [
      `id-${i}`,
      `2026-04-${String(18 - i).padStart(2, '0')}T10:00:00.000Z`,
      TEST_ADMIN_EMAIL, 'EXPORT_CSV', 'report', '', '{}',
    ]);
    mockSheets.Audit_Log = createMockSheet(rows);
    mockSpreadsheetWith('Audit_Log', mockSheets.Audit_Log);

    const result = getAuditLogs({ page: 2, pageSize: 3 });

    expect(result.data!.items).toHaveLength(3);
    expect(result.data!.page).toBe(2);
  });

  it('returns an empty page when offset exceeds total', () => {
    mockSheets.Audit_Log = createMockSheet(DEFAULT_AUDIT_ROWS);
    mockSpreadsheetWith('Audit_Log', mockSheets.Audit_Log);

    const result = getAuditLogs({ page: 999, pageSize: 50 });

    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.items).toHaveLength(0);
    expect(result.data!.total).toBe(DEFAULT_AUDIT_ROWS.length);
  });

  // ── actorEmail filter ───────────────────────────────────────────────────────

  it('filters by actorEmail — exact match', () => {
    const rows: unknown[][] = [
      ['id-1', '2026-04-18T10:00:00.000Z', 'alice@example.com', 'USER_CREATED', 'user', 'x@x.com', '{}'],
      ['id-2', '2026-04-17T10:00:00.000Z', 'bob@example.com',   'CLUB_CREATED', 'club', 'C',       '{}'],
    ];
    mockSheets.Audit_Log = createMockSheet(rows);
    mockSpreadsheetWith('Audit_Log', mockSheets.Audit_Log);

    const result = getAuditLogs({ page: 1, pageSize: 50, actorEmail: 'alice@example.com' });

    expect(result.data!.items).toHaveLength(1);
    expect(result.data!.items[0].actorEmail).toBe('alice@example.com');
  });

  it('filters by actorEmail — partial substring match', () => {
    const rows: unknown[][] = [
      ['id-1', '2026-04-18T10:00:00.000Z', 'alice@example.com', 'USER_CREATED', 'user', 'x@x.com', '{}'],
      ['id-2', '2026-04-17T10:00:00.000Z', 'bob@mmrunners.org',  'CLUB_CREATED', 'club', 'C',       '{}'],
    ];
    mockSheets.Audit_Log = createMockSheet(rows);
    mockSpreadsheetWith('Audit_Log', mockSheets.Audit_Log);

    const result = getAuditLogs({ page: 1, pageSize: 50, actorEmail: 'mmrunners' });

    expect(result.data!.items).toHaveLength(1);
    expect(result.data!.items[0].actorEmail).toBe('bob@mmrunners.org');
  });

  it('filters by actorEmail — case-insensitive', () => {
    const rows: unknown[][] = [
      ['id-1', '2026-04-18T10:00:00.000Z', 'alice@example.com', 'USER_CREATED', 'user', 'x@x.com', '{}'],
    ];
    mockSheets.Audit_Log = createMockSheet(rows);
    mockSpreadsheetWith('Audit_Log', mockSheets.Audit_Log);

    const result = getAuditLogs({ page: 1, pageSize: 50, actorEmail: 'ALICE' });

    expect(result.data!.items).toHaveLength(1);
  });

  it('returns empty when actorEmail filter matches no rows', () => {
    mockSheets.Audit_Log = createMockSheet(DEFAULT_AUDIT_ROWS);
    mockSpreadsheetWith('Audit_Log', mockSheets.Audit_Log);

    const result = getAuditLogs({ page: 1, pageSize: 50, actorEmail: 'nobody@nowhere.com' });

    expect(result.data!.items).toHaveLength(0);
    expect(result.data!.total).toBe(0);
  });

  // ── Date range filters ──────────────────────────────────────────────────────

  it('filters by dateFrom — excludes entries before the cutoff date', () => {
    const rows: unknown[][] = [
      ['id-1', '2026-04-18T10:00:00.000Z', TEST_ADMIN_EMAIL, 'USER_CREATED',  'user',   'a', '{}'],
      ['id-2', '2026-03-01T10:00:00.000Z', TEST_ADMIN_EMAIL, 'EVENT_CREATED', 'event',  'b', '{}'],
    ];
    mockSheets.Audit_Log = createMockSheet(rows);
    mockSpreadsheetWith('Audit_Log', mockSheets.Audit_Log);

    const result = getAuditLogs({ page: 1, pageSize: 50, dateFrom: '2026-04-01' });

    expect(result.data!.items).toHaveLength(1);
    expect(result.data!.items[0].auditId).toBe('id-1');
  });

  it('filters by dateTo — excludes entries after the cutoff date', () => {
    const rows: unknown[][] = [
      ['id-1', '2026-04-18T10:00:00.000Z', TEST_ADMIN_EMAIL, 'USER_CREATED',  'user',  'a', '{}'],
      ['id-2', '2026-03-01T10:00:00.000Z', TEST_ADMIN_EMAIL, 'CLUB_CREATED',  'club',  'b', '{}'],
    ];
    mockSheets.Audit_Log = createMockSheet(rows);
    mockSpreadsheetWith('Audit_Log', mockSheets.Audit_Log);

    const result = getAuditLogs({ page: 1, pageSize: 50, dateTo: '2026-03-31' });

    expect(result.data!.items).toHaveLength(1);
    expect(result.data!.items[0].auditId).toBe('id-2');
  });

  it('applies dateFrom and dateTo together as a closed range', () => {
    const rows: unknown[][] = [
      ['id-early', '2026-01-01T00:00:00.000Z', TEST_ADMIN_EMAIL, 'USER_CREATED',  'user', 'a', '{}'],
      ['id-in',    '2026-04-10T12:00:00.000Z', TEST_ADMIN_EMAIL, 'CLUB_CREATED',  'club', 'b', '{}'],
      ['id-late',  '2026-05-01T00:00:00.000Z', TEST_ADMIN_EMAIL, 'EVENT_CREATED', 'event','c', '{}'],
    ];
    mockSheets.Audit_Log = createMockSheet(rows);
    mockSpreadsheetWith('Audit_Log', mockSheets.Audit_Log);

    const result = getAuditLogs({
      page: 1, pageSize: 50,
      dateFrom: '2026-04-01',
      dateTo:   '2026-04-30',
    });

    expect(result.data!.items).toHaveLength(1);
    expect(result.data!.items[0].auditId).toBe('id-in');
  });

  it('combines actorEmail and date filters', () => {
    const rows: unknown[][] = [
      ['id-1', '2026-04-18T10:00:00.000Z', 'alice@example.com', 'USER_CREATED', 'user', 'x', '{}'],
      ['id-2', '2026-04-18T11:00:00.000Z', 'bob@example.com',   'CLUB_CREATED', 'club', 'y', '{}'],
      ['id-3', '2026-03-01T10:00:00.000Z', 'alice@example.com', 'EXPORT_CSV',   'report','', '{}'],
    ];
    mockSheets.Audit_Log = createMockSheet(rows);
    mockSpreadsheetWith('Audit_Log', mockSheets.Audit_Log);

    const result = getAuditLogs({
      page: 1, pageSize: 50,
      actorEmail: 'alice',
      dateFrom:   '2026-04-01',
    });

    // Only id-1 matches: alice AND >= 2026-04-01
    expect(result.data!.items).toHaveLength(1);
    expect(result.data!.items[0].auditId).toBe('id-1');
  });

  // ── Malformed rows ──────────────────────────────────────────────────────────

  it('silently skips rows that fail toAuditLogRecord validation', () => {
    const validRow: unknown[] = [
      'id-valid', '2026-04-18T10:00:00.000Z', TEST_ADMIN_EMAIL,
      'USER_CREATED', 'user', 'x@x.com', '{}',
    ];
    const badRow: unknown[] = ['', '', '', 'NOT_AN_ACTION', '', '', ''];
    mockSheets.Audit_Log = createMockSheet([validRow, badRow]);
    mockSpreadsheetWith('Audit_Log', mockSheets.Audit_Log);

    const result = getAuditLogs({ page: 1, pageSize: 50 });

    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data!.items).toHaveLength(1);
    expect(result.data!.items[0].auditId).toBe('id-valid');
  });

  // ── Error path ──────────────────────────────────────────────────────────────

  it('returns ERROR when the sheet cannot be accessed', () => {
    const sa = (global as Record<string, unknown>)['SpreadsheetApp'] as { openById: jest.Mock };
    sa.openById.mockReturnValueOnce({
      getSheetByName: jest.fn().mockReturnValue(null),
    });

    const result = getAuditLogs({ page: 1, pageSize: 50 });
    expect(result.status).toBe(ResultStatus.ERROR);
    expect(result.message).toContain('Failed to read audit log');
  });
});
