import { ResultStatus } from '../types/enums';
import { ServiceResult, FolderViolation } from '../types/responses';
import { getConfig } from '../config/constants';
import { listAll as listAllClubs } from './clubService';
import { validateFolderName } from '../utils/folderNameValidator';
import { nowIsoTimestamp } from '../utils/dateFormatter';

/* global DriveApp, PropertiesService, Logger */

/**
 * DriveService — Google Drive folder operations for the file system.
 *
 * Folder hierarchy managed by this service:
 *
 *   <ROOT_FOLDER>                        ← set via Script Property ROOT_FOLDER_ID
 *   └── YYYY-MM-DD_Event_Name/           ← Layer 1: event folder (created by admin)
 *       └── Club_Name/                   ← Layer 2: club folder (auto-created on upload)
 *           └── [tag_name/]              ← Layer 2.5: optional tag subfolder (photographer location)
 *               └── YYYYMMDD-HHMMSS_user/ ← Layer 3: batch folder (auto-created per upload)
 *                   └── photo.jpg
 *
 * The tag subfolder is only created when an upload link has a non-empty tag.
 * Links with no tag write batch folders directly inside the club folder (original behaviour).
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

/**
 * Gets or creates a tag subfolder (Layer 2.5) inside the club folder.
 *
 * Called only when an upload link carries a non-empty tag (e.g. "finish_line").
 * The tag folder sits between the club folder and the batch folder:
 *   Club_Name / tag_name / YYYYMMDD-HHMMSS_user / ...
 *
 * If the folder already exists it is reused (idempotent). No validation of the
 * tag name format is enforced here — the admin UI is responsible for restricting
 * input to safe characters (letters, digits, hyphens, underscores).
 *
 * @param clubFolderId  Drive ID of the Layer 2 club folder
 * @param tagName       Non-empty photographer/location label (e.g. "finish_line")
 */
export function getOrCreateTagFolder(
  clubFolderId: string,
  tagName: string
): ServiceResult<{ folderId: string; folderName: string }> {
  const parentResult = getFolderById(clubFolderId);
  if (parentResult.status !== ResultStatus.SUCCESS || !parentResult.data) {
    return { status: ResultStatus.ERROR, message: parentResult.message };
  }

  const result = getOrCreateSubfolder(parentResult.data, tagName);
  if (result.status !== ResultStatus.SUCCESS || !result.data) {
    return { status: ResultStatus.ERROR, message: result.message };
  }

  return {
    status: ResultStatus.SUCCESS,
    message: result.message,
    data: { folderId: result.data.getId(), folderName: tagName },
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
    const approvedNames = listAllClubs(1, 200).items.map((c) => c.normalizedName);
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

// ─── Drive tree (read-only hierarchy view) ────────────────────────────────────

/** A single batch folder node: Layer 3 inside a club or tag folder. */
export interface BatchTreeNode {
  readonly id:             string;   // Drive folder ID
  readonly name:           string;   // e.g. "20260415-093000_alice"
  readonly fileCount:      number;   // JPEG + PNG + HEIC files in this folder
  readonly totalSizeBytes: number;   // sum of file sizes (photos only)
}

/**
 * A tag subfolder node: Layer 2.5 between a club folder and its batch folders.
 * Only present when an upload link carries a non-empty tag (e.g. "finish_line").
 */
export interface TagTreeNode {
  readonly id:             string;          // Drive folder ID
  readonly name:           string;          // e.g. "finish_line" or "测试"
  readonly batches:        BatchTreeNode[]; // Layer-3 batch folders inside this tag
  readonly totalFiles:     number;          // sum of fileCount across all batches
  readonly totalSizeBytes: number;          // sum of totalSizeBytes across all batches
}

/** A club folder node: Layer 2 inside an event. */
export interface ClubTreeNode {
  readonly id:             string;          // Drive folder ID
  readonly name:           string;          // e.g. "New_Bee"
  readonly batches:        BatchTreeNode[]; // Layer-3 batch folders (no tag / direct uploads)
  readonly tagFolders:     TagTreeNode[];   // Layer-2.5 tag subfolders (tagged uploads)
  readonly totalFiles:     number;          // grand total across direct batches + all tag folders
  readonly totalSizeBytes: number;          // grand total size across direct batches + all tag folders
}

/** The full event tree returned to the browser for one event. */
export interface EventDriveTree {
  readonly eventId:        string;
  readonly driveFolderId:  string;
  readonly clubs:          ClubTreeNode[];  // Layer-2 club folders
  readonly totalFiles:     number;          // grand total across all clubs
  readonly totalSizeBytes: number;          // grand total size across all clubs
}

/** MIME types counted as photos in the tree. */
const PHOTO_MIME_SET = new Set(['image/jpeg', 'image/png', 'image/heic']);

/**
 * Walks the Drive hierarchy for one event and returns a serialisable tree.
 *
 * Hierarchy walked (read-only, no modifications):
 *   Layer 1: event folder  (given by driveFolderId)
 *   Layer 2: club folders  (direct children of the event folder)
 *   Layer 3: batch folders (direct children of each club folder)
 *   Files:   JPEG/PNG/HEIC counted inside each batch folder
 *
 * The returned data is intentionally shallow — no file IDs or sensitive
 * metadata are exposed, only folder names and photo counts.
 *
 * May be slow for events with many clubs/batches; call via google.script.run
 * on-demand (i.e. when the user expands an event node) rather than bulk-loading
 * all events at page load.
 *
 * Results are cached in ScriptProperties for DRIVE_TREE_CACHE_TTL_MS to avoid
 * re-walking the entire folder hierarchy on every page load. Call
 * invalidateEventDriveTreeCache(eventId) after uploads complete so the next
 * open reflects the new files.
 */

const DRIVE_TREE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Regex that matches Layer-3 batch folder names: YYYYMMDD-HHMMSS_username.
 * Used to distinguish batch folders from Layer-2.5 tag subfolders when walking
 * the club folder's immediate children.
 */
const BATCH_FOLDER_RE = /^\d{8}-\d{6}_/;

/**
 * Counts photo files (JPEG, PNG, HEIC) in a batch folder and sums their sizes.
 * Returns { fileCount, totalSizeBytes }.
 */
function countBatchPhotos(
  batchFolder: GoogleAppsScript.Drive.Folder
): { fileCount: number; totalSizeBytes: number } {
  let fileCount = 0;
  let totalSizeBytes = 0;
  const fileIter = batchFolder.getFiles();
  while (fileIter.hasNext()) {
    const file = fileIter.next();
    if (PHOTO_MIME_SET.has(file.getMimeType())) {
      fileCount++;
      totalSizeBytes += file.getSize();
    }
  }
  return { fileCount, totalSizeBytes };
}

function driveTreeCacheKey(eventId: string): string {
  return `drive_tree_cache_${eventId}`;
}

/**
 * Evicts the cached Drive tree for a given event.
 * Call this from the upload-completion path so the admin sees fresh counts.
 */
export function invalidateEventDriveTreeCache(eventId: string): void {
  try {
    PropertiesService.getScriptProperties().deleteProperty(driveTreeCacheKey(eventId));
  } catch {
    // Best-effort; a stale cache entry will expire naturally.
  }
}

export function getEventDriveTree(
  eventId: string,
  driveFolderId: string
): ServiceResult<EventDriveTree> {
  // ── Cache read ──────────────────────────────────────────────────────────────
  const cacheKey = driveTreeCacheKey(eventId);
  try {
    const cached = PropertiesService.getScriptProperties().getProperty(cacheKey);
    if (cached) {
      const entry = JSON.parse(cached) as { ts: number; data: EventDriveTree };
      if (Date.now() - entry.ts < DRIVE_TREE_CACHE_TTL_MS) {
        Logger.log(`[driveService.getEventDriveTree] Cache hit for event ${eventId}`);
        return {
          status: ResultStatus.SUCCESS,
          message: `Tree loaded (cached): ${entry.data.clubs.length} club(s), ${entry.data.totalFiles} photo(s)`,
          data: entry.data,
        };
      }
    }
  } catch {
    // Malformed cache entry — fall through to a fresh Drive walk.
  }

  // ── Fresh Drive walk ────────────────────────────────────────────────────────
  let eventFolder: GoogleAppsScript.Drive.Folder;
  try {
    eventFolder = DriveApp.getFolderById(driveFolderId);
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Cannot access event folder (${driveFolderId}): ${String(err)}`,
    };
  }

  const clubs: ClubTreeNode[] = [];
  let grandTotal = 0;
  let grandTotalSize = 0;

  try {
    const clubIter = eventFolder.getFolders();
    while (clubIter.hasNext()) {
      const clubFolder = clubIter.next();
      const clubName   = clubFolder.getName();
      const batches: BatchTreeNode[]  = [];  // direct (untagged) batch folders
      const tagFolders: TagTreeNode[] = [];  // Layer-2.5 tag subfolders
      let clubTotal     = 0;
      let clubTotalSize = 0;

      const subIter = clubFolder.getFolders();
      while (subIter.hasNext()) {
        const subFolder = subIter.next();
        const subName   = subFolder.getName();

        if (BATCH_FOLDER_RE.test(subName)) {
          // ── Direct batch (no tag) ──────────────────────────────────────────
          const { fileCount, totalSizeBytes } = countBatchPhotos(subFolder);
          batches.push({ id: subFolder.getId(), name: subName, fileCount, totalSizeBytes });
          clubTotal     += fileCount;
          clubTotalSize += totalSizeBytes;
        } else {
          // ── Tag subfolder (Layer 2.5) — recurse for its batches ───────────
          const tagBatches: BatchTreeNode[] = [];
          let tagTotal     = 0;
          let tagTotalSize = 0;

          const batchIter = subFolder.getFolders();
          while (batchIter.hasNext()) {
            const batchFolder = batchIter.next();
            const { fileCount, totalSizeBytes } = countBatchPhotos(batchFolder);
            tagBatches.push({ id: batchFolder.getId(), name: batchFolder.getName(), fileCount, totalSizeBytes });
            tagTotal     += fileCount;
            tagTotalSize += totalSizeBytes;
          }

          // Sort tag batches newest-first
          tagBatches.sort((a, b) => b.name.localeCompare(a.name));
          tagFolders.push({ id: subFolder.getId(), name: subName, batches: tagBatches, totalFiles: tagTotal, totalSizeBytes: tagTotalSize });
          clubTotal     += tagTotal;
          clubTotalSize += tagTotalSize;
        }
      }

      // Sort direct batches newest-first, tag folders alphabetically
      batches.sort((a, b) => b.name.localeCompare(a.name));
      tagFolders.sort((a, b) => a.name.localeCompare(b.name));

      clubs.push({ id: clubFolder.getId(), name: clubName, batches, tagFolders, totalFiles: clubTotal, totalSizeBytes: clubTotalSize });
      grandTotal     += clubTotal;
      grandTotalSize += clubTotalSize;
    }
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Error walking event folder hierarchy: ${String(err)}`,
    };
  }

  // Sort clubs alphabetically
  clubs.sort((a, b) => a.name.localeCompare(b.name));

  const treeData: EventDriveTree = { eventId, driveFolderId, clubs, totalFiles: grandTotal, totalSizeBytes: grandTotalSize };

  // ── Cache write ─────────────────────────────────────────────────────────────
  try {
    PropertiesService.getScriptProperties().setProperty(
      cacheKey,
      JSON.stringify({ ts: Date.now(), data: treeData })
    );
  } catch {
    // Non-fatal: cache write failure (e.g. PropertiesService quota) is fine.
  }

  return {
    status: ResultStatus.SUCCESS,
    message: `Tree loaded: ${clubs.length} club(s), ${grandTotal} photo(s)`,
    data: treeData,
  };
}

// ─── Batch folder deletion ────────────────────────────────────────────────────

/**
 * Moves a Layer 3 batch folder to Drive trash (soft delete).
 *
 * Safety checks performed before trashing:
 *   1. The folder exists and is accessible.
 *   2. Its name matches the Layer-3 batch pattern (YYYYMMDD-HHMMSS_username).
 *   3. Walking up the parent chain confirms the folder sits inside a club folder
 *      whose name equals `claimedClubName` (direct batch or via a tag subfolder).
 *
 * Returns SUCCESS with the folder name, or ERROR with a descriptive message.
 * Does NOT invalidate the drive-tree cache — callers are responsible for that.
 *
 * @param batchFolderId   Drive ID of the Layer-3 batch folder to trash
 * @param claimedClubName Normalized club name the caller asserts owns the folder
 */
export function trashBatchFolder(
  batchFolderId: string,
  claimedClubName: string
): ServiceResult<{ folderName: string }> {
  try {
    // 1 — Fetch the folder.
    const folderResult = getFolderById(batchFolderId);
    if (folderResult.status !== ResultStatus.SUCCESS || !folderResult.data) {
      return { status: ResultStatus.ERROR, message: folderResult.message };
    }
    const batchFolder = folderResult.data;
    const batchName   = batchFolder.getName();

    // 2 — Confirm it looks like a Layer-3 batch folder.
    if (!BATCH_FOLDER_RE.test(batchName)) {
      return {
        status: ResultStatus.ERROR,
        message: `"${batchName}" is not a batch folder (expected YYYYMMDD-HHMMSS_username format).`,
      };
    }

    // 3 — Walk the parent chain to verify club ownership.
    //     Structure is either:  EventFolder / ClubFolder / BatchFolder
    //                       or: EventFolder / ClubFolder / TagFolder / BatchFolder
    const parentIter = batchFolder.getParents();
    if (!parentIter.hasNext()) {
      return { status: ResultStatus.ERROR, message: 'Batch folder has no parent — cannot verify club ownership.' };
    }
    const immediateParent     = parentIter.next();
    const immediateParentName = immediateParent.getName();

    let resolvedClubName: string;
    if (immediateParentName === claimedClubName) {
      // Direct batch inside the club folder (no tag subfolder).
      resolvedClubName = immediateParentName;
    } else {
      // Possibly inside a tag subfolder — check the grandparent.
      const grandParentIter = immediateParent.getParents();
      if (!grandParentIter.hasNext()) {
        return { status: ResultStatus.ERROR, message: 'Could not verify club ownership: tag folder has no parent.' };
      }
      resolvedClubName = grandParentIter.next().getName();
    }

    if (resolvedClubName !== claimedClubName) {
      return {
        status: ResultStatus.ERROR,
        message: `Ownership check failed: folder belongs to club "${resolvedClubName}", not "${claimedClubName}".`,
      };
    }

    // 4 — Trash the folder.
    batchFolder.setTrashed(true);

    Logger.log(
      `[driveService.trashBatchFolder] "${batchName}" (${batchFolderId}) ` +
      `trashed — club="${claimedClubName}"`
    );

    return {
      status: ResultStatus.SUCCESS,
      message: `Batch folder "${batchName}" moved to Drive trash.`,
      data: { folderName: batchName },
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to trash batch folder: ${String(err)}`,
    };
  }
}

// ─── Tag / club folder deletion ──────────────────────────────────────────────

/** Managed folder name prefixes that are not user content and exempt from the empty-check. */
function isManagedFolder(name: string): boolean {
  return name === 'Videos' || name.startsWith('Photos_');
}

/**
 * Moves a tag (Layer-2.5) or club (Layer-2) folder to Drive trash.
 *
 * Safety checks before trashing:
 *   1. Folder exists and is accessible.
 *   2. No user-content subfolders remain inside it — managed folders (Videos/,
 *      Photos_NNN/) are exempt. If any real subfolder is still present the call
 *      is rejected so admins must clean up children first.
 *   3. Parent-chain walk confirms the folder belongs to `claimedClubName`.
 *
 * @param folderId        Drive ID of the tag or club folder to trash
 * @param folderType      'tag' | 'club' — for log messages and ownership check
 * @param claimedClubName Normalized club name the caller asserts this folder belongs to
 */
export function trashScopeFolder(
  folderId: string,
  folderType: 'tag' | 'club',
  claimedClubName: string
): ServiceResult<{ folderName: string }> {
  try {
    const folderResult = getFolderById(folderId);
    if (folderResult.status !== ResultStatus.SUCCESS || !folderResult.data) {
      return { status: ResultStatus.ERROR, message: folderResult.message };
    }
    const folder     = folderResult.data;
    const folderName = folder.getName();

    // Check no user-content subfolders remain.
    const subIter = folder.getFolders();
    while (subIter.hasNext()) {
      const sub = subIter.next();
      if (!isManagedFolder(sub.getName())) {
        return {
          status: ResultStatus.ERROR,
          message:
            `"${folderName}" still contains subfolder "${sub.getName()}". ` +
            'Delete all inner folders first.',
        };
      }
    }

    // Verify club ownership.
    // Club folder: the folder itself is named after the club.
    // Tag folder:  immediate parent is the club folder.
    let resolvedClubName: string;
    if (folderType === 'club') {
      resolvedClubName = folderName;
    } else {
      const parentIter = folder.getParents();
      if (!parentIter.hasNext()) {
        return { status: ResultStatus.ERROR, message: 'Tag folder has no parent — cannot verify club ownership.' };
      }
      resolvedClubName = parentIter.next().getName();
    }

    if (resolvedClubName !== claimedClubName) {
      return {
        status: ResultStatus.ERROR,
        message: `Ownership check failed: folder belongs to club "${resolvedClubName}", not "${claimedClubName}".`,
      };
    }

    folder.setTrashed(true);

    Logger.log(
      `[driveService.trashScopeFolder] ${folderType}="${folderName}" (${folderId}) ` +
      `trashed — club="${claimedClubName}"`
    );

    return {
      status: ResultStatus.SUCCESS,
      message: `${folderType === 'club' ? 'Club' : 'Tag'} folder "${folderName}" moved to Drive trash.`,
      data: { folderName },
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to trash ${folderType} folder: ${String(err)}`,
    };
  }
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

