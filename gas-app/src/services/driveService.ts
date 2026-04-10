import { ResultStatus } from '../types/enums';
import { ServiceResult, FolderViolation } from '../types/responses';
import { getConfig, APPROVED_CLUBS } from '../config/constants';
import { validateFolderName } from '../utils/folderNameValidator';
import { nowIsoTimestamp } from '../utils/dateFormatter';

/* global DriveApp */

/**
 * DriveService — Google Drive folder operations for the file system.
 *
 * Folder hierarchy managed by this service:
 *
 *   <ROOT_FOLDER>                        ← set via Script Property ROOT_FOLDER_ID
 *   └── YYYY-MM-DD_Event_Name/           ← Layer 1: event folder (created by admin)
 *       └── Club_Name/                   ← Layer 2: club folder (auto-created on upload)
 *           └── YYYYMMDD-HHMMSS_user/    ← Layer 3: batch folder (auto-created per upload)
 *               └── photo.jpg
 *
 * All folder names must pass FolderNameValidator before reaching this service.
 *
 * Design notes:
 *   - All operations return ServiceResult<T> — never throw across service boundaries
 *   - Folder existence is always checked before creation to avoid duplicates
 *   - IDs (not names) are stored in the Events/Upload_Log sheets for resilience
 *     to folder renames
 */

// ─── Root folder ──────────────────────────────────────────────────────────────

/**
 * Returns the configured root folder.
 * Throws if ROOT_FOLDER_ID is not set or the folder cannot be accessed.
 */
export function getRootFolder(): GoogleAppsScript.Drive.Folder {
  const config = getConfig();
  return DriveApp.getFolderById(config.ROOT_FOLDER_ID);
}

// ─── Folder operations ────────────────────────────────────────────────────────

/**
 * Gets a folder by its Drive ID.
 * Returns ERROR if the folder does not exist or cannot be accessed.
 */
export function getFolderById(
  folderId: string
): ServiceResult<GoogleAppsScript.Drive.Folder> {
  try {
    const folder = DriveApp.getFolderById(folderId);
    return { status: ResultStatus.SUCCESS, message: 'Folder found', data: folder };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Folder not found or access denied for ID "${folderId}": ${String(err)}`,
    };
  }
}

/**
 * Checks whether a folder with the given name exists directly inside a parent folder.
 * Returns the first matching folder, or null.
 *
 * Note: Google Drive allows multiple folders with the same name. This returns
 * the first match — folder names in this system must be unique by convention.
 */
export function findSubfolder(
  parent: GoogleAppsScript.Drive.Folder,
  name: string
): GoogleAppsScript.Drive.Folder | null {
  const iter = parent.getFoldersByName(name);
  return iter.hasNext() ? iter.next() : null;
}

/**
 * Creates a new subfolder inside the given parent folder.
 * Returns ERROR if a folder with that name already exists (prevents duplicates).
 *
 * @param parent    The parent Drive folder
 * @param name      The folder name (must already be validated)
 */
export function createSubfolder(
  parent: GoogleAppsScript.Drive.Folder,
  name: string
): ServiceResult<GoogleAppsScript.Drive.Folder> {
  try {
    const existing = findSubfolder(parent, name);
    if (existing) {
      return {
        status: ResultStatus.ERROR,
        message: `A folder named "${name}" already exists in "${parent.getName()}"`,
      };
    }
    const newFolder = parent.createFolder(name);
    return {
      status: ResultStatus.SUCCESS,
      message: `Folder "${name}" created`,
      data: newFolder,
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to create folder "${name}": ${String(err)}`,
    };
  }
}

/**
 * Gets or creates a subfolder — idempotent variant used for club and batch folders.
 * If the folder exists, returns it. If not, creates and returns it.
 */
export function getOrCreateSubfolder(
  parent: GoogleAppsScript.Drive.Folder,
  name: string
): ServiceResult<GoogleAppsScript.Drive.Folder> {
  try {
    const existing = findSubfolder(parent, name);
    if (existing) {
      return {
        status: ResultStatus.SUCCESS,
        message: `Folder "${name}" already exists`,
        data: existing,
      };
    }
    const newFolder = parent.createFolder(name);
    return {
      status: ResultStatus.SUCCESS,
      message: `Folder "${name}" created`,
      data: newFolder,
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to get or create folder "${name}": ${String(err)}`,
    };
  }
}

// ─── Layer 1: Event folders ───────────────────────────────────────────────────

/**
 * Creates a new Layer 1 event folder in the root.
 * The folderName must be pre-validated by FolderNameValidator (layer: 1).
 *
 * @param folderName  Validated name: YYYY-MM-DD_Event_Name
 */
export function createEventFolder(
  folderName: string
): ServiceResult<{ folderId: string; folderName: string }> {
  try {
    const root = getRootFolder();
    const result = createSubfolder(root, folderName);
    if (result.status !== ResultStatus.SUCCESS || !result.data) {
      return { status: ResultStatus.ERROR, message: result.message };
    }
    return {
      status: ResultStatus.SUCCESS,
      message: `Event folder "${folderName}" created`,
      data: { folderId: result.data.getId(), folderName },
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to create event folder "${folderName}": ${String(err)}`,
    };
  }
}

/**
 * Lists all Layer 1 event folders in the root.
 * Returns an array of { name, id } objects sorted alphabetically by name.
 */
export function listEventFolders(): ServiceResult<Array<{ name: string; id: string }>> {
  try {
    const root = getRootFolder();
    const iter = root.getFolders();
    const folders: Array<{ name: string; id: string }> = [];

    while (iter.hasNext()) {
      const f = iter.next();
      folders.push({ name: f.getName(), id: f.getId() });
    }

    folders.sort((a, b) => a.name.localeCompare(b.name));

    return {
      status: ResultStatus.SUCCESS,
      message: `Found ${folders.length} event folder(s)`,
      data: folders,
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to list event folders: ${String(err)}`,
    };
  }
}

// ─── Layer 2: Club folders ────────────────────────────────────────────────────

/**
 * Gets or creates a Layer 2 club folder inside an event folder.
 * The clubFolderName must be pre-validated (layer: 2).
 *
 * @param eventFolderId   Drive ID of the Layer 1 event folder
 * @param clubFolderName  Validated club folder name (e.g. "New_Bee")
 */
export function getOrCreateClubFolder(
  eventFolderId: string,
  clubFolderName: string
): ServiceResult<{ folderId: string; folderName: string }> {
  const parentResult = getFolderById(eventFolderId);
  if (parentResult.status !== ResultStatus.SUCCESS || !parentResult.data) {
    return { status: ResultStatus.ERROR, message: parentResult.message };
  }

  const result = getOrCreateSubfolder(parentResult.data, clubFolderName);
  if (result.status !== ResultStatus.SUCCESS || !result.data) {
    return { status: ResultStatus.ERROR, message: result.message };
  }

  return {
    status: ResultStatus.SUCCESS,
    message: result.message,
    data: { folderId: result.data.getId(), folderName: clubFolderName },
  };
}

// ─── Layer 3: Upload batch folders ────────────────────────────────────────────

/**
 * Creates a Layer 3 upload batch folder inside a club folder.
 * The batchFolderName must be pre-validated (layer: 3).
 *
 * Batch folders are always newly created (never re-used) since each
 * upload session gets a unique timestamp-based name.
 *
 * @param clubFolderId     Drive ID of the Layer 2 club folder
 * @param batchFolderName  Validated batch folder name: YYYYMMDD-HHMMSS_username
 */
export function createBatchFolder(
  clubFolderId: string,
  batchFolderName: string
): ServiceResult<{ folderId: string; folderName: string }> {
  const parentResult = getFolderById(clubFolderId);
  if (parentResult.status !== ResultStatus.SUCCESS || !parentResult.data) {
    return { status: ResultStatus.ERROR, message: parentResult.message };
  }

  const result = createSubfolder(parentResult.data, batchFolderName);
  if (result.status !== ResultStatus.SUCCESS || !result.data) {
    return { status: ResultStatus.ERROR, message: result.message };
  }

  return {
    status: ResultStatus.SUCCESS,
    message: `Batch folder "${batchFolderName}" created`,
    data: { folderId: result.data.getId(), folderName: batchFolderName },
  };
}

// ─── Exception detection ──────────────────────────────────────────────────────

/**
 * Scans the root folder for Layer 1 naming violations.
 * Returns an array of violations (empty = all clean).
 *
 * Checks:
 *   - Folder name matches YYYY-MM-DD_Title_Case_Name pattern
 *   - Date portion is a valid calendar date
 *
 * Performance: makes one Drive API call (list root's children).
 * For a system with <100 events, this completes well within GAS 6-min limit.
 */
export function scanLayer1Violations(): ServiceResult<FolderViolation[]> {
  try {
    const root = getRootFolder();
    const iter = root.getFolders();
    const violations: FolderViolation[] = [];
    const rootName = root.getName();
    const now = nowIsoTimestamp();

    while (iter.hasNext()) {
      const folder = iter.next();
      const name = folder.getName();
      const result = validateFolderName({ folderName: name, layer: 1 });

      if (!result.isValid) {
        violations.push({
          folderName: name,
          folderId: folder.getId(),
          parentFolderName: rootName,
          layer: 1,
          violationType: result.violations.join('; '),
          detectedAt: now,
        });
      }
    }

    return {
      status: ResultStatus.SUCCESS,
      message: `Scanned Layer 1: ${violations.length} violation(s) found`,
      data: violations,
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Layer 1 scan failed: ${String(err)}`,
    };
  }
}

/**
 * Scans all club subfolders within a specific event folder for Layer 2 violations.
 * Checks that each subfolder name matches an approved club name.
 *
 * @param eventFolderId  Drive ID of the Layer 1 event folder to scan
 */
export function scanLayer2Violations(
  eventFolderId: string
): ServiceResult<FolderViolation[]> {
  try {
    const parentResult = getFolderById(eventFolderId);
    if (parentResult.status !== ResultStatus.SUCCESS || !parentResult.data) {
      return { status: ResultStatus.ERROR, message: parentResult.message };
    }

    const eventFolder = parentResult.data;
    const eventFolderName = eventFolder.getName();
    const iter = eventFolder.getFolders();
    const violations: FolderViolation[] = [];
    const approvedNames = APPROVED_CLUBS.map((c) => c.normalizedName);
    const now = nowIsoTimestamp();

    while (iter.hasNext()) {
      const folder = iter.next();
      const name = folder.getName();

      const nameValid = validateFolderName({ folderName: name, layer: 2 });
      const isApproved = approvedNames.includes(name);

      if (!nameValid.isValid || !isApproved) {
        const reasons: string[] = [];
        if (!nameValid.isValid) {
          reasons.push(...nameValid.violations);
        }
        if (!isApproved) {
          reasons.push(`"${name}" is not in the approved clubs list`);
        }
        violations.push({
          folderName: name,
          folderId: folder.getId(),
          parentFolderName: eventFolderName,
          layer: 2,
          violationType: reasons.join('; '),
          detectedAt: now,
        });
      }
    }

    return {
      status: ResultStatus.SUCCESS,
      message: `Scanned Layer 2 in "${eventFolderName}": ${violations.length} violation(s)`,
      data: violations,
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Layer 2 scan failed: ${String(err)}`,
    };
  }
}

/**
 * Runs a full scan of Layer 1 + Layer 2 across all event folders.
 * Combines results from scanLayer1Violations and scanLayer2Violations.
 *
 * WARNING: This makes N+1 Drive API calls (1 for root + 1 per event folder).
 * For large systems, consider caching or running this on a schedule.
 * Phase 4 will add scheduled scans and email alerts.
 */
export function scanAllViolations(): ServiceResult<FolderViolation[]> {
  const allViolations: FolderViolation[] = [];

  // Layer 1 scan
  const layer1Result = scanLayer1Violations();
  if (layer1Result.status === ResultStatus.SUCCESS && layer1Result.data) {
    allViolations.push(...layer1Result.data);
  }

  // Layer 2 scan for each event folder
  const foldersResult = listEventFolders();
  if (foldersResult.status === ResultStatus.SUCCESS && foldersResult.data) {
    for (const folder of foldersResult.data) {
      const layer2Result = scanLayer2Violations(folder.id);
      if (layer2Result.status === ResultStatus.SUCCESS && layer2Result.data) {
        allViolations.push(...layer2Result.data);
      }
    }
  }

  return {
    status: ResultStatus.SUCCESS,
    message: `Full scan complete: ${allViolations.length} total violation(s)`,
    data: allViolations,
  };
}

// ─── Phase 3: Upload flow ─────────────────────────────────────────────────────

/**
 * Represents a single file entry found within a club folder.
 * Used by the file tree view and the duplicate check service.
 */
export interface ClubFolderFileEntry {
  readonly name: string;
  readonly fileId: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;       // ISO 8601 timestamp
  readonly batchFolderName: string;  // Layer 3 folder containing this file
  readonly batchFolderId: string;
}

/**
 * Lists all files within a club folder, one level deep (club → batch → files).
 *
 * Iterates each Layer 3 batch subfolder inside the given club folder and
 * collects every file entry. Returns a flat array sorted by batch folder name
 * (which is also chronological, since names start with YYYYMMDD-HHMMSS).
 *
 * Used by:
 *   - Phase 3 file tree UI (read-only preview of what's already uploaded)
 *   - Phase 3 duplicate check service (compare incoming file vs existing)
 *
 * Performance note: makes 1 Drive API call per batch folder. For a club with
 * 10 upload sessions of 50 files each, this is ~10 API calls — fine for GAS.
 *
 * @param clubFolderId  Drive ID of the Layer 2 club folder
 */
export function listFilesInClubFolder(
  clubFolderId: string
): ServiceResult<ClubFolderFileEntry[]> {
  const parentResult = getFolderById(clubFolderId);
  if (parentResult.status !== ResultStatus.SUCCESS || !parentResult.data) {
    return { status: ResultStatus.ERROR, message: parentResult.message };
  }

  const clubFolder = parentResult.data;
  const entries: ClubFolderFileEntry[] = [];

  try {
    const batchIter = clubFolder.getFolders();
    while (batchIter.hasNext()) {
      const batchFolder = batchIter.next();
      const batchName = batchFolder.getName();
      const batchId = batchFolder.getId();

      const fileIter = batchFolder.getFiles();
      while (fileIter.hasNext()) {
        const file = fileIter.next();
        entries.push({
          name: file.getName(),
          fileId: file.getId(),
          sizeBytes: file.getSize(),
          modifiedAt: file.getLastUpdated().toISOString(),
          batchFolderName: batchName,
          batchFolderId: batchId,
        });
      }
    }

    // Sort by batch folder name (YYYYMMDD-HHMMSS prefix ensures chronological order)
    entries.sort((a, b) => a.batchFolderName.localeCompare(b.batchFolderName));

    return {
      status: ResultStatus.SUCCESS,
      message: `Found ${entries.length} file(s) in club folder`,
      data: entries,
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to list files in club folder "${clubFolderId}": ${String(err)}`,
    };
  }
}

/**
 * Gets the club folder for a specific event (Layer 2), returning its ID
 * and a file listing for the UI tree view. Does NOT create the folder —
 * creation happens only at upload time (getOrCreateClubFolder).
 *
 * Returns null data if no club folder exists yet (user hasn't uploaded before).
 *
 * @param eventFolderId   Drive ID of the Layer 1 event folder
 * @param clubFolderName  Normalized club name (e.g. "New_Bee")
 */
export function getClubFolderTree(
  eventFolderId: string,
  clubFolderName: string
): ServiceResult<{ folderId: string; files: ClubFolderFileEntry[] } | null> {
  const parentResult = getFolderById(eventFolderId);
  if (parentResult.status !== ResultStatus.SUCCESS || !parentResult.data) {
    return { status: ResultStatus.ERROR, message: parentResult.message };
  }

  const eventFolder = parentResult.data;
  const existing = findSubfolder(eventFolder, clubFolderName);

  if (!existing) {
    return {
      status: ResultStatus.SUCCESS,
      message: `No club folder "${clubFolderName}" found — will be created on first upload`,
      data: null,
    };
  }

  const filesResult = listFilesInClubFolder(existing.getId());
  if (filesResult.status !== ResultStatus.SUCCESS || !filesResult.data) {
    return { status: ResultStatus.ERROR, message: filesResult.message };
  }

  return {
    status: ResultStatus.SUCCESS,
    message: `Club folder found with ${filesResult.data.length} file(s)`,
    data: { folderId: existing.getId(), files: filesResult.data },
  };
}

// ─── Contract test helpers ────────────────────────────────────────────────────

/**
 * Verifies that the configured root folder can be accessed.
 * Intended for use in contract tests (clasp run contractTestDriveRoot).
 */
export function verifyRootFolderAccess(): ServiceResult<{ name: string; id: string }> {
  try {
    const root = getRootFolder();
    const name = root.getName();
    const id = root.getId();
    return {
      status: ResultStatus.SUCCESS,
      message: `Root folder accessible: "${name}"`,
      data: { name, id },
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Cannot access root folder: ${String(err)}`,
    };
  }
}
