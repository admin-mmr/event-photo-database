import {
  getFolderById,
  findSubfolder,
  createSubfolder,
  getOrCreateSubfolder,
  createEventFolder,
  listEventFolders,
  getOrCreateClubFolder,
  createBatchFolder,
  verifyRootFolderAccess,
  listFilesInClubFolder,
  getClubFolderTree,
  scanLayer1Violations,
  scanLayer2Violations,
  scanAllViolations,
  getEventDriveTree,
} from '../../src/services/driveService';
import {
  mockFolder,
  mockDriveApp,
  resetMockScriptProperties,
} from '../mocks/gasGlobals';
import { ResultStatus } from '../../src/types/enums';

// Helper: create a mock Drive folder with a specific name and ID
function makeMockFolder(name: string, id: string) {
  return {
    getId: jest.fn().mockReturnValue(id),
    getName: jest.fn().mockReturnValue(name),
    createFolder: jest.fn().mockImplementation((n: string) => makeMockFolder(n, `new-${n}-id`)),
    getFolders: jest.fn().mockReturnValue({ hasNext: jest.fn().mockReturnValue(false) }),
    getFoldersByName: jest.fn().mockReturnValue({ hasNext: jest.fn().mockReturnValue(false) }),
    getFiles: jest.fn().mockReturnValue({ hasNext: jest.fn().mockReturnValue(false) }),
  };
}

describe('driveService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Restore default mockFolder behavior
    mockFolder.getId.mockReturnValue('mock-folder-id');
    mockFolder.getName.mockReturnValue('Root_Folder');
    mockFolder.createFolder.mockImplementation((name: string) =>
      makeMockFolder(name, `new-${name}-id`)
    );
    mockFolder.getFolders.mockReturnValue({ hasNext: jest.fn().mockReturnValue(false) });
    mockFolder.getFoldersByName.mockReturnValue({ hasNext: jest.fn().mockReturnValue(false) });
    mockDriveApp.getFolderById.mockReturnValue(mockFolder);
    mockDriveApp.getRootFolder.mockReturnValue(mockFolder);
  });

  // ── getFolderById ─────────────────────────────────────────────────────────

  describe('getFolderById()', () => {
    it('returns SUCCESS with the folder when the ID is valid', () => {
      const result = getFolderById('valid-id');
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toBeDefined();
    });

    it('returns ERROR when DriveApp throws (invalid ID)', () => {
      mockDriveApp.getFolderById.mockImplementationOnce(() => {
        throw new Error('Folder not found');
      });
      const result = getFolderById('bad-id');
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('bad-id');
    });
  });

  // ── findSubfolder ─────────────────────────────────────────────────────────

  describe('findSubfolder()', () => {
    it('returns null when no subfolder with that name exists', () => {
      const parent = makeMockFolder('Parent', 'parent-id');
      parent.getFoldersByName.mockReturnValue({ hasNext: jest.fn().mockReturnValue(false) });
      expect(findSubfolder(parent as unknown as GoogleAppsScript.Drive.Folder, 'Missing')).toBeNull();
    });

    it('returns the folder when a matching subfolder exists', () => {
      const child = makeMockFolder('Child', 'child-id');
      const parent = makeMockFolder('Parent', 'parent-id');
      parent.getFoldersByName.mockReturnValue({
        hasNext: jest.fn().mockReturnValueOnce(true).mockReturnValue(false),
        next: jest.fn().mockReturnValue(child),
      });
      const result = findSubfolder(parent as unknown as GoogleAppsScript.Drive.Folder, 'Child');
      expect(result).not.toBeNull();
      expect(result!.getName()).toBe('Child');
    });
  });

  // ── createSubfolder ───────────────────────────────────────────────────────

  describe('createSubfolder()', () => {
    it('creates a new folder and returns SUCCESS', () => {
      const parent = makeMockFolder('Parent', 'parent-id');
      const result = createSubfolder(
        parent as unknown as GoogleAppsScript.Drive.Folder,
        'New_Event'
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toBeDefined();
      expect(parent.createFolder).toHaveBeenCalledWith('New_Event');
    });

    it('returns ERROR if a folder with that name already exists', () => {
      const child = makeMockFolder('Existing', 'existing-id');
      const parent = makeMockFolder('Parent', 'parent-id');
      parent.getFoldersByName.mockReturnValue({
        hasNext: jest.fn().mockReturnValueOnce(true).mockReturnValue(false),
        next: jest.fn().mockReturnValue(child),
      });
      const result = createSubfolder(
        parent as unknown as GoogleAppsScript.Drive.Folder,
        'Existing'
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('already exists');
      expect(parent.createFolder).not.toHaveBeenCalled();
    });

    it('returns ERROR if DriveApp.createFolder throws', () => {
      const parent = makeMockFolder('Parent', 'parent-id');
      parent.createFolder.mockImplementationOnce(() => {
        throw new Error('Drive quota exceeded');
      });
      const result = createSubfolder(
        parent as unknown as GoogleAppsScript.Drive.Folder,
        'New_Folder'
      );
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('New_Folder');
    });
  });

  // ── getOrCreateSubfolder ──────────────────────────────────────────────────

  describe('getOrCreateSubfolder()', () => {
    it('creates folder when it does not exist', () => {
      const parent = makeMockFolder('Parent', 'parent-id');
      const result = getOrCreateSubfolder(
        parent as unknown as GoogleAppsScript.Drive.Folder,
        'ClubFolder'
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(parent.createFolder).toHaveBeenCalledWith('ClubFolder');
    });

    it('returns existing folder without creating a new one', () => {
      const child = makeMockFolder('ClubFolder', 'existing-id');
      const parent = makeMockFolder('Parent', 'parent-id');
      parent.getFoldersByName.mockReturnValue({
        hasNext: jest.fn().mockReturnValueOnce(true).mockReturnValue(false),
        next: jest.fn().mockReturnValue(child),
      });
      const result = getOrCreateSubfolder(
        parent as unknown as GoogleAppsScript.Drive.Folder,
        'ClubFolder'
      );
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(parent.createFolder).not.toHaveBeenCalled();
      expect(result.data!.getId()).toBe('existing-id');
    });
  });

  // ── createEventFolder ─────────────────────────────────────────────────────

  describe('createEventFolder()', () => {
    it('creates an event folder in the root and returns its ID', () => {
      const result = createEventFolder('2025-11-03_NYC_Marathon');
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.folderName).toBe('2025-11-03_NYC_Marathon');
      expect(result.data!.folderId).toBeDefined();
    });

    it('returns ERROR when the event folder already exists', () => {
      const existing = makeMockFolder('2025-11-03_NYC_Marathon', 'existing-id');
      mockFolder.getFoldersByName.mockReturnValue({
        hasNext: jest.fn().mockReturnValueOnce(true).mockReturnValue(false),
        next: jest.fn().mockReturnValue(existing),
      });
      const result = createEventFolder('2025-11-03_NYC_Marathon');
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('already exists');
    });
  });

  // ── listEventFolders ──────────────────────────────────────────────────────

  describe('listEventFolders()', () => {
    it('returns SUCCESS with empty array when no event folders exist', () => {
      const result = listEventFolders();
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toEqual([]);
    });

    it('returns all event folders sorted alphabetically', () => {
      const f1 = makeMockFolder('2025-12-25_Christmas', 'id1');
      const f2 = makeMockFolder('2025-01-01_New_Year', 'id2');
      let callCount = 0;
      const items = [f1, f2];
      mockFolder.getFolders.mockReturnValue({
        hasNext: jest.fn().mockImplementation(() => callCount < items.length),
        next: jest.fn().mockImplementation(() => items[callCount++]),
      });

      const result = listEventFolders();
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!).toHaveLength(2);
      // Sorted: New_Year comes before Christmas alphabetically
      expect(result.data![0].name).toBe('2025-01-01_New_Year');
      expect(result.data![1].name).toBe('2025-12-25_Christmas');
    });
  });

  // ── getOrCreateClubFolder ─────────────────────────────────────────────────

  describe('getOrCreateClubFolder()', () => {
    it('creates a club folder inside an event folder', () => {
      const result = getOrCreateClubFolder('event-folder-id', 'New_Bee');
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.folderName).toBe('New_Bee');
    });

    it('returns ERROR when the event folder ID is invalid', () => {
      mockDriveApp.getFolderById.mockImplementationOnce(() => {
        throw new Error('Not found');
      });
      const result = getOrCreateClubFolder('bad-id', 'New_Bee');
      expect(result.status).toBe(ResultStatus.ERROR);
    });
  });

  // ── createBatchFolder ─────────────────────────────────────────────────────

  describe('createBatchFolder()', () => {
    it('creates a new batch folder inside a club folder', () => {
      const result = createBatchFolder('club-folder-id', '20251103-093500_cathylin');
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.folderName).toBe('20251103-093500_cathylin');
    });

    it('returns ERROR when the club folder ID is invalid', () => {
      mockDriveApp.getFolderById.mockImplementationOnce(() => {
        throw new Error('Not found');
      });
      const result = createBatchFolder('bad-id', '20251103-093500_cathylin');
      expect(result.status).toBe(ResultStatus.ERROR);
    });
  });

  // ── verifyRootFolderAccess ────────────────────────────────────────────────

  describe('verifyRootFolderAccess()', () => {
    it('returns SUCCESS with name and id when root folder is accessible', () => {
      mockFolder.getName.mockReturnValue('湘舍动_Photos');
      mockFolder.getId.mockReturnValue('root-id-123');
      const result = verifyRootFolderAccess();
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.name).toBe('湘舍动_Photos');
      expect(result.data!.id).toBe('root-id-123');
    });

    it('returns ERROR when root folder cannot be accessed', () => {
      mockDriveApp.getFolderById.mockImplementationOnce(() => {
        throw new Error('Permission denied');
      });
      const result = verifyRootFolderAccess();
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('Cannot access root folder');
    });
  });

  // ── Phase 3: listFilesInClubFolder ───────────────────────────────────────

  describe('listFilesInClubFolder()', () => {
    /** Creates a mock file with name, size, and a fixed last-updated date. */
    function makeMockFile(name: string, sizeBytes: number) {
      return {
        getName: jest.fn().mockReturnValue(name),
        getId: jest.fn().mockReturnValue(`file-${name}-id`),
        getSize: jest.fn().mockReturnValue(sizeBytes),
        getLastUpdated: jest.fn().mockReturnValue(new Date('2025-11-03T10:00:00Z')),
      };
    }

    /** Returns an iterator mock that yields items in sequence. */
    function makeIterator<T>(items: T[]) {
      let i = 0;
      return {
        hasNext: jest.fn().mockImplementation(() => i < items.length),
        next: jest.fn().mockImplementation(() => items[i++]),
      };
    }

    it('returns SUCCESS with empty array when club folder has no batch subfolders', () => {
      const clubFolder = makeMockFolder('New_Bee', 'club-id');
      clubFolder.getFolders.mockReturnValue(makeIterator([]));
      mockDriveApp.getFolderById.mockReturnValue(clubFolder);

      const result = listFilesInClubFolder('club-id');

      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toEqual([]);
      expect(result.message).toContain('0 file');
    });

    it('returns all files from a single batch folder', () => {
      const file1 = makeMockFile('photo1.jpg', 1024 * 1024);
      const file2 = makeMockFile('photo2.png', 2 * 1024 * 1024);

      const batchFolder = makeMockFolder('20251103-093500_cathylin', 'batch-id-1');
      batchFolder.getFiles.mockReturnValue(makeIterator([file1, file2]));
      batchFolder.getFolders.mockReturnValue(makeIterator([]));

      const clubFolder = makeMockFolder('New_Bee', 'club-id');
      clubFolder.getFolders.mockReturnValue(makeIterator([batchFolder]));

      mockDriveApp.getFolderById.mockReturnValue(clubFolder);

      const result = listFilesInClubFolder('club-id');

      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toHaveLength(2);
      expect(result.data![0].name).toBe('photo1.jpg');
      expect(result.data![0].batchFolderName).toBe('20251103-093500_cathylin');
      expect(result.data![0].sizeBytes).toBe(1024 * 1024);
      expect(result.data![1].name).toBe('photo2.png');
    });

    it('aggregates files from multiple batch folders and sorts by batch name', () => {
      const fileA = makeMockFile('early.jpg', 500);
      const fileB = makeMockFile('late.jpg', 600);

      // batch2 sorts after batch1 alphabetically
      const batch1 = makeMockFolder('20251103-080000_alice', 'batch-id-a');
      batch1.getFiles.mockReturnValue(makeIterator([fileA]));
      batch1.getFolders.mockReturnValue(makeIterator([]));

      const batch2 = makeMockFolder('20251103-150000_bob', 'batch-id-b');
      batch2.getFiles.mockReturnValue(makeIterator([fileB]));
      batch2.getFolders.mockReturnValue(makeIterator([]));

      const clubFolder = makeMockFolder('New_Bee', 'club-id');
      // Return batch2 first to verify sort
      clubFolder.getFolders.mockReturnValue(makeIterator([batch2, batch1]));

      mockDriveApp.getFolderById.mockReturnValue(clubFolder);

      const result = listFilesInClubFolder('club-id');

      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toHaveLength(2);
      // batch1 (earlier timestamp) should come first after sorting
      expect(result.data![0].batchFolderName).toBe('20251103-080000_alice');
      expect(result.data![1].batchFolderName).toBe('20251103-150000_bob');
    });

    it('returns ERROR when the club folder ID is invalid', () => {
      mockDriveApp.getFolderById.mockImplementationOnce(() => {
        throw new Error('Folder not found');
      });

      const result = listFilesInClubFolder('bad-club-id');

      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('bad-club-id');
    });

    it('includes file metadata: fileId, modifiedAt, batchFolderId', () => {
      const file = makeMockFile('race.heic', 3 * 1024 * 1024);
      const batch = makeMockFolder('20251103-093500_cathylin', 'batch-99');
      batch.getFiles.mockReturnValue(makeIterator([file]));
      batch.getFolders.mockReturnValue(makeIterator([]));

      const clubFolder = makeMockFolder('New_Bee', 'club-id');
      clubFolder.getFolders.mockReturnValue(makeIterator([batch]));
      mockDriveApp.getFolderById.mockReturnValue(clubFolder);

      const result = listFilesInClubFolder('club-id');

      expect(result.status).toBe(ResultStatus.SUCCESS);
      const entry = result.data![0];
      expect(entry.fileId).toBe('file-race.heic-id');
      expect(entry.batchFolderId).toBe('batch-99');
      expect(entry.modifiedAt).toBe('2025-11-03T10:00:00.000Z');
    });
  });

  // ── Phase 3: getClubFolderTree ───────────────────────────────────────────

  describe('getClubFolderTree()', () => {
    function makeIterator<T>(items: T[]) {
      let i = 0;
      return {
        hasNext: jest.fn().mockImplementation(() => i < items.length),
        next: jest.fn().mockImplementation(() => items[i++]),
      };
    }

    it('returns null data when the club subfolder does not exist', () => {
      const eventFolder = makeMockFolder('2025-11-03_NYC_Marathon', 'evt-folder-id');
      eventFolder.getFoldersByName.mockReturnValue(makeIterator([]));
      mockDriveApp.getFolderById.mockReturnValue(eventFolder);

      const result = getClubFolderTree('evt-folder-id', 'New_Bee');

      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toBeNull();
      expect(result.message).toContain('will be created on first upload');
    });

    it('returns folderId and files when the club subfolder exists', () => {
      const clubFolder = makeMockFolder('New_Bee', 'club-id-123');
      // Simulate an empty club folder (no batch folders yet)
      clubFolder.getFolders.mockReturnValue(makeIterator([]));

      const eventFolder = makeMockFolder('2025-11-03_NYC_Marathon', 'evt-folder-id');
      eventFolder.getFoldersByName.mockReturnValue(makeIterator([clubFolder]));

      // getFolderById is called twice: once for event folder, once for club folder
      mockDriveApp.getFolderById
        .mockReturnValueOnce(eventFolder)
        .mockReturnValueOnce(clubFolder);

      const result = getClubFolderTree('evt-folder-id', 'New_Bee');

      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).not.toBeNull();
      expect(result.data!.folderId).toBe('club-id-123');
      expect(result.data!.files).toHaveLength(0);
    });

    it('returns ERROR when the event folder cannot be fetched', () => {
      mockDriveApp.getFolderById.mockImplementationOnce(() => {
        throw new Error('Access denied');
      });

      const result = getClubFolderTree('bad-evt-id', 'New_Bee');

      expect(result.status).toBe(ResultStatus.ERROR);
    });
  });

  // ── scanLayer1Violations ─────────────────────────────────────────────────

  describe('scanLayer1Violations()', () => {
    function makeIterator<T>(items: T[]) {
      let i = 0;
      return {
        hasNext: jest.fn().mockImplementation(() => i < items.length),
        next: jest.fn().mockImplementation(() => items[i++]),
      };
    }

    it('returns SUCCESS with empty violations when all Layer 1 folders are valid', () => {
      const f1 = makeMockFolder('2025-11-03_NYC_Marathon', 'id1');
      const f2 = makeMockFolder('2025-12-25_Christmas_Run', 'id2');
      mockFolder.getFolders.mockReturnValue(makeIterator([f1, f2]));

      const result = scanLayer1Violations();

      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toHaveLength(0);
      expect(result.message).toContain('0 violation');
    });

    it('detects a Layer 1 folder with an invalid name (no date prefix)', () => {
      const bad = makeMockFolder('NYC_Marathon', 'bad-id');
      mockFolder.getFolders.mockReturnValue(makeIterator([bad]));

      const result = scanLayer1Violations();

      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toHaveLength(1);
      expect(result.data![0].folderName).toBe('NYC_Marathon');
      expect(result.data![0].layer).toBe(1);
    });

    it('detects a Layer 1 folder with a valid regex but invalid calendar date', () => {
      const badDate = makeMockFolder('2025-02-30_Some_Run', 'bad-id-2');
      mockFolder.getFolders.mockReturnValue(makeIterator([badDate]));

      const result = scanLayer1Violations();

      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toHaveLength(1);
      expect(result.data![0].folderName).toBe('2025-02-30_Some_Run');
    });

    it('reports multiple violations when several folders are malformed', () => {
      const bad1 = makeMockFolder('not-a-date-folder', 'id-bad1');
      const bad2 = makeMockFolder('another bad one', 'id-bad2');
      const good = makeMockFolder('2026-04-17_Spring_Run', 'id-good');
      mockFolder.getFolders.mockReturnValue(makeIterator([bad1, bad2, good]));

      const result = scanLayer1Violations();

      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toHaveLength(2);
    });

    it('returns SUCCESS with empty array when root has no folders', () => {
      mockFolder.getFolders.mockReturnValue(makeIterator([]));
      const result = scanLayer1Violations();
      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toHaveLength(0);
    });

    it('returns ERROR when root folder cannot be accessed', () => {
      mockDriveApp.getFolderById.mockImplementationOnce(() => {
        throw new Error('Permission denied');
      });
      const result = scanLayer1Violations();
      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('Layer 1 scan failed');
    });

    it('includes folderId, parentFolderName, and detectedAt on each violation', () => {
      const bad = makeMockFolder('bad_folder', 'bad-folder-id');
      mockFolder.getFolders.mockReturnValue(makeIterator([bad]));

      const result = scanLayer1Violations();

      const v = result.data![0];
      expect(v.folderId).toBe('bad-folder-id');
      expect(typeof v.parentFolderName).toBe('string');
      expect(typeof v.detectedAt).toBe('string');
    });
  });

  // ── scanLayer2Violations ─────────────────────────────────────────────────

  describe('scanLayer2Violations()', () => {
    function makeIterator<T>(items: T[]) {
      let i = 0;
      return {
        hasNext: jest.fn().mockImplementation(() => i < items.length),
        next: jest.fn().mockImplementation(() => items[i++]),
      };
    }

    // The Clubs sheet needs to be wired up so listAllClubs() can find approved names.
    // 5-column schema matching CLUB_HEADERS in clubService.ts:
    // display_name(0) normalized_name(1) status(2) added_date(3) added_by(4)
    const CLUBS_HEADERS = [
      'DISPLAY_NAME', 'NORMALIZED_NAME',
      'STATUS', 'ADDED_DATE', 'ADDED_BY',
    ];
    const CLUBS_DATA: unknown[][] = [
      ['新蜂', 'New_Bee',        'active', '2025-01-01', 'system'],
      ['岚山', 'Misty_Mountain', 'active', '2025-01-01', 'system'],
    ];

    const { mockSheets: ms } = require('../mocks/gasGlobals');
    const mockSA = (global as Record<string, unknown>)['SpreadsheetApp'] as { openById: jest.Mock };

    function useClubsSheet() {
      const clubSheet = {
        getLastRow: jest.fn().mockReturnValue(CLUBS_DATA.length + 1),
        getLastColumn: jest.fn().mockReturnValue(CLUBS_HEADERS.length),
        getRange: jest.fn().mockImplementation((rowStart: number, _c: number, numRows?: number, numCols?: number) => {
          if (rowStart === 1 && numRows === 1) {
            return { getValues: jest.fn().mockReturnValue([CLUBS_HEADERS.slice(0, numCols ?? CLUBS_HEADERS.length)]), setValues: jest.fn() };
          }
          const slice = CLUBS_DATA.slice(rowStart - 2, numRows ? (rowStart - 2) + numRows : undefined);
          return { getValues: jest.fn().mockReturnValue(slice), setValues: jest.fn() };
        }),
        appendRow: jest.fn(),
      };
      ms['Clubs'] = clubSheet;
      mockSA.openById.mockReturnValue({
        getSheetByName: jest.fn().mockImplementation((name: string) => ms[name] ?? null),
      });
    }

    beforeEach(() => {
      useClubsSheet();
    });

    it('returns SUCCESS with empty violations when all club folders use approved names', () => {
      const bee  = makeMockFolder('New_Bee', 'club-id-1');
      const mist = makeMockFolder('Misty_Mountain', 'club-id-2');

      const eventFolder = makeMockFolder('2025-11-03_NYC_Marathon', 'evt-id');
      eventFolder.getFolders.mockReturnValue(makeIterator([bee, mist]));
      mockDriveApp.getFolderById.mockReturnValue(eventFolder);

      const result = scanLayer2Violations('evt-id');

      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toHaveLength(0);
    });

    it('detects a Layer 2 folder that is not in the approved clubs list', () => {
      const rogue = makeMockFolder('Unknown_Club', 'rogue-id');
      const eventFolder = makeMockFolder('2025-11-03_NYC_Marathon', 'evt-id');
      eventFolder.getFolders.mockReturnValue(makeIterator([rogue]));
      mockDriveApp.getFolderById.mockReturnValue(eventFolder);

      const result = scanLayer2Violations('evt-id');

      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toHaveLength(1);
      expect(result.data![0].folderName).toBe('Unknown_Club');
      expect(result.data![0].layer).toBe(2);
    });

    it('detects folders that fail the Layer 2 regex (starts with digit)', () => {
      const numeric = makeMockFolder('1Club', 'numeric-id');
      const eventFolder = makeMockFolder('2025-11-03_NYC_Marathon', 'evt-id');
      eventFolder.getFolders.mockReturnValue(makeIterator([numeric]));
      mockDriveApp.getFolderById.mockReturnValue(eventFolder);

      const result = scanLayer2Violations('evt-id');

      expect(result.data).toHaveLength(1);
      expect(result.data![0].violationType).toContain('Layer 2');
    });

    it('returns SUCCESS with empty array when event folder has no club subfolders', () => {
      const eventFolder = makeMockFolder('2025-11-03_NYC_Marathon', 'evt-id');
      eventFolder.getFolders.mockReturnValue(makeIterator([]));
      mockDriveApp.getFolderById.mockReturnValue(eventFolder);

      const result = scanLayer2Violations('evt-id');

      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toHaveLength(0);
    });

    it('returns ERROR when the event folder ID is invalid', () => {
      mockDriveApp.getFolderById.mockImplementationOnce(() => {
        throw new Error('Not found');
      });
      const result = scanLayer2Violations('bad-evt-id');
      expect(result.status).toBe(ResultStatus.ERROR);
    });
  });

  // ── scanAllViolations ────────────────────────────────────────────────────

  describe('scanAllViolations()', () => {
    function makeIterator<T>(items: T[]) {
      let i = 0;
      return {
        hasNext: jest.fn().mockImplementation(() => i < items.length),
        next: jest.fn().mockImplementation(() => items[i++]),
      };
    }

    it('returns SUCCESS combining Layer 1 + Layer 2 results', () => {
      // Root: one valid event folder + one bad Layer 1 folder
      const eventFolder = makeMockFolder('2025-11-03_NYC_Marathon', 'evt-id');
      const badLayer1   = makeMockFolder('not_a_valid_event', 'bad-l1-id');

      // The event folder has one valid club subfolder
      eventFolder.getFolders.mockReturnValue(makeIterator([]));
      eventFolder.getFoldersByName.mockReturnValue(makeIterator([]));

      // Root.getFolders called twice: once for Layer1 scan, once for listEventFolders
      let rootCallCount = 0;
      mockFolder.getFolders.mockImplementation(() => {
        rootCallCount++;
        // Both calls return: valid event + bad layer1
        const items = [eventFolder, badLayer1];
        let i = 0;
        return {
          hasNext: jest.fn().mockImplementation(() => i < items.length),
          next: jest.fn().mockImplementation(() => items[i++]),
        };
      });

      // getFolderById for the event folder (during Layer 2 scan)
      mockDriveApp.getFolderById.mockImplementation((id: string) => {
        if (id === 'evt-id') return eventFolder;
        return mockFolder; // root
      });

      const result = scanAllViolations();

      expect(result.status).toBe(ResultStatus.SUCCESS);
      // At minimum: the bad Layer 1 folder is detected
      expect(result.data!.length).toBeGreaterThanOrEqual(1);
    });

    it('returns SUCCESS with empty violations when everything is clean', () => {
      // No folders in root
      mockFolder.getFolders.mockReturnValue(makeIterator([]));

      const result = scanAllViolations();

      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data).toHaveLength(0);
      expect(result.message).toContain('0 total violation');
    });
  });

  // ── getEventDriveTree ─────────────────────────────────────────────────────

  describe('getEventDriveTree()', () => {
    // Clear the ScriptProperties-backed Drive tree cache before each test so a
    // cache hit from a previous test doesn't mask a Drive API error.
    beforeEach(() => {
      resetMockScriptProperties();
    });

    /**
     * Builds a minimal mock Drive file with just getMimeType().
     */
    function makeMockFile(mimeType: string) {
      return { 
        getMimeType: jest.fn().mockReturnValue(mimeType),
        getSize: jest.fn().mockReturnValue(1024)
      };
    }

    /**
     * Creates a synchronous iterator over an array (mirrors the GAS pattern).
     */
    function makeIterator<T>(items: T[]) {
      let i = 0;
      return {
        hasNext: jest.fn().mockImplementation(() => i < items.length),
        next:    jest.fn().mockImplementation(() => items[i++]),
      };
    }

    /**
     * Builds a mock batch folder (Layer 3) containing a given set of files.
     */
    function makeBatchFolder(id: string, name: string, files: ReturnType<typeof makeMockFile>[]) {
      const f = makeMockFolder(name, id);
      f.getFiles.mockReturnValue(makeIterator(files));
      f.getFolders.mockReturnValue(makeIterator([])); // batch folders have no sub-folders
      return f;
    }

    /**
     * Builds a mock club folder (Layer 2) containing a given set of batch folders.
     */
    function makeClubFolder(
      id: string,
      name: string,
      batches: ReturnType<typeof makeMockFolder>[]
    ) {
      const f = makeMockFolder(name, id);
      f.getFolders.mockReturnValue(makeIterator(batches));
      f.getFiles.mockReturnValue(makeIterator([]));
      return f;
    }

    /**
     * Builds a mock event folder (Layer 1) containing a given set of club folders.
     */
    function makeEventFolder(clubs: ReturnType<typeof makeMockFolder>[]) {
      const f = makeMockFolder('2026-04-19_Test_Event', 'event-folder-id');
      f.getFolders.mockReturnValue(makeIterator(clubs));
      f.getFiles.mockReturnValue(makeIterator([]));
      return f;
    }

    it('returns SUCCESS with empty clubs and zero totalFiles for an empty event folder', () => {
      const eventFolder = makeEventFolder([]);
      mockDriveApp.getFolderById.mockReturnValue(eventFolder);

      const result = getEventDriveTree('evt-001', 'event-folder-id');

      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.eventId).toBe('evt-001');
      expect(result.data!.clubs).toHaveLength(0);
      expect(result.data!.totalFiles).toBe(0);
    });

    it('returns ERROR when the event folder cannot be accessed', () => {
      mockDriveApp.getFolderById.mockImplementationOnce(() => {
        throw new Error('Drive access denied');
      });

      const result = getEventDriveTree('evt-001', 'bad-folder-id');

      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('bad-folder-id');
    });

    it('counts JPEG, PNG, and HEIC files correctly in one batch', () => {
      const batch = makeBatchFolder('batch-id', '20260419-100000_alice', [
        makeMockFile('image/jpeg'),
        makeMockFile('image/png'),
        makeMockFile('image/heic'),
      ]);
      const club = makeClubFolder('club-id', 'New_Bee', [batch]);
      mockDriveApp.getFolderById.mockReturnValue(makeEventFolder([club]));

      const result = getEventDriveTree('evt-001', 'event-folder-id');

      expect(result.status).toBe(ResultStatus.SUCCESS);
      expect(result.data!.clubs[0].batches[0].fileCount).toBe(3);
      expect(result.data!.totalFiles).toBe(3);
    });

    it('excludes non-photo files (PDF, MP4, etc.) from the count', () => {
      const batch = makeBatchFolder('batch-id', '20260419-090000_bob', [
        makeMockFile('image/jpeg'),
        makeMockFile('application/pdf'),    // must be excluded
        makeMockFile('video/mp4'),           // must be excluded
        makeMockFile('image/png'),
      ]);
      const club = makeClubFolder('club-id', 'CHI', [batch]);
      mockDriveApp.getFolderById.mockReturnValue(makeEventFolder([club]));

      const result = getEventDriveTree('evt-001', 'event-folder-id');

      expect(result.data!.clubs[0].batches[0].fileCount).toBe(2); // JPEG + PNG only
      expect(result.data!.totalFiles).toBe(2);
    });

    it('aggregates totalFiles correctly across multiple clubs and batches', () => {
      const batch1a = makeBatchFolder('b1a', '20260419-090000_alice', [
        makeMockFile('image/jpeg'),
        makeMockFile('image/jpeg'),
      ]);
      const batch1b = makeBatchFolder('b1b', '20260419-110000_alice', [
        makeMockFile('image/heic'),
      ]);
      const batch2a = makeBatchFolder('b2a', '20260419-100000_bob', [
        makeMockFile('image/png'),
        makeMockFile('image/png'),
        makeMockFile('image/png'),
      ]);
      const clubA = makeClubFolder('club-a', 'New_Bee', [batch1a, batch1b]);
      const clubB = makeClubFolder('club-b', 'CHI',     [batch2a]);
      mockDriveApp.getFolderById.mockReturnValue(makeEventFolder([clubA, clubB]));

      const result = getEventDriveTree('evt-001', 'event-folder-id');

      const newBee = result.data!.clubs.find((c) => c.name === 'New_Bee')!;
      const chi    = result.data!.clubs.find((c) => c.name === 'CHI')!;
      expect(newBee.totalFiles).toBe(3);   // 2 + 1
      expect(chi.totalFiles).toBe(3);      // 3
      expect(result.data!.totalFiles).toBe(6);
    });

    it('sorts clubs alphabetically by name', () => {
      const zClub  = makeClubFolder('z-id', 'Zebra_Club', []);
      const aClub  = makeClubFolder('a-id', 'Alpha_Club', []);
      const mClub  = makeClubFolder('m-id', 'Mid_Club',   []);
      // Drive returns them in arbitrary order
      mockDriveApp.getFolderById.mockReturnValue(makeEventFolder([zClub, aClub, mClub]));

      const result = getEventDriveTree('evt-001', 'event-folder-id');

      const names = result.data!.clubs.map((c) => c.name);
      expect(names).toEqual(['Alpha_Club', 'Mid_Club', 'Zebra_Club']);
    });

    it('sorts batches within a club newest-first (by name descending)', () => {
      const older  = makeBatchFolder('b-old', '20260410-080000_alice', []);
      const newer  = makeBatchFolder('b-new', '20260419-120000_alice', []);
      const middle = makeBatchFolder('b-mid', '20260415-090000_alice', []);
      const club   = makeClubFolder('club-id', 'New_Bee', [older, newer, middle]);
      mockDriveApp.getFolderById.mockReturnValue(makeEventFolder([club]));

      const result = getEventDriveTree('evt-001', 'event-folder-id');

      const batchNames = result.data!.clubs[0].batches.map((b) => b.name);
      expect(batchNames).toEqual([
        '20260419-120000_alice',  // newest first
        '20260415-090000_alice',
        '20260410-080000_alice',
      ]);
    });

    it('handles a club with no batch folders (empty batches array)', () => {
      const club = makeClubFolder('club-id', 'Empty_Club', []);
      mockDriveApp.getFolderById.mockReturnValue(makeEventFolder([club]));

      const result = getEventDriveTree('evt-001', 'event-folder-id');

      expect(result.data!.clubs[0].batches).toHaveLength(0);
      expect(result.data!.clubs[0].totalFiles).toBe(0);
    });

    it('handles a batch folder with no files (fileCount = 0)', () => {
      const emptyBatch = makeBatchFolder('b-empty', '20260419-080000_alice', []);
      const club = makeClubFolder('club-id', 'New_Bee', [emptyBatch]);
      mockDriveApp.getFolderById.mockReturnValue(makeEventFolder([club]));

      const result = getEventDriveTree('evt-001', 'event-folder-id');

      expect(result.data!.clubs[0].batches[0].fileCount).toBe(0);
      expect(result.data!.clubs[0].totalFiles).toBe(0);
    });

    it('records the correct folder ID and name for each node', () => {
      const batch = makeBatchFolder('batch-xyz', '20260419-093000_carol', [
        makeMockFile('image/jpeg'),
      ]);
      const club = makeClubFolder('club-abc', 'Nankai', [batch]);
      mockDriveApp.getFolderById.mockReturnValue(makeEventFolder([club]));

      const result = getEventDriveTree('evt-uuid-99', 'event-folder-id');

      expect(result.data!.eventId).toBe('evt-uuid-99');
      expect(result.data!.clubs[0].id).toBe('club-abc');
      expect(result.data!.clubs[0].name).toBe('Nankai');
      expect(result.data!.clubs[0].batches[0].id).toBe('batch-xyz');
      expect(result.data!.clubs[0].batches[0].name).toBe('20260419-093000_carol');
    });

    it('returns ERROR when the club folder walk throws', () => {
      const brokenEventFolder = makeMockFolder('2026-04-19_Test_Event', 'event-folder-id');
      brokenEventFolder.getFolders.mockImplementationOnce(() => {
        throw new Error('Permission denied');
      });
      mockDriveApp.getFolderById.mockReturnValue(brokenEventFolder);

      const result = getEventDriveTree('evt-001', 'event-folder-id');

      expect(result.status).toBe(ResultStatus.ERROR);
      expect(result.message).toContain('Error walking event folder');
    });

    it('handles multiple batches with mixed photo and non-photo files', () => {
      const batch1 = makeBatchFolder('b1', '20260419-090000_alice', [
        makeMockFile('image/jpeg'),
        makeMockFile('image/gif'),  // not counted
      ]);
      const batch2 = makeBatchFolder('b2', '20260419-100000_alice', [
        makeMockFile('image/heic'),
        makeMockFile('image/heic'),
        makeMockFile('text/plain'), // not counted
      ]);
      const club = makeClubFolder('club-id', 'New_Bee', [batch1, batch2]);
      mockDriveApp.getFolderById.mockReturnValue(makeEventFolder([club]));

      const result = getEventDriveTree('evt-001', 'event-folder-id');

      const batches = result.data!.clubs[0].batches;
      // Sorted newest-first: batch2 before batch1
      expect(batches[0].name).toBe('20260419-100000_alice');
      expect(batches[0].fileCount).toBe(2); // 2 HEICs
      expect(batches[1].name).toBe('20260419-090000_alice');
      expect(batches[1].fileCount).toBe(1); // 1 JPEG (GIF excluded)
      expect(result.data!.clubs[0].totalFiles).toBe(3);
    });

    it('passes driveFolderId through to data.driveFolderId', () => {
      mockDriveApp.getFolderById.mockReturnValue(makeEventFolder([]));

      const result = getEventDriveTree('evt-abc', 'drive-folder-xyz');

      expect(result.data!.driveFolderId).toBe('drive-folder-xyz');
    });

    it('returns SUCCESS message containing club and photo counts', () => {
      const batch = makeBatchFolder('b-id', '20260419-090000_alice', [
        makeMockFile('image/jpeg'),
        makeMockFile('image/jpeg'),
      ]);
      const club = makeClubFolder('c-id', 'New_Bee', [batch]);
      mockDriveApp.getFolderById.mockReturnValue(makeEventFolder([club]));

      const result = getEventDriveTree('evt-001', 'event-folder-id');

      expect(result.message).toContain('1 club');
      expect(result.message).toContain('2 photo');
    });
  });
});
