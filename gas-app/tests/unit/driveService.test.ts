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
} from '../../src/services/driveService';
import {
  mockFolder,
  mockDriveApp,
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
});
