/**
 * migrationService.test.ts — unit tests for the Phase 7 legacy migration.
 *
 * Covers:
 *   - Upload_Log admin-club row detection and flagging
 *   - Users row normalisation (legacy roles, short rows, bad statuses)
 *   - Dry-run mode: no writes, correct counts
 *   - Commit mode: writes are made, audit log appended
 *   - Idempotency: re-running after commit makes no further changes
 */

import {
  migrateFromLegacy,
} from '../../src/services/migrationService';
import {
  resetMockSheets,
  mockSheets,
  createMockSheet,
  TEST_ADMIN_EMAIL,
} from '../mocks/gasGlobals';
import { UserRole, UserStatus } from '../../src/types/enums';

// ─── Sheet factories ──────────────────────────────────────────────────────────

const UPLOAD_LOG_HEADERS = [
  'LOG_ID','EVENT_ID','CLUB_NAME','UPLOADED_BY','BATCH_FOLDER_NAME',
  'BATCH_FOLDER_ID','FILE_COUNT','TOTAL_SIZE_MB','SKIPPED_DUPLICATES',
  'SKIPPED_NON_PHOTO','UPLOAD_TIMESTAMP','SOURCE','LINK_ID',
];

const USERS_HEADERS = [
  'EMAIL','FIRST_NAME','LAST_NAME','ROLE','STATUS','CLUB_ID',
  'ADDED_DATE','ADDED_BY','LAST_LOGIN_AT',
];

function createSheet(headers: string[], dataRows: unknown[][] = []) {
  const mockSetValues = jest.fn();
  const sheet = {
    getLastRow:    jest.fn().mockReturnValue(dataRows.length + 1),
    getLastColumn: jest.fn().mockReturnValue(headers.length),
    getRange: jest.fn().mockImplementation(
      (rowStart: number, _c: number, numRows?: number, numCols?: number) => {
        if (rowStart === 1 && numRows === 1) {
          return {
            getValues: jest.fn().mockReturnValue([headers.slice(0, numCols ?? headers.length)]),
            setValues: mockSetValues,
          };
        }
        const idx = rowStart - 2;
        const slice = numRows ? dataRows.slice(idx, idx + numRows) : dataRows.slice(idx);
        return {
          getValues: jest.fn().mockReturnValue(slice),
          setValues: mockSetValues,
        };
      }
    ),
    appendRow: jest.fn(),
    _setValuesMock: mockSetValues,
  };
  return sheet as unknown as ReturnType<typeof createMockSheet> & { _setValuesMock: jest.Mock };
}

function wireMockSpreadsheetApp() {
  const sApp = (global as Record<string, unknown>)['SpreadsheetApp'] as { openById: jest.Mock };
  sApp.openById.mockReturnValue({
    getSheetByName: jest.fn().mockImplementation((name: string) => mockSheets[name] ?? null),
  });
}

// ─── Row builders ─────────────────────────────────────────────────────────────

function makeUploadLogRow(clubName: string, logId = 'log-001'): unknown[] {
  return [
    logId, 'evt-001', clubName, 'uploader@example.com',
    '20251103-093500_vol', 'folder-id', 5, 2.3, 0, 0,
    '2025-11-03T10:00:00.000Z', 'link', '',
  ];
}

function makeUserRow(
  email: string,
  role: string,
  status = 'active',
  includeLastLogin = true
): unknown[] {
  const row: unknown[] = [
    email, 'First', 'Last', role, status, 'New_Bee',
    '2025-01-01', TEST_ADMIN_EMAIL,
  ];
  if (includeLastLogin) row.push('');
  return row;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  resetMockSheets();
  // Default: empty sheets
  mockSheets['Upload_Log'] = createSheet(UPLOAD_LOG_HEADERS);
  mockSheets['Users']      = createSheet(USERS_HEADERS);
  mockSheets['Audit_Log']  = createSheet(['AUDIT_ID','TIMESTAMP','ACTOR_EMAIL','ACTION',
    'RESOURCE_TYPE','RESOURCE_ID','DETAILS','LINK_ID','IP_ADDRESS','REASON']);
  wireMockSpreadsheetApp();
});

// ─── Dry-run basic behaviour ──────────────────────────────────────────────────

describe('migrateFromLegacy() — dry-run mode (default)', () => {
  it('returns dryRun=true and zero counts for empty sheets', () => {
    const result = migrateFromLegacy();
    expect(result.dryRun).toBe(true);
    expect(result.uploadLogAdminClubRows).toBe(0);
    expect(result.usersRoleNormalised).toBe(0);
    expect(result.usersPadded).toBe(0);
  });

  it('counts admin-club Upload_Log rows but does NOT write', () => {
    mockSheets['Upload_Log'] = createSheet(UPLOAD_LOG_HEADERS, [
      makeUploadLogRow('New_Bee', 'log-001'),
      makeUploadLogRow('__admin__', 'log-002'),
      makeUploadLogRow('__admin__', 'log-003'),
    ]);
    wireMockSpreadsheetApp();

    const result = migrateFromLegacy({ dryRun: true });
    expect(result.uploadLogAdminClubRows).toBe(2);
    // No writes in dry-run
    const sheet = mockSheets['Upload_Log'] as unknown as { _setValuesMock: jest.Mock };
    expect(sheet._setValuesMock).not.toHaveBeenCalled();
  });

  it('counts legacy-role Users rows but does NOT write', () => {
    mockSheets['Users'] = createSheet(USERS_HEADERS, [
      makeUserRow('a@example.com', 'admin'),    // legacy → super_admin
      makeUserRow('b@example.com', 'user'),     // legacy → club_admin
      makeUserRow('c@example.com', 'super_admin'), // already valid
    ]);
    wireMockSpreadsheetApp();

    const result = migrateFromLegacy({ dryRun: true });
    expect(result.usersRoleNormalised).toBe(2);
    const sheet = mockSheets['Users'] as unknown as { _setValuesMock: jest.Mock };
    expect(sheet._setValuesMock).not.toHaveBeenCalled();
  });

  it('counts short Users rows (missing LAST_LOGIN_AT) but does NOT write', () => {
    mockSheets['Users'] = createSheet(USERS_HEADERS, [
      makeUserRow('a@example.com', 'super_admin', 'active', false), // 8 cols, no lastLoginAt
    ]);
    wireMockSpreadsheetApp();

    const result = migrateFromLegacy({ dryRun: true });
    expect(result.usersPadded).toBe(1);
    const sheet = mockSheets['Users'] as unknown as { _setValuesMock: jest.Mock };
    expect(sheet._setValuesMock).not.toHaveBeenCalled();
  });

  it('populates the changes array with DRY RUN prefix', () => {
    mockSheets['Upload_Log'] = createSheet(UPLOAD_LOG_HEADERS, [
      makeUploadLogRow('__admin__', 'log-x'),
    ]);
    wireMockSpreadsheetApp();

    const result = migrateFromLegacy({ dryRun: true });
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.changes[0]).toMatch(/^\[DRY RUN\]/);
  });

  it('does NOT append to the Audit_Log in dry-run mode', () => {
    mockSheets['Upload_Log'] = createSheet(UPLOAD_LOG_HEADERS, [
      makeUploadLogRow('__admin__', 'log-x'),
    ]);
    wireMockSpreadsheetApp();

    migrateFromLegacy({ dryRun: true });
    expect(mockSheets['Audit_Log'].appendRow).not.toHaveBeenCalled();
  });
});

// ─── Commit mode ──────────────────────────────────────────────────────────────

describe('migrateFromLegacy() — commit mode (dryRun=false)', () => {
  it('flags Upload_Log admin-club rows by rewriting clubName', () => {
    mockSheets['Upload_Log'] = createSheet(UPLOAD_LOG_HEADERS, [
      makeUploadLogRow('__admin__', 'log-x'),
    ]);
    wireMockSpreadsheetApp();

    const result = migrateFromLegacy({ dryRun: false });
    expect(result.uploadLogAdminClubRows).toBe(1);
    expect(result.dryRun).toBe(false);

    const sheet = mockSheets['Upload_Log'] as unknown as { _setValuesMock: jest.Mock };
    expect(sheet._setValuesMock).toHaveBeenCalledTimes(1);
    const written = (sheet._setValuesMock.mock.calls[0][0] as unknown[][])[0];
    expect(String(written[2])).toContain('NEEDS_REATTRIBUTION');
  });

  it('normalises legacy role strings in Users sheet', () => {
    mockSheets['Users'] = createSheet(USERS_HEADERS, [
      makeUserRow('a@example.com', 'admin'),
    ]);
    wireMockSpreadsheetApp();

    const result = migrateFromLegacy({ dryRun: false });
    expect(result.usersRoleNormalised).toBe(1);

    const sheet = mockSheets['Users'] as unknown as { _setValuesMock: jest.Mock };
    expect(sheet._setValuesMock).toHaveBeenCalledTimes(1);
    const written = (sheet._setValuesMock.mock.calls[0][0] as unknown[][])[0];
    expect(written[3]).toBe(UserRole.SUPER_ADMIN);
  });

  it('pads short Users rows with empty LAST_LOGIN_AT', () => {
    mockSheets['Users'] = createSheet(USERS_HEADERS, [
      makeUserRow('a@example.com', 'super_admin', 'active', false),
    ]);
    wireMockSpreadsheetApp();

    const result = migrateFromLegacy({ dryRun: false });
    expect(result.usersPadded).toBe(1);

    const sheet = mockSheets['Users'] as unknown as { _setValuesMock: jest.Mock };
    expect(sheet._setValuesMock).toHaveBeenCalledTimes(1);
    const written = (sheet._setValuesMock.mock.calls[0][0] as unknown[][])[0];
    expect(written).toHaveLength(9);
    expect(written[8]).toBe(''); // LAST_LOGIN_AT padded to ''
  });

  it('normalises invalid status to active', () => {
    mockSheets['Users'] = createSheet(USERS_HEADERS, [
      makeUserRow('a@example.com', 'club_admin', 'legacy_status'),
    ]);
    wireMockSpreadsheetApp();

    const result = migrateFromLegacy({ dryRun: false });
    const sheet = mockSheets['Users'] as unknown as { _setValuesMock: jest.Mock };
    expect(sheet._setValuesMock).toHaveBeenCalledTimes(1);
    const written = (sheet._setValuesMock.mock.calls[0][0] as unknown[][])[0];
    expect(written[4]).toBe(UserStatus.ACTIVE);
    // Should show up in changes
    expect(result.changes.some(c => c.includes('defaulted'))).toBe(true);
  });

  it('appends exactly one Audit_Log row after changes', () => {
    mockSheets['Upload_Log'] = createSheet(UPLOAD_LOG_HEADERS, [
      makeUploadLogRow('__admin__', 'log-x'),
    ]);
    wireMockSpreadsheetApp();

    migrateFromLegacy({ dryRun: false });
    expect(mockSheets['Audit_Log'].appendRow).toHaveBeenCalledTimes(1);
    const auditRow = mockSheets['Audit_Log'].appendRow.mock.calls[0][0] as unknown[];
    expect(auditRow[3]).toBe('DATA_MIGRATED');
  });

  it('does NOT append to Audit_Log when there is nothing to migrate', () => {
    // All sheets clean — no admin-club rows, no legacy roles
    migrateFromLegacy({ dryRun: false });
    expect(mockSheets['Audit_Log'].appendRow).not.toHaveBeenCalled();
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('migrateFromLegacy() — edge cases', () => {
  it('includes rowsInspected count covering both sheets', () => {
    mockSheets['Upload_Log'] = createSheet(UPLOAD_LOG_HEADERS, [
      makeUploadLogRow('New_Bee', 'log-1'),
      makeUploadLogRow('New_Bee', 'log-2'),
    ]);
    mockSheets['Users'] = createSheet(USERS_HEADERS, [
      makeUserRow('a@example.com', 'super_admin'),
    ]);
    wireMockSpreadsheetApp();

    const result = migrateFromLegacy({ dryRun: true });
    expect(result.rowsInspected).toBe(3); // 2 upload + 1 user
  });

  it('flags unrecognised roles (not in LEGACY_ROLE_MAP) with a WARN but does not count them', () => {
    mockSheets['Users'] = createSheet(USERS_HEADERS, [
      makeUserRow('a@example.com', 'unknown_legacy_role'),
    ]);
    wireMockSpreadsheetApp();

    const result = migrateFromLegacy({ dryRun: true });
    // Should NOT count as normalised — just warn
    expect(result.usersRoleNormalised).toBe(0);
    expect(result.changes.some(c => c.includes('WARN') && c.includes('unknown_legacy_role'))).toBe(true);
  });

  it('is idempotent: commit then commit again makes no further changes', () => {
    mockSheets['Upload_Log'] = createSheet(UPLOAD_LOG_HEADERS, [
      makeUploadLogRow('__admin__', 'log-x'),
    ]);
    mockSheets['Users'] = createSheet(USERS_HEADERS, [
      makeUserRow('a@example.com', 'admin'),
    ]);
    wireMockSpreadsheetApp();

    // First commit
    const first = migrateFromLegacy({ dryRun: false });
    expect(first.uploadLogAdminClubRows).toBe(1);
    expect(first.usersRoleNormalised).toBe(1);

    // Rebuild sheets with already-migrated data
    mockSheets['Upload_Log'] = createSheet(UPLOAD_LOG_HEADERS, [
      makeUploadLogRow('__admin__[NEEDS_REATTRIBUTION]', 'log-x'),
    ]);
    mockSheets['Users'] = createSheet(USERS_HEADERS, [
      makeUserRow('a@example.com', UserRole.SUPER_ADMIN), // already normalised
    ]);
    wireMockSpreadsheetApp();

    const second = migrateFromLegacy({ dryRun: false });
    expect(second.uploadLogAdminClubRows).toBe(0);
    expect(second.usersRoleNormalised).toBe(0);
  });
});
