import {
  toUserRecord,
  fromUserRecord,
  toEventRecord,
  fromEventRecord,
  toUploadLogRecord,
  fromUploadLogRecord,
} from '../../src/utils/sheetMapper';
import { UserRole, UserStatus, UploadSource } from '../../src/types/enums';
import { UserRecord } from '../../src/types/models';

// ─── Users ────────────────────────────────────────────────────────────────────

describe('sheetMapper — Users', () => {
  const validRow: unknown[] = [
    'admin@mmrunners.org', 'Admin', 'admin', 'active', '2025-01-01', 'system',
  ];

  describe('toUserRecord()', () => {
    it('maps a complete valid row', () => {
      const record = toUserRecord(validRow);
      expect(record).not.toBeNull();
      expect(record!.email).toBe('admin@mmrunners.org');
      expect(record!.runningClub).toBe('Admin');
      expect(record!.role).toBe(UserRole.ADMIN);
      expect(record!.status).toBe(UserStatus.ACTIVE);
      expect(record!.addedDate).toBe('2025-01-01');
      expect(record!.addedBy).toBe('system');
    });

    it('normalizes email to lowercase', () => {
      const row = ['Admin@EXAMPLE.COM', 'New_Bee', 'user', 'active', '', ''];
      const record = toUserRecord(row);
      expect(record!.email).toBe('admin@example.com');
    });

    it('trims whitespace from all string fields', () => {
      const row = ['  alice@example.com  ', '  New_Bee  ', 'user', 'active', '', ''];
      const record = toUserRecord(row);
      expect(record!.email).toBe('alice@example.com');
      expect(record!.runningClub).toBe('New_Bee');
    });

    it('returns null for empty email', () => {
      const row = ['', 'New_Bee', 'user', 'active', '', ''];
      expect(toUserRecord(row)).toBeNull();
    });

    it('returns null for whitespace-only email', () => {
      const row = ['   ', 'New_Bee', 'user', 'active', '', ''];
      expect(toUserRecord(row)).toBeNull();
    });

    it('returns null for invalid role', () => {
      const row = ['alice@example.com', 'New_Bee', 'superadmin', 'active', '', ''];
      expect(toUserRecord(row)).toBeNull();
    });

    it('returns null for invalid status', () => {
      const row = ['alice@example.com', 'New_Bee', 'user', 'pending', '', ''];
      expect(toUserRecord(row)).toBeNull();
    });

    it('returns null for row with fewer than 6 columns', () => {
      expect(toUserRecord(['a', 'b', 'c'])).toBeNull();
      expect(toUserRecord([])).toBeNull();
    });

    it('handles Sheets returning Date objects for date columns', () => {
      // Sheets sometimes returns Date objects for cells formatted as dates
      const row: unknown[] = [
        'alice@example.com', 'New_Bee', 'user', 'active',
        new Date('2025-02-01'), 'admin@mmrunners.org',
      ];
      const record = toUserRecord(row);
      expect(record).not.toBeNull();
      // Date.toString() is stored as string — just verify no crash
      expect(typeof record!.addedDate).toBe('string');
    });

    it('accepts all valid UserRole values', () => {
      for (const role of Object.values(UserRole)) {
        const row = ['alice@example.com', 'Club', role, 'active', '', ''];
        expect(toUserRecord(row)).not.toBeNull();
      }
    });

    it('accepts all valid UserStatus values', () => {
      for (const status of Object.values(UserStatus)) {
        const row = ['alice@example.com', 'Club', 'user', status, '', ''];
        expect(toUserRecord(row)).not.toBeNull();
      }
    });
  });

  describe('fromUserRecord()', () => {
    it('produces an array of 6 elements', () => {
      const record = toUserRecord(validRow)!;
      const row = fromUserRecord(record);
      expect(row).toHaveLength(6);
    });

    it('preserves all field values', () => {
      const record = toUserRecord(validRow)!;
      const row = fromUserRecord(record);
      expect(row[0]).toBe('admin@mmrunners.org');
      expect(row[2]).toBe('admin');
      expect(row[3]).toBe('active');
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
        email: 'test@example.com',
        runningClub: 'New_Bee',
        role: UserRole.API_CLIENT,
        status: UserStatus.INACTIVE,
        addedDate: '2025-03-01',
        addedBy: 'admin@mmrunners.org',
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

    it('accepts api source', () => {
      const row = [...validRow];
      row[11] = 'api';
      const record = toUploadLogRecord(row);
      expect(record!.source).toBe(UploadSource.API);
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
  });

  describe('roundtrip: toUploadLogRecord → fromUploadLogRecord → toUploadLogRecord', () => {
    it('produces an identical record', () => {
      const original = toUploadLogRecord(validRow)!;
      const restored = toUploadLogRecord(fromUploadLogRecord(original));
      expect(restored).toEqual(original);
    });
  });
});
