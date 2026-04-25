import {
  toUserRecord,
  fromUserRecord,
  toEventRecord,
  fromEventRecord,
  toUploadLogRecord,
  fromUploadLogRecord,
  toClubRecord,
  fromClubRecord,
  toAuditLogRecord,
  fromAuditLogRecord,
  toPhotosFileRecord,
  fromPhotosFileRecord,
  toEmailPreferenceRecord,
  fromEmailPreferenceRecord,
} from '../../src/utils/sheetMapper';
import { UserRole, UserStatus, UploadSource, AuditAction } from '../../src/types/enums';
import { UserRecord } from '../../src/types/models';

// ─── Users ────────────────────────────────────────────────────────────────────

describe('sheetMapper — Users', () => {
  // 11-column schema: email(0) firstName(1) lastName(2) role(3) clubId(4)
  //   notify_new_events(5) notify_daily_digest(6) status(7)
  //   added_date(8) added_by(9) last_login_at(10)
  const validRow: unknown[] = [
    'admin@mmrunners.org', 'Test', 'Admin', 'super_admin', '', '', '', 'active', '2025-01-01', 'system', '',
  ];

  describe('toUserRecord()', () => {
    it('maps a complete valid row', () => {
      const record = toUserRecord(validRow);
      expect(record).not.toBeNull();
      expect(record!.email).toBe('admin@mmrunners.org');
      expect(record!.firstName).toBe('Test');
      expect(record!.lastName).toBe('Admin');
      expect(record!.role).toBe(UserRole.SUPER_ADMIN);
      expect(record!.status).toBe(UserStatus.ACTIVE);
      expect(record!.clubId).toBe('');
      expect(record!.addedDate).toBe('2025-01-01');
      expect(record!.addedBy).toBe('system');
    });

    it('normalizes email to lowercase', () => {
      const row = ['Admin@EXAMPLE.COM', 'First', 'Last', 'club_admin', 'New_Bee', '', '', 'active', '', '', ''];
      const record = toUserRecord(row);
      expect(record!.email).toBe('admin@example.com');
    });

    it('trims whitespace from all string fields', () => {
      const row = ['  alice@example.com  ', '  Alice  ', '  Smith  ', 'club_admin', '  New_Bee  ', '', '', 'active', '', '', ''];
      const record = toUserRecord(row);
      expect(record!.email).toBe('alice@example.com');
      expect(record!.firstName).toBe('Alice');
      expect(record!.clubId).toBe('New_Bee');
    });

    it('returns null for empty email', () => {
      const row = ['', 'First', 'Last', 'super_admin', '', '', '', 'active', '', '', ''];
      expect(toUserRecord(row)).toBeNull();
    });

    it('returns null for whitespace-only email', () => {
      const row = ['   ', 'First', 'Last', 'club_admin', 'New_Bee', '', '', 'active', '', '', ''];
      expect(toUserRecord(row)).toBeNull();
    });

    it('returns null for invalid role', () => {
      const row = ['alice@example.com', 'Alice', 'Smith', 'admin', '', '', '', 'active', '', '', ''];
      expect(toUserRecord(row)).toBeNull();
    });

    it('returns null for invalid status', () => {
      const row = ['alice@example.com', 'Alice', 'Smith', 'club_admin', 'New_Bee', '', '', 'pending', '', '', ''];
      expect(toUserRecord(row)).toBeNull();
    });

    it('returns null for row with fewer than 10 columns', () => {
      expect(toUserRecord(['a', 'b', 'c'])).toBeNull();
      expect(toUserRecord([])).toBeNull();
    });

    it('handles Sheets returning Date objects for date columns', () => {
      // Google Sheets returns DATE-typed cells as Date objects in GAS.
      // formatSheetDate() must convert them to "YYYY-MM-DD", NOT the full
      // Date.toString() locale string like "Thu Apr 09 2026 00:00:00 GMT-0400".
      const localDate = new Date(2025, 1, 1); // Feb 1 2025 in local time
      const row: unknown[] = [
        'alice@example.com', 'Alice', 'Smith', 'club_admin', 'New_Bee', '', '', 'active',
        localDate, 'admin@mmrunners.org', '',
      ];
      const record = toUserRecord(row);
      expect(record).not.toBeNull();
      expect(record!.addedDate).toBe('2025-02-01');
    });

    it('does not store the full Date.toString() locale string for date cells', () => {
      // Regression: before the fix, String(new Date(...)) produced a long
      // locale string like "Sat Feb 01 2025 00:00:00 GMT-0500 (EST)".
      const localDate = new Date(2025, 3, 9); // Apr 9 2025 in local time
      const row: unknown[] = [
        'bob@example.com', 'Bob', 'Smith', 'super_admin', '', '', '', 'active',
        localDate, 'system', '',
      ];
      const record = toUserRecord(row);
      expect(record!.addedDate).not.toContain('GMT');
      expect(record!.addedDate).not.toContain(':');
      expect(record!.addedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('preserves plain ISO string addedDate unchanged', () => {
      const row: unknown[] = [
        'carol@example.com', 'Carol', 'Smith', 'club_admin', 'New_Bee', '', '', 'active',
        '2025-06-15', 'admin@mmrunners.org', '',
      ];
      const record = toUserRecord(row);
      expect(record!.addedDate).toBe('2025-06-15');
    });

    it('accepts all valid UserRole values', () => {
      for (const role of Object.values(UserRole)) {
        const row = ['alice@example.com', 'Alice', 'Smith', role, '', '', '', 'active', '', '', ''];
        expect(toUserRecord(row)).not.toBeNull();
      }
    });

    it('accepts all valid UserStatus values', () => {
      for (const status of Object.values(UserStatus)) {
        const row = ['alice@example.com', 'Alice', 'Smith', 'super_admin', '', '', '', status, '', '', ''];
        expect(toUserRecord(row)).not.toBeNull();
      }
    });
  });

  describe('fromUserRecord()', () => {
    it('produces an array of 11 elements', () => {
      const record = toUserRecord(validRow)!;
      const row = fromUserRecord(record);
      expect(row).toHaveLength(11);
    });

    it('preserves all field values', () => {
      const record = toUserRecord(validRow)!;
      const row = fromUserRecord(record);
      expect(row[0]).toBe('admin@mmrunners.org'); // email
      expect(row[1]).toBe('Test');                // firstName
      expect(row[2]).toBe('Admin');               // lastName
      expect(row[3]).toBe('super_admin');          // role
      expect(row[4]).toBe('');                     // clubId
      expect(row[7]).toBe('active');               // status (col 7)
      expect(row[8]).toBe('2025-01-01');           // addedDate
      expect(row[9]).toBe('system');               // addedBy
    });
  });

  describe('roundtrip: toUserRecord → fromUserRecord → toUserRecord', () => {
    it('produces an identical record after roundtrip', () => {
      const original = toUserRecord(validRow)!;
      const row = fromUserRecord(original);
      const restored = toUserRecord(row);
      expect(restored).toEqual(original);
    });

    it('roundtrip preserves all UserRole values', () => {
      const record: UserRecord = {
        email:       'test@example.com',
        firstName:   'Test',
        lastName:    'User',
        role:        UserRole.CLUB_ADMIN,
        status:      UserStatus.INACTIVE,
        clubId:      'New_Bee',
        addedDate:   '2025-03-01',
        addedBy:     'admin@mmrunners.org',
        lastLoginAt: '',
      };
      const restored = toUserRecord(fromUserRecord(record));
      expect(restored).toEqual(record);
    });
  });
});

// ─── Events ───────────────────────────────────────────────────────────────────

describe('sheetMapper — Events', () => {
  const validRow: unknown[] = [
    'evt-uuid-001', 'NYC Marathon', '2025-11-03',
    '2025-11-03_NYC_Marathon', 'drive-folder-id-001',
    'admin@mmrunners.org', '2025-10-01T09:00:00.000Z',
  ];

  describe('toEventRecord()', () => {
    it('maps a complete valid row', () => {
      const record = toEventRecord(validRow);
      expect(record).not.toBeNull();
      expect(record!.eventId).toBe('evt-uuid-001');
      expect(record!.eventName).toBe('NYC Marathon');
      expect(record!.eventDate).toBe('2025-11-03');
      expect(record!.folderName).toBe('2025-11-03_NYC_Marathon');
      expect(record!.driveFolderId).toBe('drive-folder-id-001');
      expect(record!.createdBy).toBe('admin@mmrunners.org');
      expect(record!.createdAt).toBe('2025-10-01T09:00:00.000Z');
    });

    it('returns null when eventId is missing', () => {
      const row = ['', 'NYC Marathon', '2025-11-03', 'folder', 'drive-id', 'admin@x.com', 'ts'];
      expect(toEventRecord(row)).toBeNull();
    });

    it('returns null when eventName is missing', () => {
      const row = ['uuid', '', '2025-11-03', 'folder', 'drive-id', 'admin@x.com', 'ts'];
      expect(toEventRecord(row)).toBeNull();
    });

    it('returns null when driveFolderId is missing', () => {
      const row = ['uuid', 'NYC Marathon', '2025-11-03', 'folder', '', 'admin@x.com', 'ts'];
      expect(toEventRecord(row)).toBeNull();
    });

    it('returns null for row with fewer than 7 columns', () => {
      expect(toEventRecord(['uuid', 'name'])).toBeNull();
      expect(toEventRecord([])).toBeNull();
    });

    it('trims whitespace from all fields', () => {
      const row: unknown[] = [
        '  evt-uuid-001  ', '  NYC Marathon  ', '2025-11-03',
        '  2025-11-03_NYC_Marathon  ', '  drive-folder-id-001  ',
        '  admin@mmrunners.org  ', '  2025-10-01T09:00:00.000Z  ',
      ];
      const record = toEventRecord(row);
      expect(record!.eventId).toBe('evt-uuid-001');
      expect(record!.eventName).toBe('NYC Marathon');
      expect(record!.folderName).toBe('2025-11-03_NYC_Marathon');
      expect(record!.driveFolderId).toBe('drive-folder-id-001');
      expect(record!.createdBy).toBe('admin@mmrunners.org');
    });

    it('normalizes createdBy to lowercase', () => {
      const row = ['uuid', 'Event', '2025-01-01', 'folder', 'drive-id', 'Admin@MMRUNNERS.ORG', 'ts'];
      const record = toEventRecord(row);
      expect(record!.createdBy).toBe('admin@mmrunners.org');
    });

    it('returns null when eventId is whitespace-only', () => {
      const row = ['   ', 'NYC Marathon', '2025-11-03', 'folder', 'drive-id', 'admin@x.com', 'ts'];
      expect(toEventRecord(row)).toBeNull();
    });

    it('returns null when eventName is whitespace-only', () => {
      const row = ['uuid', '   ', '2025-11-03', 'folder', 'drive-id', 'admin@x.com', 'ts'];
      expect(toEventRecord(row)).toBeNull();
    });

    it('returns null when driveFolderId is whitespace-only', () => {
      const row = ['uuid', 'Event', '2025-11-03', 'folder', '   ', 'admin@x.com', 'ts'];
      expect(toEventRecord(row)).toBeNull();
    });

    it('handles numeric cell values via String() coercion', () => {
      const row: unknown[] = [123, 'NYC Marathon', '2025-11-03', 'folder', 'drive-id', 'admin@x.com', 'ts'];
      const record = toEventRecord(row);
      expect(record!.eventId).toBe('123');
    });

    it('handles Sheets returning Date objects for eventDate', () => {
      // Google Sheets returns DATE-typed cells as Date objects in GAS.
      // formatSheetDate() must produce "YYYY-MM-DD", not the full locale string
      // like "Sun Mar 15 2026 00:00:00 GMT-0400 (Eastern Daylight Time)".
      const localDate = new Date(2026, 2, 15); // Mar 15 2026 in local time
      const row: unknown[] = [
        'evt-uuid-001', 'NYC Half Marathon', localDate,
        '2026-03-15_NYC_Half_Marathon', 'drive-folder-id-001',
        'admin@mmrunners.org', '2026-01-01T09:00:00.000Z',
      ];
      const record = toEventRecord(row);
      expect(record).not.toBeNull();
      expect(record!.eventDate).toBe('2026-03-15');
    });

    it('does not store the full Date.toString() locale string for eventDate', () => {
      // Regression: before the fix, String(new Date(...)) returned something like
      // "Sun Mar 15 2026 00:00:00 GMT-0400 (Eastern Daylight Time)" which was
      // then displayed verbatim in the Photos page event date column.
      const localDate = new Date(2026, 2, 15); // Mar 15 2026 in local time
      const row: unknown[] = [
        'evt-uuid-001', 'NYC Half Marathon', localDate,
        '2026-03-15_NYC_Half_Marathon', 'drive-folder-id-001',
        'admin@mmrunners.org', '2026-01-01T09:00:00.000Z',
      ];
      const record = toEventRecord(row);
      expect(record!.eventDate).not.toContain('GMT');
      expect(record!.eventDate).not.toContain(':');
      expect(record!.eventDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('preserves a plain ISO string eventDate unchanged', () => {
      // When the cell is already a plain string (e.g. re-read after a write),
      // formatSheetDate() must pass it through untouched.
      const row: unknown[] = [
        'evt-uuid-001', 'NYC Half Marathon', '2026-03-15',
        '2026-03-15_NYC_Half_Marathon', 'drive-folder-id-001',
        'admin@mmrunners.org', '2026-01-01T09:00:00.000Z',
      ];
      const record = toEventRecord(row);
      expect(record!.eventDate).toBe('2026-03-15');
    });

    it('eventDate Date roundtrip survives toEventRecord → fromEventRecord → toEventRecord', () => {
      // After the Date is converted to "YYYY-MM-DD" on the first parse,
      // writing back and re-reading must produce the same string.
      const localDate = new Date(2026, 10, 1); // Nov 1 2026 in local time
      const row: unknown[] = [
        'evt-uuid-001', 'Autumn Fun Run', localDate,
        '2026-11-01_Autumn_Fun_Run', 'drive-folder-id-001',
        'admin@mmrunners.org', '2026-09-01T09:00:00.000Z',
      ];
      const first = toEventRecord(row)!;
      expect(first.eventDate).toBe('2026-11-01');
      const restored = toEventRecord(fromEventRecord(first))!;
      expect(restored.eventDate).toBe('2026-11-01');
    });
  });

  describe('fromEventRecord()', () => {
    it('produces an array of 7 elements', () => {
      const record = toEventRecord(validRow)!;
      const row = fromEventRecord(record);
      expect(row).toHaveLength(7);
    });

    it('preserves all field values in correct column order', () => {
      const record = toEventRecord(validRow)!;
      const row = fromEventRecord(record);
      expect(row[0]).toBe('evt-uuid-001');     // eventId
      expect(row[1]).toBe('NYC Marathon');     // eventName
      expect(row[2]).toBe('2025-11-03');       // eventDate
      expect(row[3]).toBe('2025-11-03_NYC_Marathon'); // folderName
      expect(row[4]).toBe('drive-folder-id-001');     // driveFolderId
      expect(row[5]).toBe('admin@mmrunners.org');      // createdBy
      expect(row[6]).toBe('2025-10-01T09:00:00.000Z'); // createdAt
    });
  });

  describe('roundtrip: toEventRecord → fromEventRecord → toEventRecord', () => {
    it('produces an identical record after roundtrip', () => {
      const original = toEventRecord(validRow)!;
      const row = fromEventRecord(original);
      const restored = toEventRecord(row);
      expect(restored).toEqual(original);
    });

    it('roundtrip preserves all fields for a manually constructed record', () => {
      const original = {
        eventId: 'evt-uuid-002',
        eventName: 'Boston Marathon',
        eventDate: '2025-04-21',
        folderName: '2025-04-21_Boston_Marathon',
        driveFolderId: 'drive-id-002',
        createdBy: 'admin@mmrunners.org',
        createdAt: '2025-03-01T09:00:00Z',
      };
      const row = fromEventRecord(original);
      const restored = toEventRecord(row);
      expect(restored).toEqual(original);
    });

    it('roundtrip handles event name with multiple spaces converted to underscores', () => {
      const original = {
        eventId: 'evt-uuid-003',
        eventName: 'Christmas Fun Run',
        eventDate: '2025-12-25',
        folderName: '2025-12-25_Christmas_Fun_Run',
        driveFolderId: 'drive-id-003',
        createdBy: 'admin@mmrunners.org',
        createdAt: '2025-12-01T14:00:00Z',
      };
      const row = fromEventRecord(original);
      const restored = toEventRecord(row);
      expect(restored).toEqual(original);
    });
  });
});

// ─── Upload Log ───────────────────────────────────────────────────────────────

describe('sheetMapper — Upload Log', () => {
  const validRow: unknown[] = [
    'log-uuid-001', 'evt-uuid-001', 'New_Bee',
    'user1@example.com', '20251103-093500_user1', 'batch-folder-id-001',
    42, 1.25, 3, 1, '2025-11-03T09:35:00.000Z', 'web_app',
  ];

  describe('toUploadLogRecord()', () => {
    it('maps a complete valid row', () => {
      const record = toUploadLogRecord(validRow);
      expect(record).not.toBeNull();
      expect(record!.fileCount).toBe(42);
      expect(record!.totalSizeMb).toBe(1.25);
      expect(record!.skippedDuplicates).toBe(3);
      expect(record!.source).toBe(UploadSource.WEB_APP);
    });

    it('accepts link source', () => {
      const row = [...validRow];
      row[11] = 'link';
      const record = toUploadLogRecord(row);
      expect(record!.source).toBe(UploadSource.LINK);
    });

    it('returns null for unrecognized source', () => {
      const row = [...validRow];
      row[11] = 'browser';
      expect(toUploadLogRecord(row)).toBeNull();
    });

    it('returns null when numeric fields are NaN', () => {
      const row = [...validRow];
      row[6] = 'not-a-number';
      expect(toUploadLogRecord(row)).toBeNull();
    });

    it('accepts zero values for counts', () => {
      const row = [...validRow];
      row[6] = 0;
      row[7] = 0;
      row[8] = 0;
      row[9] = 0;
      const record = toUploadLogRecord(row);
      expect(record).not.toBeNull();
      expect(record!.fileCount).toBe(0);
    });

    it('normalizes uploadedBy to lowercase', () => {
      const row = [...validRow];
      row[3] = 'User1@Example.COM';
      const record = toUploadLogRecord(row);
      expect(record!.uploadedBy).toBe('user1@example.com');
    });

    it('defaults durationMs to 0 on legacy rows without the column', () => {
      // Legacy rows (pre-duration-tracking) have only 12 columns.
      const record = toUploadLogRecord(validRow);
      expect(record!.durationMs).toBe(0);
    });

    it('reads durationMs from the new column when present', () => {
      const row: unknown[] = [
        ...validRow,
        'link-uuid-1',  // linkId (col 12)
        87654,          // durationMs (col 13)
      ];
      const record = toUploadLogRecord(row);
      expect(record!.durationMs).toBe(87654);
      expect(record!.linkId).toBe('link-uuid-1');
    });

    it('clamps negative durationMs to 0', () => {
      const row: unknown[] = [...validRow, '', -100];
      expect(toUploadLogRecord(row)!.durationMs).toBe(0);
    });
  });

  describe('roundtrip: toUploadLogRecord → fromUploadLogRecord → toUploadLogRecord', () => {
    it('produces an identical record', () => {
      const original = toUploadLogRecord(validRow)!;
      const restored = toUploadLogRecord(fromUploadLogRecord(original));
      expect(restored).toEqual(original);
    });

    it('preserves durationMs across the roundtrip', () => {
      const row: unknown[] = [...validRow, 'link-xyz', 12345];
      const original = toUploadLogRecord(row)!;
      const restored = toUploadLogRecord(fromUploadLogRecord(original));
      expect(restored!.durationMs).toBe(12345);
      expect(restored).toEqual(original);
    });
  });
});

// ─── Clubs ────────────────────────────────────────────────────────────────────

describe('sheetMapper — Clubs', () => {
  // 5-column schema: displayName(0) normalizedName(1) status(2)
  //   addedDate(3) addedBy(4)
  const validRow: unknown[] = [
    '新蜂', 'New_Bee', 'active', '2025-01-01', 'system',
  ];

  describe('toClubRecord()', () => {
    it('maps a complete valid active row', () => {
      const record = toClubRecord(validRow);
      expect(record).not.toBeNull();
      expect(record!.displayName).toBe('新蜂');
      expect(record!.normalizedName).toBe('New_Bee');
      expect(record!.status).toBe('active');
      expect(record!.addedDate).toBe('2025-01-01');
      expect(record!.addedBy).toBe('system');
    });

    it('maps an inactive club correctly', () => {
      const row = ['驰跑团', 'CHI', 'inactive', '2025-06-01', 'admin@mmrunners.org'];
      const record = toClubRecord(row);
      expect(record).not.toBeNull();
      expect(record!.status).toBe('inactive');
      expect(record!.normalizedName).toBe('CHI');
    });

    it('normalizes addedBy to lowercase', () => {
      const row = ['Club', 'Club_Name', 'active', '2025-01-01', 'ADMIN@MMRUNNERS.ORG'];
      const record = toClubRecord(row);
      expect(record!.addedBy).toBe('admin@mmrunners.org');
    });

    it('trims whitespace from all fields', () => {
      const row = ['  新蜂  ', '  New_Bee  ', 'active', '2025-01-01', 'system'];
      const record = toClubRecord(row);
      expect(record!.displayName).toBe('新蜂');
      expect(record!.normalizedName).toBe('New_Bee');
    });

    it('returns null when displayName is empty', () => {
      const row = ['', 'New_Bee', 'active', '2025-01-01', 'system'];
      expect(toClubRecord(row)).toBeNull();
    });

    it('returns null when normalizedName is empty', () => {
      const row = ['新蜂', '', 'active', '2025-01-01', 'system'];
      expect(toClubRecord(row)).toBeNull();
    });

    it('returns null for invalid status', () => {
      const row = ['新蜂', 'New_Bee', 'pending', '2025-01-01', 'system'];
      expect(toClubRecord(row)).toBeNull();
    });

    it('returns null for row with fewer than 5 columns', () => {
      expect(toClubRecord(['Club', 'Club_Name'])).toBeNull();
      expect(toClubRecord([])).toBeNull();
    });

    it('accepts both "active" and "inactive" as valid statuses', () => {
      const active   = toClubRecord(['A', 'A_Club', 'active',   '2025-01-01', 'sys']);
      const inactive = toClubRecord(['A', 'A_Club', 'inactive', '2025-01-01', 'sys']);
      expect(active!.status).toBe('active');
      expect(inactive!.status).toBe('inactive');
    });

    it('handles numeric cell values via String() coercion', () => {
      const row: unknown[] = [123, 456, 'active', '2025-01-01', 'system'];
      const record = toClubRecord(row);
      expect(record!.displayName).toBe('123');
      expect(record!.normalizedName).toBe('456');
    });

    it('handles Sheets returning Date objects for addedDate', () => {
      // Same formatSheetDate() fix applies to Club rows — regression guard.
      const localDate = new Date(2025, 0, 1); // Jan 1 2025 local time
      const row: unknown[] = ['新蜂', 'New_Bee', 'active', localDate, 'system'];
      const record = toClubRecord(row);
      expect(record).not.toBeNull();
      expect(record!.addedDate).toBe('2025-01-01');
      expect(record!.addedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('does not store the full Date.toString() locale string for addedDate', () => {
      const localDate = new Date(2025, 5, 15); // Jun 15 2025 local time
      const row: unknown[] = ['岚山', 'Lanshan', 'active', localDate, 'admin@mmrunners.org'];
      const record = toClubRecord(row);
      expect(record!.addedDate).not.toContain('GMT');
      expect(record!.addedDate).not.toContain(':');
      expect(record!.addedDate).toBe('2025-06-15');
    });
  });

  describe('fromClubRecord()', () => {
    it('produces an array of 5 elements', () => {
      const record = toClubRecord(validRow)!;
      const row = fromClubRecord(record);
      expect(row).toHaveLength(5);
    });

    it('preserves all field values in correct column order', () => {
      const record = toClubRecord(validRow)!;
      const row = fromClubRecord(record);
      expect(row[0]).toBe('新蜂');       // displayName
      expect(row[1]).toBe('New_Bee');   // normalizedName
      expect(row[2]).toBe('active');    // status
      expect(row[3]).toBe('2025-01-01'); // addedDate
      expect(row[4]).toBe('system');    // addedBy
    });
  });

  describe('roundtrip: toClubRecord → fromClubRecord → toClubRecord', () => {
    it('produces an identical record', () => {
      const original = toClubRecord(validRow)!;
      const restored = toClubRecord(fromClubRecord(original));
      expect(restored).toEqual(original);
    });

    it('roundtrip preserves inactive status', () => {
      const row: unknown[] = ['驰跑团', 'CHI', 'inactive', '2025-06-01', 'admin@mmrunners.org'];
      const original = toClubRecord(row)!;
      const restored = toClubRecord(fromClubRecord(original));
      expect(restored).toEqual(original);
      expect(restored!.status).toBe('inactive');
    });
  });
});

// ─── Audit Log ────────────────────────────────────────────────────────────────

describe('sheetMapper — Audit Log', () => {
  const validRow: unknown[] = [
    'audit-uuid-001',
    '2026-04-18T10:00:00.000Z',
    'admin@mmrunners.org',
    'USER_CREATED',
    'user',
    'newuser@example.com',
    '{"email":"newuser@example.com","role":"user"}',
    '',            // linkId
    '',            // ipAddress
    '',            // reason
  ];

  describe('toAuditLogRecord()', () => {
    it('maps a complete valid row', () => {
      const record = toAuditLogRecord(validRow);
      expect(record).not.toBeNull();
      expect(record!.auditId).toBe('audit-uuid-001');
      expect(record!.timestamp).toBe('2026-04-18T10:00:00.000Z');
      expect(record!.actorEmail).toBe('admin@mmrunners.org');
      expect(record!.action).toBe(AuditAction.USER_CREATED);
      expect(record!.resourceType).toBe('user');
      expect(record!.resourceId).toBe('newuser@example.com');
      expect(record!.details).toBe('{"email":"newuser@example.com","role":"user"}');
    });

    it('normalises actorEmail to lowercase', () => {
      const row = [...validRow];
      row[2] = 'Admin@MMRUNNERS.ORG';
      const record = toAuditLogRecord(row);
      expect(record!.actorEmail).toBe('admin@mmrunners.org');
    });

    it('trims whitespace from all string fields', () => {
      const row: unknown[] = [
        '  audit-uuid-001  ', '  2026-04-18T10:00:00.000Z  ',
        '  admin@mmrunners.org  ', '  USER_CREATED  ',
        '  user  ', '  newuser@example.com  ', '  {}  ',
      ];
      const record = toAuditLogRecord(row);
      expect(record!.auditId).toBe('audit-uuid-001');
      expect(record!.actorEmail).toBe('admin@mmrunners.org');
      expect(record!.action).toBe(AuditAction.USER_CREATED);
    });

    it('returns null when auditId is empty', () => {
      const row = [...validRow];
      row[0] = '';
      expect(toAuditLogRecord(row)).toBeNull();
    });

    it('returns null when auditId is whitespace-only', () => {
      const row = [...validRow];
      row[0] = '   ';
      expect(toAuditLogRecord(row)).toBeNull();
    });

    it('returns null when actorEmail is empty', () => {
      const row = [...validRow];
      row[2] = '';
      expect(toAuditLogRecord(row)).toBeNull();
    });

    it('returns null for an unrecognized action value', () => {
      const row = [...validRow];
      row[3] = 'TOTALLY_FAKE_ACTION';
      expect(toAuditLogRecord(row)).toBeNull();
    });

    it('returns null for row with fewer than 7 columns', () => {
      expect(toAuditLogRecord(['id', 'ts', 'actor', 'USER_CREATED', 'user'])).toBeNull();
      expect(toAuditLogRecord([])).toBeNull();
    });

    it('accepts all valid AuditAction values', () => {
      for (const action of Object.values(AuditAction)) {
        const row = [...validRow];
        row[3] = action;
        const record = toAuditLogRecord(row);
        expect(record).not.toBeNull();
        expect(record!.action).toBe(action);
      }
    });

    it('accepts an empty resourceId (used by report actions)', () => {
      const row = [...validRow];
      row[5] = '';
      const record = toAuditLogRecord(row);
      expect(record).not.toBeNull();
      expect(record!.resourceId).toBe('');
    });

    it('accepts ALBUM_ERROR as a valid AuditAction', () => {
      // Regression guard for the ALBUM_ERROR action added alongside the
      // persistent error logging for Google Photos failures. The action must
      // round-trip through toAuditLogRecord without returning null.
      const row = [...validRow];
      row[3] = 'ALBUM_ERROR';
      const record = toAuditLogRecord(row);
      expect(record).not.toBeNull();
      expect(record!.action).toBe(AuditAction.ALBUM_ERROR);
    });

    it('handles numeric cell values via String() coercion', () => {
      const row: unknown[] = [
        123, '2026-04-18T10:00:00.000Z', 'admin@mmrunners.org',
        'CLUB_CREATED', 'club', 456, '{}',
      ];
      const record = toAuditLogRecord(row);
      expect(record!.auditId).toBe('123');
      expect(record!.resourceId).toBe('456');
    });
  });

  describe('fromAuditLogRecord()', () => {
    it('produces an array of 10 elements', () => {
      const record = toAuditLogRecord(validRow)!;
      const row = fromAuditLogRecord(record);
      expect(row).toHaveLength(10);
    });

    it('preserves all field values in the correct column order', () => {
      const record = toAuditLogRecord(validRow)!;
      const row = fromAuditLogRecord(record);
      expect(row[0]).toBe('audit-uuid-001');               // auditId
      expect(row[1]).toBe('2026-04-18T10:00:00.000Z');    // timestamp
      expect(row[2]).toBe('admin@mmrunners.org');          // actorEmail
      expect(row[3]).toBe('USER_CREATED');                 // action
      expect(row[4]).toBe('user');                         // resourceType
      expect(row[5]).toBe('newuser@example.com');          // resourceId
      expect(row[6]).toBe('{"email":"newuser@example.com","role":"user"}'); // details
      expect(row[7]).toBe('');                             // linkId
      expect(row[8]).toBe('');                             // ipAddress
      expect(row[9]).toBe('');                             // reason
    });
  });

  describe('roundtrip: toAuditLogRecord → fromAuditLogRecord → toAuditLogRecord', () => {
    it('produces an identical record after roundtrip', () => {
      const original = toAuditLogRecord(validRow)!;
      const row = fromAuditLogRecord(original);
      const restored = toAuditLogRecord(row);
      expect(restored).toEqual(original);
    });

    it('roundtrip preserves all AuditAction values', () => {
      for (const action of Object.values(AuditAction)) {
        const original = toAuditLogRecord([...validRow.slice(0, 3), action, ...validRow.slice(4)])!;
        const restored = toAuditLogRecord(fromAuditLogRecord(original));
        expect(restored).toEqual(original);
      }
    });

    it('roundtrip preserves empty resourceId', () => {
      const row = [...validRow];
      row[5] = '';
      const original = toAuditLogRecord(row)!;
      const restored = toAuditLogRecord(fromAuditLogRecord(original));
      expect(restored!.resourceId).toBe('');
    });
  });
});

// ─── Photos Files ──────────────────────────────────────────────────────────────

describe('sheetMapper — Photos Files', () => {
  // Column order: driveFileId(0), mediaItemId(1), albumId(2), albumType(3),
  //               eventId(4), clubName(5), fileName(6), syncedAt(7)
  const validEventRow: unknown[] = [
    'drive-file-id-001',
    'media-item-id-001',
    'album-id-event-001',
    'event',
    'evt-uuid-001',
    '',
    'IMG_0042.jpg',
    '2026-04-19T10:00:00.000Z',
  ];

  const validClubRow: unknown[] = [
    'drive-file-id-002',
    'media-item-id-002',
    'album-id-club-001',
    'club',
    'evt-uuid-001',
    'New_Bee',
    'IMG_0043.heic',
    '2026-04-19T10:01:00.000Z',
  ];

  describe('toPhotosFileRecord()', () => {
    it('maps a complete valid event-type row', () => {
      const record = toPhotosFileRecord(validEventRow);
      expect(record).not.toBeNull();
      expect(record!.driveFileId).toBe('drive-file-id-001');
      expect(record!.mediaItemId).toBe('media-item-id-001');
      expect(record!.albumId).toBe('album-id-event-001');
      expect(record!.albumType).toBe('event');
      expect(record!.eventId).toBe('evt-uuid-001');
      expect(record!.clubName).toBe('');
      expect(record!.fileName).toBe('IMG_0042.jpg');
      expect(record!.syncedAt).toBe('2026-04-19T10:00:00.000Z');
    });

    it('maps a complete valid club-type row', () => {
      const record = toPhotosFileRecord(validClubRow);
      expect(record).not.toBeNull();
      expect(record!.albumType).toBe('club');
      expect(record!.clubName).toBe('New_Bee');
      expect(record!.fileName).toBe('IMG_0043.heic');
    });

    it('returns null when driveFileId is empty', () => {
      const row = [...validEventRow];
      row[0] = '';
      expect(toPhotosFileRecord(row)).toBeNull();
    });

    it('returns null when driveFileId is whitespace-only', () => {
      const row = [...validEventRow];
      row[0] = '   ';
      expect(toPhotosFileRecord(row)).toBeNull();
    });

    it('returns null when albumId is empty', () => {
      const row = [...validEventRow];
      row[2] = '';
      expect(toPhotosFileRecord(row)).toBeNull();
    });

    it('returns null when albumId is whitespace-only', () => {
      const row = [...validEventRow];
      row[2] = '   ';
      expect(toPhotosFileRecord(row)).toBeNull();
    });

    it('returns null for unrecognized albumType', () => {
      const row = [...validEventRow];
      row[3] = 'album';
      expect(toPhotosFileRecord(row)).toBeNull();
    });

    it('returns null for empty albumType', () => {
      const row = [...validEventRow];
      row[3] = '';
      expect(toPhotosFileRecord(row)).toBeNull();
    });

    it('accepts both "event" and "club" as valid albumType values', () => {
      const evRecord = toPhotosFileRecord(validEventRow);
      const clRecord = toPhotosFileRecord(validClubRow);
      expect(evRecord!.albumType).toBe('event');
      expect(clRecord!.albumType).toBe('club');
    });

    it('returns null for row with fewer than 8 columns', () => {
      expect(toPhotosFileRecord(['drive-id', 'media-id', 'album-id', 'event', 'evt-id', ''])).toBeNull();
      expect(toPhotosFileRecord([])).toBeNull();
    });

    it('trims whitespace from all string fields', () => {
      const row: unknown[] = [
        '  drive-file-id-001  ', '  media-item-id-001  ', '  album-id-event-001  ',
        '  event  ', '  evt-uuid-001  ', '  ', '  IMG_0042.jpg  ', '  2026-04-19T10:00:00.000Z  ',
      ];
      const record = toPhotosFileRecord(row);
      expect(record!.driveFileId).toBe('drive-file-id-001');
      expect(record!.mediaItemId).toBe('media-item-id-001');
      expect(record!.albumId).toBe('album-id-event-001');
      expect(record!.albumType).toBe('event');
      expect(record!.eventId).toBe('evt-uuid-001');
      expect(record!.clubName).toBe('');  // whitespace-only normalises to ''
      expect(record!.fileName).toBe('IMG_0042.jpg');
    });

    it('handles Sheets returning numeric values via String() coercion', () => {
      const row: unknown[] = [
        123, 456, 789, 'event', 'evt-id', '', 'photo.jpg', '2026-04-19T10:00:00.000Z',
      ];
      const record = toPhotosFileRecord(row);
      expect(record!.driveFileId).toBe('123');
      expect(record!.mediaItemId).toBe('456');
      expect(record!.albumId).toBe('789');
    });

    it('handles Sheets returning Date objects in syncedAt via String() coercion', () => {
      const row: unknown[] = [
        'drive-id', 'media-id', 'album-id', 'event',
        'evt-id', '', 'photo.jpg', new Date('2026-04-19T10:00:00.000Z'),
      ];
      const record = toPhotosFileRecord(row);
      expect(record).not.toBeNull();
      expect(typeof record!.syncedAt).toBe('string');
    });

    it('accepts empty clubName for event-type albums', () => {
      const record = toPhotosFileRecord(validEventRow);
      expect(record!.clubName).toBe('');
    });

    it('preserves non-empty clubName for club-type albums', () => {
      const record = toPhotosFileRecord(validClubRow);
      expect(record!.clubName).toBe('New_Bee');
    });
  });

  describe('fromPhotosFileRecord()', () => {
    it('produces an array of 8 elements', () => {
      const record = toPhotosFileRecord(validEventRow)!;
      const row = fromPhotosFileRecord(record);
      expect(row).toHaveLength(8);
    });

    it('preserves all field values in correct column order', () => {
      const record = toPhotosFileRecord(validEventRow)!;
      const row = fromPhotosFileRecord(record);
      expect(row[0]).toBe('drive-file-id-001');           // driveFileId  (col A)
      expect(row[1]).toBe('media-item-id-001');           // mediaItemId  (col B)
      expect(row[2]).toBe('album-id-event-001');          // albumId      (col C)
      expect(row[3]).toBe('event');                       // albumType    (col D)
      expect(row[4]).toBe('evt-uuid-001');                // eventId      (col E)
      expect(row[5]).toBe('');                            // clubName     (col F)
      expect(row[6]).toBe('IMG_0042.jpg');                // fileName     (col G)
      expect(row[7]).toBe('2026-04-19T10:00:00.000Z');   // syncedAt     (col H)
    });

    it('preserves club-type record fields correctly', () => {
      const record = toPhotosFileRecord(validClubRow)!;
      const row = fromPhotosFileRecord(record);
      expect(row[3]).toBe('club');
      expect(row[5]).toBe('New_Bee');
    });
  });

  describe('roundtrip: toPhotosFileRecord → fromPhotosFileRecord → toPhotosFileRecord', () => {
    it('produces an identical event-type record after roundtrip', () => {
      const original = toPhotosFileRecord(validEventRow)!;
      const row = fromPhotosFileRecord(original);
      const restored = toPhotosFileRecord(row);
      expect(restored).toEqual(original);
    });

    it('produces an identical club-type record after roundtrip', () => {
      const original = toPhotosFileRecord(validClubRow)!;
      const row = fromPhotosFileRecord(original);
      const restored = toPhotosFileRecord(row);
      expect(restored).toEqual(original);
    });

    it('roundtrip preserves empty clubName for event albums', () => {
      const original = toPhotosFileRecord(validEventRow)!;
      const restored = toPhotosFileRecord(fromPhotosFileRecord(original));
      expect(restored!.clubName).toBe('');
    });

    it('roundtrip preserves non-ASCII fileName', () => {
      const row = [...validEventRow];
      row[6] = '跑步照片_001.jpg';
      const original = toPhotosFileRecord(row)!;
      const restored = toPhotosFileRecord(fromPhotosFileRecord(original));
      expect(restored!.fileName).toBe('跑步照片_001.jpg');
    });
  });
});

// ─── Email Preferences ────────────────────────────────────────────────────────

describe('sheetMapper — Email Preferences', () => {
  // 9-column row: email, UC, URC, UD, SE, EC(new), DR, WR, updatedAt
  const validRow: unknown[] = [
    'admin@mmrunners.org', true, false, true, false, true, true, false, '2026-04-01T10:00:00Z',
  ];

  describe('toOptInBoolean (indirectly via toEmailPreferenceRecord)', () => {
    it('coerces boolean true', () => {
      const row = ['test@example.com', true, true, true, true, true, true, ''];
      const record = toEmailPreferenceRecord(row);
      expect(record).not.toBeNull();
      expect(record!.userCreated).toBe(true);
    });

    it('coerces boolean false', () => {
      const row = ['test@example.com', false, false, false, false, false, false, ''];
      const record = toEmailPreferenceRecord(row);
      expect(record).not.toBeNull();
      expect(record!.userCreated).toBe(false);
    });

    it('coerces string "TRUE" / "true"', () => {
      const row1 = ['test@example.com', 'TRUE', 'true', '', '', '', '', ''];
      const row2 = ['test@example.com', 'TRUE', 'true', '', '', '', '', ''];
      const rec1 = toEmailPreferenceRecord(row1);
      const rec2 = toEmailPreferenceRecord(row2);
      expect(rec1!.userCreated).toBe(true);
      expect(rec2!.userRoleChanged).toBe(true);
    });

    it('coerces string "FALSE" / "false"', () => {
      const row = ['test@example.com', 'FALSE', 'false', 'FALSE', 'false', '', '', ''];
      const record = toEmailPreferenceRecord(row);
      expect(record!.userCreated).toBe(false);
      expect(record!.userRoleChanged).toBe(false);
      expect(record!.userDeactivated).toBe(false);
      expect(record!.securityEvent).toBe(false);
    });

    it('coerces string "yes" / "no"', () => {
      const row = ['test@example.com', 'yes', 'no', 'YES', 'NO', '', '', ''];
      const record = toEmailPreferenceRecord(row);
      expect(record!.userCreated).toBe(true);
      expect(record!.userRoleChanged).toBe(false);
      expect(record!.userDeactivated).toBe(true);
      expect(record!.securityEvent).toBe(false);
    });

    it('coerces numeric "1" to true and "0" to false', () => {
      // 9-col row: email, UC, URC, UD, SE, EC, DR, WR, updatedAt
      const row = ['test@example.com', 1, 0, '1', '0', false, 1, 0, ''];
      const record = toEmailPreferenceRecord(row);
      expect(record!.userCreated).toBe(true);
      expect(record!.userRoleChanged).toBe(false);
      expect(record!.userDeactivated).toBe(true);
      expect(record!.securityEvent).toBe(false);
      expect(record!.dailyReport).toBe(true);
      expect(record!.weeklyReport).toBe(false);
    });

    it('coerces empty string / undefined to false', () => {
      const row = ['test@example.com', '', undefined, null, '   ', '', '', ''];
      const record = toEmailPreferenceRecord(row);
      expect(record!.userCreated).toBe(false);
      expect(record!.userRoleChanged).toBe(false);
      expect(record!.userDeactivated).toBe(false);
      expect(record!.securityEvent).toBe(false);
    });

    it('unknown strings default to false', () => {
      const row = ['test@example.com', 'unknown', 'maybe', 'nope', 'no', '', '', ''];
      const record = toEmailPreferenceRecord(row);
      // only 'yes', 'y', 'true', '1' map to true; everything else → false
      expect(record!.userCreated).toBe(false);
      expect(record!.userRoleChanged).toBe(false);
      expect(record!.userDeactivated).toBe(false);
      expect(record!.securityEvent).toBe(false);
    });
  });

  describe('toEmailPreferenceRecord()', () => {
    it('maps a complete valid 9-column row', () => {
      const record = toEmailPreferenceRecord(validRow);
      expect(record).not.toBeNull();
      expect(record!.email).toBe('admin@mmrunners.org');
      expect(record!.userCreated).toBe(true);
      expect(record!.userRoleChanged).toBe(false);
      expect(record!.userDeactivated).toBe(true);
      expect(record!.securityEvent).toBe(false);
      expect(record!.eventCreated).toBe(true);
      expect(record!.dailyReport).toBe(true);
      expect(record!.weeklyReport).toBe(false);
      expect(record!.updatedAt).toBe('2026-04-01T10:00:00Z');
    });

    it('normalizes email to lowercase', () => {
      const row = ['Admin@MMRUNNERS.ORG', true, true, true, true, true, true, ''];
      const record = toEmailPreferenceRecord(row);
      expect(record!.email).toBe('admin@mmrunners.org');
    });

    it('trims whitespace from email', () => {
      const row = ['  admin@mmrunners.org  ', true, true, true, true, true, true, ''];
      const record = toEmailPreferenceRecord(row);
      expect(record!.email).toBe('admin@mmrunners.org');
    });

    it('returns null when email is empty', () => {
      const row = ['', true, true, true, true, true, true, ''];
      expect(toEmailPreferenceRecord(row)).toBeNull();
    });

    it('returns null when email is whitespace-only', () => {
      const row = ['   ', true, true, true, true, true, true, ''];
      expect(toEmailPreferenceRecord(row)).toBeNull();
    });

    it('returns null for row with fewer than 5 columns', () => {
      expect(toEmailPreferenceRecord(['admin@x.com', true, true, true])).toBeNull();
      expect(toEmailPreferenceRecord([])).toBeNull();
    });

    it('accepts rows with more than 8 columns (parses first 8)', () => {
      const row = ['admin@mmrunners.org', true, false, true, false, true, true, '2026-04-01T10:00:00Z', 'extra', 'columns'];
      const record = toEmailPreferenceRecord(row);
      expect(record).not.toBeNull();
      expect(record!.email).toBe('admin@mmrunners.org');
      expect(record!.userCreated).toBe(true);
    });

    it('handles numeric cell values via String() coercion for email', () => {
      const row = [123, true, true, true, true, true, true, ''];
      const record = toEmailPreferenceRecord(row);
      expect(record!.email).toBe('123');
    });

    it('treats undefined/null cells in a full-length row as false for booleans', () => {
      // Row has 8 columns but booleans are undefined/null
      const row = ['admin@mmrunners.org', undefined, null, undefined, null, undefined, null, ''];
      const record = toEmailPreferenceRecord(row);
      expect(record).not.toBeNull();
      expect(record!.userCreated).toBe(false);
      expect(record!.userRoleChanged).toBe(false);
    });
  });

  describe('fromEmailPreferenceRecord()', () => {
    it('produces an array of 9 elements', () => {
      const record = toEmailPreferenceRecord(validRow)!;
      const row = fromEmailPreferenceRecord(record);
      expect(row).toHaveLength(9);
    });

    it('preserves all field values in correct column order', () => {
      const record = toEmailPreferenceRecord(validRow)!;
      const row = fromEmailPreferenceRecord(record);
      expect(row[0]).toBe('admin@mmrunners.org');      // email
      expect(row[1]).toBe(true);                       // userCreated
      expect(row[2]).toBe(false);                      // userRoleChanged
      expect(row[3]).toBe(true);                       // userDeactivated
      expect(row[4]).toBe(false);                      // securityEvent
      expect(row[5]).toBe(true);                       // eventCreated
      expect(row[6]).toBe(true);                       // dailyReport
      expect(row[7]).toBe(false);                      // weeklyReport
      expect(row[8]).toBe('2026-04-01T10:00:00Z');     // updatedAt
    });

    it('serialises booleans as native booleans (not strings)', () => {
      const record = toEmailPreferenceRecord(validRow)!;
      const row = fromEmailPreferenceRecord(record);
      expect(row[1]).toBe(true);   // boolean, not "TRUE"
      expect(row[2]).toBe(false);  // boolean, not "FALSE"
      expect(typeof row[1]).toBe('boolean');
      expect(typeof row[2]).toBe('boolean');
    });

    it('preserves timestamp exactly', () => {
      const record = toEmailPreferenceRecord(validRow)!;
      const row = fromEmailPreferenceRecord(record);
      expect(row[8]).toBe('2026-04-01T10:00:00Z');
    });
  });

  describe('roundtrip: toEmailPreferenceRecord → fromEmailPreferenceRecord → toEmailPreferenceRecord', () => {
    it('produces an identical record after roundtrip', () => {
      const original = toEmailPreferenceRecord(validRow)!;
      const row = fromEmailPreferenceRecord(original);
      const restored = toEmailPreferenceRecord(row);
      expect(restored).toEqual(original);
    });

    it('roundtrip preserves all boolean combinations', () => {
      const allTrueRow = ['admin@x.com', true, true, true, true, true, true, '2026-04-01T10:00:00Z'];
      const allFalseRow = ['admin@y.com', false, false, false, false, false, false, '2026-04-02T11:00:00Z'];
      const mixedRow = ['admin@z.com', true, false, true, false, true, false, '2026-04-03T12:00:00Z'];

      for (const row of [allTrueRow, allFalseRow, mixedRow]) {
        const original = toEmailPreferenceRecord(row)!;
        const restored = toEmailPreferenceRecord(fromEmailPreferenceRecord(original));
        expect(restored).toEqual(original);
      }
    });

    it('roundtrip with various email formats', () => {
      const rows = [
        ['test@example.com', true, true, true, true, true, true, ''],
        ['user+tag@domain.co.uk', false, false, false, false, false, false, '2026-01-01T00:00:00Z'],
        ['admin@mmrunners.org', true, true, true, true, true, true, '2026-04-21T12:34:56Z'],
      ];
      for (const row of rows) {
        const original = toEmailPreferenceRecord(row)!;
        const restored = toEmailPreferenceRecord(fromEmailPreferenceRecord(original));
        expect(restored).toEqual(original);
      }
    });
  });
});
