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
} from '../../src/utils/sheetMapper';
import { UserRole, UserStatus, UploadSource, AuditAction } from '../../src/types/enums';
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

// ─── Clubs ────────────────────────────────────────────────────────────────────

describe('sheetMapper — Clubs', () => {
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
      expect(row[0]).toBe('新蜂');         // displayName
      expect(row[1]).toBe('New_Bee');     // normalizedName
      expect(row[2]).toBe('active');      // status
      expect(row[3]).toBe('2025-01-01'); // addedDate
      expect(row[4]).toBe('system');     // addedBy
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
    it('produces an array of 7 elements', () => {
      const record = toAuditLogRecord(validRow)!;
      const row = fromAuditLogRecord(record);
      expect(row).toHaveLength(7);
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
