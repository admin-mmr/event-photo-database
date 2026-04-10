import {
  generateSummary,
  summaryToCsv,
  buildExceptionEmailBody,
  SystemSummary,
} from '../../src/services/summaryService';
import {
  resetMockSheets,
  mockSheets,
  createMockSheet,
} from '../mocks/gasGlobals';
import { ResultStatus, UploadSource } from '../../src/types/enums';
import { FolderViolation } from '../../src/types/responses';

// ─── Dependency mocks ─────────────────────────────────────────────────────────

// scanAllViolations is a Drive API call; mock it at the module level.
// The factory cannot reference ResultStatus (hoisting), so we set the
// default return value in beforeEach instead.
jest.mock('../../src/services/driveService', () => ({
  ...jest.requireActual('../../src/services/driveService'),
  scanAllViolations: jest.fn(),
}));

import { scanAllViolations } from '../../src/services/driveService';
const mockScanAllViolations = scanAllViolations as jest.MockedFunction<typeof scanAllViolations>;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Upload_Log row in sheet order */
function makeLogRow(overrides: {
  logId?: string;
  eventId?: string;
  clubName?: string;
  uploadedBy?: string;
  batchFolderName?: string;
  batchFolderId?: string;
  fileCount?: number;
  totalSizeMb?: number;
  skippedDuplicates?: number;
  skippedNonPhoto?: number;
  uploadTimestamp?: string;
  source?: string;
} = {}): unknown[] {
  return [
    overrides.logId             ?? 'log-uuid-001',
    overrides.eventId           ?? 'evt-uuid-001',
    overrides.clubName          ?? 'New_Bee',
    overrides.uploadedBy        ?? 'user1@example.com',
    overrides.batchFolderName   ?? '20251103-093500_user1',
    overrides.batchFolderId     ?? 'batch-folder-id-001',
    overrides.fileCount         ?? 10,
    overrides.totalSizeMb       ?? 25.5,
    overrides.skippedDuplicates ?? 0,
    overrides.skippedNonPhoto   ?? 0,
    overrides.uploadTimestamp   ?? '2025-11-03T09:35:00.000Z',
    overrides.source            ?? UploadSource.WEB_APP,
  ];
}

/** Injects log rows into the mock Upload_Log sheet */
function seedLogs(rows: unknown[][]): void {
  mockSheets.Upload_Log = createMockSheet(rows);
  const mockSpreadsheet = (global as Record<string, unknown>)['SpreadsheetApp'] as {
    openById: jest.Mock;
  };
  mockSpreadsheet.openById.mockReturnValue({
    getSheetByName: jest.fn().mockImplementation((name: string) => {
      if (name === 'Upload_Log') return mockSheets.Upload_Log;
      if (name === 'Events') return mockSheets.Events;
      if (name === 'Users') return mockSheets.Users;
      return null;
    }),
  });
}

// ─── generateSummary ──────────────────────────────────────────────────────────

describe('generateSummary()', () => {
  beforeEach(() => {
    resetMockSheets();
    mockScanAllViolations.mockReturnValue({ status: ResultStatus.SUCCESS, message: 'OK', data: [] });
  });

  it('returns SUCCESS with a valid SystemSummary', () => {
    const result = generateSummary();
    expect(result.status).toBe(ResultStatus.SUCCESS);
    expect(result.data).toBeDefined();
  });

  it('includes generatedAt as an ISO 8601 timestamp', () => {
    const result = generateSummary();
    expect(result.data!.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('sets dateFrom and dateTo to null when no filter supplied', () => {
    const result = generateSummary();
    expect(result.data!.dateFrom).toBeNull();
    expect(result.data!.dateTo).toBeNull();
  });

  it('records supplied dateFrom/dateTo on the summary', () => {
    const result = generateSummary('2025-01-01', '2025-12-31');
    expect(result.data!.dateFrom).toBe('2025-01-01');
    expect(result.data!.dateTo).toBe('2025-12-31');
  });

  it('returns all 3 default events without uploads when Upload_Log is empty', () => {
    const result = generateSummary();
    expect(result.data!.eventsWithUploads).toHaveLength(0);
    expect(result.data!.eventsWithoutUploads).toHaveLength(3); // 3 default events
    expect(result.data!.totalPhotos).toBe(0);
  });

  it('moves an event into eventsWithUploads when it has log records', () => {
    seedLogs([makeLogRow({ eventId: 'evt-uuid-001', clubName: 'New_Bee', fileCount: 10 })]);

    const result = generateSummary();
    expect(result.data!.eventsWithUploads).toHaveLength(1);
    expect(result.data!.eventsWithoutUploads).toHaveLength(2);
    expect(result.data!.eventsWithUploads[0].event.eventId).toBe('evt-uuid-001');
  });

  it('aggregates fileCount and totalSizeMb correctly across sessions', () => {
    seedLogs([
      makeLogRow({ eventId: 'evt-uuid-001', clubName: 'New_Bee', fileCount: 10, totalSizeMb: 25 }),
      makeLogRow({ eventId: 'evt-uuid-001', clubName: 'New_Bee', fileCount: 5,  totalSizeMb: 10, logId: 'log-002', batchFolderName: 'batch2' }),
    ]);

    const result = generateSummary();
    const eventSummary = result.data!.eventsWithUploads[0];
    const club = eventSummary.clubs[0];

    expect(club.fileCount).toBe(15);
    expect(club.totalSizeMb).toBe(35);
    expect(club.sessionCount).toBe(2);
  });

  it('groups uploads from different clubs separately', () => {
    seedLogs([
      makeLogRow({ eventId: 'evt-uuid-001', clubName: 'New_Bee',       fileCount: 10, logId: 'log-001' }),
      makeLogRow({ eventId: 'evt-uuid-001', clubName: 'Misty_Mountain', fileCount: 20, logId: 'log-002' }),
    ]);

    const result = generateSummary();
    const clubs = result.data!.eventsWithUploads[0].clubs;
    expect(clubs).toHaveLength(2);
    // Sorted by fileCount descending — Misty_Mountain should come first
    expect(clubs[0].clubName).toBe('Misty_Mountain');
    expect(clubs[1].clubName).toBe('New_Bee');
  });

  it('computes system-wide totalPhotos and totalSizeMb', () => {
    seedLogs([
      makeLogRow({ eventId: 'evt-uuid-001', fileCount: 10, totalSizeMb: 20, logId: 'log-001' }),
      makeLogRow({ eventId: 'evt-uuid-002', fileCount: 5,  totalSizeMb: 10, logId: 'log-002' }),
    ]);

    const result = generateSummary();
    expect(result.data!.totalPhotos).toBe(15);
    expect(result.data!.totalSizeMb).toBe(30);
  });

  it('counts distinct club names in totalClubs', () => {
    seedLogs([
      makeLogRow({ eventId: 'evt-uuid-001', clubName: 'New_Bee',       logId: 'log-001' }),
      makeLogRow({ eventId: 'evt-uuid-002', clubName: 'New_Bee',       logId: 'log-002' }), // same club, different event
      makeLogRow({ eventId: 'evt-uuid-001', clubName: 'Misty_Mountain', logId: 'log-003' }),
    ]);

    const result = generateSummary();
    // New_Bee + Misty_Mountain = 2 distinct clubs
    expect(result.data!.totalClubs).toBe(2);
  });

  it('applies dateFrom filter — excludes events before the date', () => {
    seedLogs([]);
    // Default events: 2025-04-21 (Boston), 2025-11-03 (NYC), 2025-12-25 (Christmas)
    // dateFrom 2025-11-01 should exclude Boston
    const result = generateSummary('2025-11-01');
    const names = result.data!.eventsWithoutUploads.map((e) => e.eventName);
    expect(names).not.toContain('Boston Marathon');
    expect(names).toContain('NYC Marathon');
    expect(names).toContain('Christmas Fun Run');
  });

  it('applies dateTo filter — excludes events after the date', () => {
    seedLogs([]);
    const result = generateSummary(undefined, '2025-11-30');
    const names = result.data!.eventsWithoutUploads.map((e) => e.eventName);
    expect(names).not.toContain('Christmas Fun Run');
    expect(names).toContain('NYC Marathon');
    expect(names).toContain('Boston Marathon');
  });

  it('includes violations from scanAllViolations', () => {
    const violation: FolderViolation = {
      folderName: 'bad_folder',
      folderId: 'bad-id',
      parentFolderName: 'ROOT',
      layer: 1,
      violationType: 'Invalid date prefix',
      detectedAt: new Date().toISOString(),
    };
    mockScanAllViolations.mockReturnValueOnce({
      status: ResultStatus.SUCCESS as ResultStatus,
      message: '1 violation',
      data: [violation],
    });

    const result = generateSummary();
    expect(result.data!.violations).toHaveLength(1);
    expect(result.data!.violations[0].folderName).toBe('bad_folder');
  });

  it('eventsWithUploads are sorted newest-first by eventDate', () => {
    seedLogs([
      makeLogRow({ eventId: 'evt-uuid-001', logId: 'log-001' }), // 2025-11-03
      makeLogRow({ eventId: 'evt-uuid-002', logId: 'log-002' }), // 2025-04-21
    ]);

    const result = generateSummary();
    const dates = result.data!.eventsWithUploads.map((e) => e.event.eventDate);
    expect(dates[0]).toBe('2025-11-03'); // NYC Marathon first
    expect(dates[1]).toBe('2025-04-21'); // Boston Marathon second
  });

  it('picks the most recent uploadTimestamp as lastUploadAt', () => {
    seedLogs([
      makeLogRow({ logId: 'log-001', uploadTimestamp: '2025-11-03T09:00:00.000Z' }),
      makeLogRow({ logId: 'log-002', uploadTimestamp: '2025-11-03T15:00:00.000Z', batchFolderName: 'batch2' }),
    ]);

    const result = generateSummary();
    const club = result.data!.eventsWithUploads[0].clubs[0];
    expect(club.lastUploadAt).toBe('2025-11-03T15:00:00.000Z');
  });

  it('rounds totalSizeMb to 2 decimal places', () => {
    seedLogs([
      makeLogRow({ logId: 'log-001', totalSizeMb: 10.333 }),
      makeLogRow({ logId: 'log-002', totalSizeMb: 5.668, batchFolderName: 'batch2' }),
    ]);

    const result = generateSummary();
    const club = result.data!.eventsWithUploads[0].clubs[0];
    // 10.333 + 5.668 = 16.001, rounded to 2dp = 16
    expect(club.totalSizeMb).toBe(16);
  });
});

// ─── summaryToCsv ─────────────────────────────────────────────────────────────

describe('summaryToCsv()', () => {
  const baseSummary: SystemSummary = {
    generatedAt: '2025-11-10T10:00:00.000Z',
    dateFrom: null,
    dateTo: null,
    eventsWithUploads: [
      {
        event: {
          eventId: 'evt-uuid-001',
          eventName: 'NYC Marathon',
          eventDate: '2025-11-03',
          folderName: '2025-11-03_NYC_Marathon',
          driveFolderId: 'drive-001',
          createdBy: 'admin@example.com',
          createdAt: '2025-10-01T09:00:00.000Z',
        },
        clubs: [
          {
            clubName: 'New_Bee',
            sessionCount: 2,
            fileCount: 15,
            totalSizeMb: 35.5,
            lastUploadAt: '2025-11-03T15:00:00.000Z',
          },
        ],
        totalFiles: 15,
        totalSizeMb: 35.5,
        hasUploads: true,
      },
    ],
    eventsWithoutUploads: [
      {
        eventId: 'evt-uuid-002',
        eventName: 'Boston Marathon',
        eventDate: '2025-04-21',
        folderName: '2025-04-21_Boston_Marathon',
        driveFolderId: 'drive-002',
        createdBy: 'admin@example.com',
        createdAt: '2025-03-01T09:00:00.000Z',
      },
    ],
    violations: [
      {
        folderName: 'bad_folder',
        folderId: 'bad-id',
        parentFolderName: 'ROOT',
        layer: 1,
        violationType: 'Invalid date prefix',
        detectedAt: '2025-11-10T09:55:00.000Z',
      },
    ],
    totalPhotos: 15,
    totalSizeMb: 35.5,
    totalClubs: 1,
  };

  it('starts with a UTF-8 BOM', () => {
    const csv = summaryToCsv(baseSummary);
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
  });

  it('includes the generatedAt timestamp', () => {
    const csv = summaryToCsv(baseSummary);
    expect(csv).toContain('2025-11-10T10:00:00.000Z');
  });

  it('includes the events-with-uploads section header', () => {
    const csv = summaryToCsv(baseSummary);
    expect(csv).toContain('EVENTS WITH UPLOADS');
  });

  it('includes event name and club name in the upload rows', () => {
    const csv = summaryToCsv(baseSummary);
    expect(csv).toContain('NYC Marathon');
    expect(csv).toContain('New_Bee');
  });

  it('includes the events-without-uploads section', () => {
    const csv = summaryToCsv(baseSummary);
    expect(csv).toContain('EVENTS WITH NO UPLOADS');
    expect(csv).toContain('Boston Marathon');
  });

  it('includes the violations section', () => {
    const csv = summaryToCsv(baseSummary);
    expect(csv).toContain('NAMING VIOLATIONS');
    expect(csv).toContain('bad_folder');
  });

  it('quotes fields that contain commas', () => {
    const summaryWithComma = {
      ...baseSummary,
      eventsWithUploads: [
        {
          ...baseSummary.eventsWithUploads[0],
          event: {
            ...baseSummary.eventsWithUploads[0].event,
            eventName: 'NYC, Marathon',
          },
        },
      ],
    };
    const csv = summaryToCsv(summaryWithComma);
    expect(csv).toContain('"NYC, Marathon"');
  });

  it('includes date filter row when dateFrom is set', () => {
    const filtered = { ...baseSummary, dateFrom: '2025-01-01', dateTo: '2025-12-31' };
    const csv = summaryToCsv(filtered);
    expect(csv).toContain('2025-01-01');
    expect(csv).toContain('2025-12-31');
  });
});

// ─── buildExceptionEmailBody ──────────────────────────────────────────────────

describe('buildExceptionEmailBody()', () => {
  const summaryWithBoth: SystemSummary = {
    generatedAt: '2025-11-10T10:00:00.000Z',
    dateFrom: null,
    dateTo: null,
    eventsWithUploads: [],
    eventsWithoutUploads: [
      {
        eventId: 'evt-uuid-002',
        eventName: 'Boston Marathon',
        eventDate: '2025-04-21',
        folderName: '2025-04-21_Boston_Marathon',
        driveFolderId: 'drive-002',
        createdBy: 'admin@example.com',
        createdAt: '2025-03-01T09:00:00.000Z',
      },
    ],
    violations: [
      {
        folderName: 'bad_folder',
        folderId: 'bad-id',
        parentFolderName: 'ROOT',
        layer: 1,
        violationType: 'Invalid date prefix',
        detectedAt: '2025-11-10T09:55:00.000Z',
      },
    ],
    totalPhotos: 0,
    totalSizeMb: 0,
    totalClubs: 0,
  };

  it('includes the violations section header', () => {
    const body = buildExceptionEmailBody(summaryWithBoth);
    expect(body).toContain('Naming Violations');
  });

  it('lists each violation with layer, folder name, and reason', () => {
    const body = buildExceptionEmailBody(summaryWithBoth);
    expect(body).toContain('[Layer 1]');
    expect(body).toContain('bad_folder');
    expect(body).toContain('Invalid date prefix');
  });

  it('includes the events-with-no-uploads section', () => {
    const body = buildExceptionEmailBody(summaryWithBoth);
    expect(body).toContain('Events With No Uploads');
    expect(body).toContain('Boston Marathon');
    expect(body).toContain('2025-04-21');
  });

  it('omits violations section when there are none', () => {
    const noViolations = { ...summaryWithBoth, violations: [] };
    const body = buildExceptionEmailBody(noViolations);
    expect(body).not.toContain('Naming Violations');
  });

  it('omits inactive events section when all events have uploads', () => {
    const noInactive = { ...summaryWithBoth, eventsWithoutUploads: [] };
    const body = buildExceptionEmailBody(noInactive);
    expect(body).not.toContain('Events With No Uploads');
  });

  it('ends with the automated message footer', () => {
    const body = buildExceptionEmailBody(summaryWithBoth);
    expect(body).toContain('automated message');
  });
});
