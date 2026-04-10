# Phase 3 — Upload Flow: Detailed Development Plan

**Project**: 湘舍动公益文件系统 v1.0 (GAS)
**Phase**: 3 of 5 — Upload Flow
**Timeline**: Week 3–5
**Goal**: Users can select an event, browse their club's existing files, pick photos from their device, and upload them end-to-end with duplicate detection, type filtering, and audit logging.

---

## 1. Phase 2 Recap — What We're Building On

Phase 2 delivered event management. Phase 3 is the first feature that general (non-admin) users interact with directly. Here is what already exists that Phase 3 will consume:

### 1.1 Types Already Defined

| Type | File | Status |
|------|------|--------|
| `UploadLogRecord` | `src/types/models.ts` | Complete — all 12 fields defined |
| `UploadSource` | `src/types/enums.ts` | Complete — `web_app` / `api` |
| `PhotoMimeType` | `src/types/enums.ts` | Complete — JPEG / PNG / HEIC |
| `RouteAction.UPLOAD` | `src/types/enums.ts` | Defined but not wired to any handler |
| `COLUMNS.UPLOAD_LOG` | `src/config/constants.ts` | Complete — all 12 column indices mapped |
| `toUploadLogRecord` / `fromUploadLogRecord` | `src/utils/sheetMapper.ts` | Complete — roundtrip tested |

### 1.2 Services Already Implemented

| Function | File | What It Does |
|----------|------|-------------|
| `getOrCreateClubFolder(eventFolderId, clubName)` | `driveService.ts` | Idempotent Layer 2 club folder creation |
| `createBatchFolder(clubFolderId, batchName)` | `driveService.ts` | Creates Layer 3 upload batch folder |
| `getFolderById(folderId)` | `driveService.ts` | Returns a folder by Drive ID |
| `findSubfolder(parent, name)` | `driveService.ts` | Checks if a named subfolder exists |
| `listEventFolders()` | `driveService.ts` | Lists all Layer 1 event folders |
| `validateFolderName(input)` | `folderNameValidator.ts` | Validates all 3 folder layers |
| `getAllRows(sheetName)` | `sheetService.ts` | Reads all data rows from a sheet |
| `appendRow(sheetName, row)` | `sheetService.ts` | Appends a row to a sheet |
| `getConfig()` | `constants.ts` | Returns config with `PHOTO_MIME_TYPES`, `MAX_FILE_SIZE_MB`, `MAX_BATCH_SIZE_MB` |

### 1.3 UI Already Stubbed

The dashboard (`dashboard.html`) has an "Upload Photos" tile that links to `?action=upload` (visible to all users). The route action `UPLOAD` exists in the `RouteAction` enum and in `GET_ROUTES` is missing — Phase 3 must register it.

### 1.4 What Phase 3 Must Add

```
New files:
  src/services/uploadService.ts           — Upload orchestration + duplicate check
  src/services/fileService.ts             — File listing + metadata extraction from Drive
  src/ui/templates/upload.html            — Upload page (event picker → file browser → uploader → summary)
  src/ui/js/upload.html                   — Client-side upload logic (wrapped in <script> for GAS)
  tests/unit/uploadService.test.ts        — Unit tests for upload pipeline
  tests/unit/fileService.test.ts          — Unit tests for file listing + duplicate check
  tests/integration/uploadFlow.test.ts    — Integration test: event select → upload → log written

Modified files:
  src/types/enums.ts                      — Add UPLOAD_PHOTOS, LIST_CLUB_FILES route actions
  src/types/requests.ts                   — Add UploadPhotoInput, ListClubFilesInput
  src/types/responses.ts                  — Add UploadResult, FileListItem, UploadSummary
  src/routes/router.ts                    — Register upload page route + API routes
  src/routes/pageRoutes.ts                — Add uploadPage handler
  src/routes/apiRoutes.ts                 — Add upload + file listing API handlers
  src/main.ts                             — Add serverUploadPhoto, serverListClubFiles, serverGetUploadHistory
  src/config/constants.ts                 — Add upload-related constants (chunk size, timeout thresholds)
  tests/mocks/gasGlobals.ts               — Extend mocks for Drive file operations + Blob
```

---

## 2. New & Modified Type Definitions

### 2.1 New Route Actions — src/types/enums.ts

Add these to the existing `RouteAction` enum:

```typescript
export enum RouteAction {
  // ... existing Phase 1 + Phase 2 actions ...

  // Phase 3 — Upload Flow
  UPLOAD_PHOTOS = 'upload_photos',
  LIST_CLUB_FILES = 'list_club_files',
  GET_UPLOAD_HISTORY = 'get_upload_history',
}
```

`UPLOAD` (the page route) already exists. The three new entries are API actions for `doPost` / `google.script.run`.

### 2.2 New Request DTOs — src/types/requests.ts

```typescript
/**
 * Input DTO for uploading a single photo (Phase 3).
 * Files are sent one at a time from the browser to stay within the
 * GAS 50MB payload limit and avoid 6-minute execution timeout.
 *
 * The browser reads each file into a base64 string using FileReader.
 * The server decodes it, validates MIME type and size, then writes
 * to Google Drive.
 */
export interface UploadPhotoInput {
  readonly eventId: string;           // FK → EventRecord.eventId
  readonly fileName: string;          // Original filename from the user's device
  readonly mimeType: string;          // MIME type reported by the browser
  readonly base64Data: string;        // Base64-encoded file content
  readonly fileSizeBytes: number;     // Original file size (for audit and duplicate check)
  readonly lastModified: number;      // File.lastModified timestamp (ms since epoch)
}

/**
 * Input DTO for listing files in a club's subfolder for a given event.
 * Used by the file browser panel to show existing uploads.
 */
export interface ListClubFilesInput {
  readonly eventId: string;           // FK → EventRecord.eventId
}

/**
 * Input DTO for starting an upload session.
 * Called once before the per-file uploads begin. Creates the batch folder
 * and returns the batch context that the browser passes to each upload call.
 */
export interface StartUploadSessionInput {
  readonly eventId: string;
  readonly fileCount: number;         // Total files the user selected (for progress tracking)
  readonly totalSizeBytes: number;    // Total bytes across all selected files
}
```

### 2.3 New Response Types — src/types/responses.ts

```typescript
import { UploadLogRecord } from './models';

/**
 * Metadata for a single file in a club's Drive folder.
 * Returned by the file listing service for the file browser UI.
 */
export interface FileListItem {
  readonly fileName: string;
  readonly fileId: string;            // Google Drive file ID
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly lastModified: string;      // ISO 8601 timestamp from Drive
  readonly batchFolderName: string;   // Parent Layer 3 folder name
  readonly thumbnailUrl: string | null; // Drive thumbnail URL (may be null for HEIC)
}

/**
 * Result of a single photo upload attempt.
 * The browser accumulates these to build the final summary.
 */
export interface SingleUploadResult {
  readonly fileName: string;
  readonly status: 'uploaded' | 'skipped_duplicate' | 'skipped_type' | 'skipped_size' | 'error';
  readonly reason?: string;           // Human-readable reason for skip/error
  readonly fileId?: string;           // Drive file ID if uploaded successfully
  readonly sizeBytes: number;
}

/**
 * Aggregate summary shown to the user after all files are processed.
 * Built client-side from accumulated SingleUploadResult values.
 */
export interface UploadSummary {
  readonly eventName: string;
  readonly clubName: string;
  readonly batchFolderName: string;
  readonly uploaded: number;          // Files successfully written to Drive
  readonly skippedDuplicates: number; // Files skipped due to duplicate detection
  readonly skippedNonPhoto: number;   // Files skipped due to wrong MIME type
  readonly skippedOversize: number;   // Files exceeding MAX_FILE_SIZE_MB
  readonly errors: number;            // Files that failed unexpectedly
  readonly totalSizeMb: number;       // Total size of successfully uploaded files
  readonly durationSeconds: number;   // Wall-clock time for the upload session
}

/**
 * Server response for the startUploadSession call.
 * Contains the batch context the browser needs for subsequent per-file calls.
 */
export interface UploadSessionContext {
  readonly batchFolderName: string;   // YYYYMMDD-HHMMSS_username
  readonly batchFolderId: string;     // Drive folder ID for this batch
  readonly clubFolderId: string;      // Drive folder ID for the club subfolder
  readonly clubName: string;          // Normalized club name
  readonly eventName: string;         // For display in the summary
}

/**
 * A single file's fingerprint used for duplicate detection.
 * Compared against files already in the club's Drive folder.
 */
export interface FileFingerprint {
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly lastModified: string;      // ISO 8601 timestamp
}
```

---

## 3. Upload Service — src/services/uploadService.ts

This is the core new module for Phase 3. It orchestrates the entire upload pipeline: session management, per-file validation, duplicate checking, Drive writing, and audit logging.

```typescript
import { ResultStatus, UploadSource, PhotoMimeType } from '../types/enums';
import { UploadLogRecord } from '../types/models';
import {
  UploadPhotoInput,
  StartUploadSessionInput,
} from '../types/requests';
import {
  ServiceResult,
  SingleUploadResult,
  UploadSessionContext,
  FileFingerprint,
} from '../types/responses';
import { getConfig, APPROVED_CLUBS } from '../config/constants';
import { appendRow } from './sheetService';
import { fromUploadLogRecord } from '../utils/sheetMapper';
import { generateUuid } from '../utils/uuid';
import { nowIsoTimestamp } from '../utils/dateFormatter';
import { findById as findEventById } from './eventService';
import {
  getFolderById,
  getOrCreateClubFolder,
  createBatchFolder,
} from './driveService';
import { listFilesInClubFolder } from './fileService';

/* global Utilities, Session */

// ─── Constants ───────────────────────────────────────────────────────────────

const ACCEPTED_MIME_TYPES: ReadonlySet<string> = new Set(
  Object.values(PhotoMimeType)
);

// ─── Session management ──────────────────────────────────────────────────────

/**
 * Starts an upload session: validates the event, resolves the user's
 * club folder, and creates a fresh batch folder.
 *
 * This is called once before per-file uploads begin. The returned
 * UploadSessionContext is passed to every subsequent uploadSinglePhoto call.
 *
 * Steps:
 *   1. Validate the event exists
 *   2. Look up the user's club from their UserRecord
 *   3. Get-or-create the club subfolder in the event folder
 *   4. Generate a batch folder name: YYYYMMDD-HHMMSS_username
 *   5. Create the batch folder in Drive
 *   6. Return the session context
 *
 * @param input       Session parameters (eventId, file count, total size)
 * @param userEmail   Authenticated user's email
 * @param userClub    User's normalized club name (from UserRecord)
 */
export function startUploadSession(
  input: StartUploadSessionInput,
  userEmail: string,
  userClub: string
): ServiceResult<UploadSessionContext> {
  // 1. Validate event
  const event = findEventById(input.eventId);
  if (!event) {
    return {
      status: ResultStatus.ERROR,
      message: `Event "${input.eventId}" not found`,
    };
  }

  // 2. Validate club
  const clubEntry = APPROVED_CLUBS.find(
    (c) => c.normalizedName === userClub
  );
  if (!clubEntry) {
    return {
      status: ResultStatus.ERROR,
      message: `Club "${userClub}" is not in the approved clubs list`,
    };
  }

  // Check total batch size against soft limit
  const config = getConfig();
  const totalSizeMb = input.totalSizeBytes / (1024 * 1024);
  if (totalSizeMb > config.MAX_BATCH_SIZE_MB) {
    return {
      status: ResultStatus.ERROR,
      message: `Total upload size (${totalSizeMb.toFixed(1)} MB) exceeds the ${config.MAX_BATCH_SIZE_MB} MB limit per session. Please upload in smaller batches.`,
    };
  }

  // 3. Get-or-create club folder
  const clubResult = getOrCreateClubFolder(
    event.driveFolderId,
    clubEntry.normalizedName
  );
  if (clubResult.status !== ResultStatus.SUCCESS || !clubResult.data) {
    return { status: ResultStatus.ERROR, message: clubResult.message };
  }

  // 4. Generate batch folder name
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const timestamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const username = userEmail.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_');
  const batchFolderName = `${timestamp}_${username}`;

  // 5. Create batch folder
  const batchResult = createBatchFolder(
    clubResult.data.folderId,
    batchFolderName
  );
  if (batchResult.status !== ResultStatus.SUCCESS || !batchResult.data) {
    return { status: ResultStatus.ERROR, message: batchResult.message };
  }

  // 6. Return context
  return {
    status: ResultStatus.SUCCESS,
    message: `Upload session started: ${batchFolderName}`,
    data: {
      batchFolderName,
      batchFolderId: batchResult.data.folderId,
      clubFolderId: clubResult.data.folderId,
      clubName: clubEntry.normalizedName,
      eventName: event.eventName,
    },
  };
}

// ─── Per-file upload ─────────────────────────────────────────────────────────

/**
 * Uploads a single photo to the batch folder in Drive.
 *
 * Validation pipeline (in order):
 *   1. MIME type check — must be in ACCEPTED_MIME_TYPES
 *   2. File size check — must be under MAX_FILE_SIZE_MB
 *   3. Duplicate check — filename + size + lastModified vs existing files
 *   4. Write to Drive — decode base64 → create Blob → create file
 *
 * Any validation failure returns a SingleUploadResult with the appropriate
 * skip status rather than an error. True errors (Drive API failures) return
 * status: 'error'.
 *
 * @param input            File payload (base64 + metadata)
 * @param batchFolderId    Drive ID of the batch folder (from UploadSessionContext)
 * @param existingFiles    Fingerprints of all files already in the club folder
 */
export function uploadSinglePhoto(
  input: UploadPhotoInput,
  batchFolderId: string,
  existingFiles: ReadonlyArray<FileFingerprint>
): SingleUploadResult {
  // 1. MIME type check
  if (!ACCEPTED_MIME_TYPES.has(input.mimeType)) {
    return {
      fileName: input.fileName,
      status: 'skipped_type',
      reason: `Unsupported file type: ${input.mimeType}. Accepted: JPG, PNG, HEIC.`,
      sizeBytes: input.fileSizeBytes,
    };
  }

  // 2. File size check
  const config = getConfig();
  const fileSizeMb = input.fileSizeBytes / (1024 * 1024);
  if (fileSizeMb > config.MAX_FILE_SIZE_MB) {
    return {
      fileName: input.fileName,
      status: 'skipped_size',
      reason: `File size (${fileSizeMb.toFixed(1)} MB) exceeds the ${config.MAX_FILE_SIZE_MB} MB limit.`,
      sizeBytes: input.fileSizeBytes,
    };
  }

  // 3. Duplicate check (filename + size + lastModified)
  const lastModifiedIso = new Date(input.lastModified).toISOString();
  const isDuplicate = existingFiles.some(
    (f) =>
      f.fileName === input.fileName &&
      f.sizeBytes === input.fileSizeBytes &&
      f.lastModified === lastModifiedIso
  );
  if (isDuplicate) {
    return {
      fileName: input.fileName,
      status: 'skipped_duplicate',
      reason: `Duplicate detected: "${input.fileName}" with same size and modification time already exists.`,
      sizeBytes: input.fileSizeBytes,
    };
  }

  // 4. Write to Drive
  try {
    const decoded = Utilities.base64Decode(input.base64Data);
    const blob = Utilities.newBlob(decoded, input.mimeType, input.fileName);
    const batchFolder = getFolderById(batchFolderId);
    if (batchFolder.status !== ResultStatus.SUCCESS || !batchFolder.data) {
      return {
        fileName: input.fileName,
        status: 'error',
        reason: `Batch folder not accessible: ${batchFolder.message}`,
        sizeBytes: input.fileSizeBytes,
      };
    }

    const file = batchFolder.data.createFile(blob);
    return {
      fileName: input.fileName,
      status: 'uploaded',
      fileId: file.getId(),
      sizeBytes: input.fileSizeBytes,
    };
  } catch (err) {
    return {
      fileName: input.fileName,
      status: 'error',
      reason: `Upload failed: ${String(err)}`,
      sizeBytes: input.fileSizeBytes,
    };
  }
}

// ─── Upload log ──────────────────────────────────────────────────────────────

/**
 * Writes the upload summary to the Upload_Log sheet after all files
 * in a session have been processed.
 *
 * This is called once at the end, not per-file. The caller aggregates
 * all SingleUploadResult values into the counts passed here.
 *
 * @param session         The upload session context
 * @param eventId         Event ID for the FK
 * @param userEmail       Uploader's email
 * @param uploadedCount   Number of files successfully uploaded
 * @param totalSizeMb     Total size of uploaded files in MB
 * @param skippedDups     Number of files skipped as duplicates
 * @param skippedNonPhoto Number of files skipped due to wrong MIME type
 */
export function writeUploadLog(
  session: UploadSessionContext,
  eventId: string,
  userEmail: string,
  uploadedCount: number,
  totalSizeMb: number,
  skippedDups: number,
  skippedNonPhoto: number
): ServiceResult<UploadLogRecord> {
  const record: UploadLogRecord = {
    logId: generateUuid(),
    eventId,
    clubName: session.clubName,
    uploadedBy: userEmail.trim().toLowerCase(),
    batchFolderName: session.batchFolderName,
    batchFolderId: session.batchFolderId,
    fileCount: uploadedCount,
    totalSizeMb: Math.round(totalSizeMb * 100) / 100,
    skippedDuplicates: skippedDups,
    skippedNonPhoto,
    uploadTimestamp: nowIsoTimestamp(),
    source: UploadSource.WEB_APP,
  };

  try {
    const config = getConfig();
    appendRow(config.SHEET_NAMES.UPLOAD_LOG, fromUploadLogRecord(record));
    return {
      status: ResultStatus.SUCCESS,
      message: `Upload log written: ${uploadedCount} file(s), ${totalSizeMb.toFixed(1)} MB`,
      data: record,
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to write upload log: ${String(err)}`,
    };
  }
}
```

### 3.1 Design Decisions

| Decision | Rationale |
|----------|-----------|
| **One file at a time from browser** | GAS has a 50MB payload limit on `google.script.run` and a 6-minute execution timeout. Sending files individually keeps each call short and lets the browser show real-time progress. If one file fails, the rest can still succeed. |
| **Session start creates batch folder eagerly** | The batch folder is created before any files are uploaded. If the entire upload is cancelled, an empty batch folder in Drive is harmless and visible for reconciliation. |
| **Duplicate detection uses name + size + lastModified** | True content hashing (MD5/SHA) requires reading existing Drive files byte-by-byte, which is prohibitively slow over the Drive API. The filename + size + lastModified triple is a practical compromise that catches re-uploads reliably. EXIF-based detection is deferred to v2. |
| **Batch size soft limit (200 MB)** | Prevents users from starting sessions that will inevitably timeout. The limit is checked once at session start rather than accumulating per-file to avoid race conditions. |
| **Upload log written once at end** | Writing a row per file would be noisy and slow. A single summary row per batch matches the `Upload_Log` schema design from the project plan. |
| **Base64 encoding doubles payload size** | GAS `google.script.run` can only transfer strings and JSON — no binary blobs. Base64 is the standard workaround. The 50MB Drive limit effectively becomes ~33MB usable per file after encoding overhead. The UI warns users accordingly. |

---

## 4. File Service — src/services/fileService.ts

This service provides read-only file listing and metadata extraction from Google Drive. It powers the file browser panel in the upload UI and provides the fingerprint data for duplicate detection.

```typescript
import { ResultStatus } from '../types/enums';
import {
  ServiceResult,
  FileListItem,
  FileFingerprint,
} from '../types/responses';
import { findById as findEventById } from './eventService';
import { getFolderById, findSubfolder } from './driveService';
import { APPROVED_CLUBS } from '../config/constants';

/* global DriveApp */

/**
 * Lists all files in a club's subfolder tree for a given event.
 * Traverses all Layer 3 batch folders and collects file metadata.
 *
 * The result is sorted newest-first by batch folder name (which contains
 * a timestamp prefix), so the most recent uploads appear at the top
 * of the file browser.
 *
 * @param eventId     Event to browse
 * @param clubName    Normalized club name
 */
export function listFilesInClubFolder(
  eventId: string,
  clubName: string
): ServiceResult<FileListItem[]> {
  // Validate event
  const event = findEventById(eventId);
  if (!event) {
    return {
      status: ResultStatus.ERROR,
      message: `Event "${eventId}" not found`,
    };
  }

  // Get event folder
  const eventFolderResult = getFolderById(event.driveFolderId);
  if (eventFolderResult.status !== ResultStatus.SUCCESS || !eventFolderResult.data) {
    return { status: ResultStatus.ERROR, message: eventFolderResult.message };
  }

  // Find club subfolder
  const clubFolder = findSubfolder(eventFolderResult.data, clubName);
  if (!clubFolder) {
    // No club folder yet — return empty list (not an error)
    return {
      status: ResultStatus.SUCCESS,
      message: `No uploads yet for "${clubName}" in this event`,
      data: [],
    };
  }

  // Traverse batch folders
  try {
    const files: FileListItem[] = [];
    const batchIter = clubFolder.getFolders();

    while (batchIter.hasNext()) {
      const batchFolder = batchIter.next();
      const batchName = batchFolder.getName();
      const fileIter = batchFolder.getFiles();

      while (fileIter.hasNext()) {
        const file = fileIter.next();
        files.push({
          fileName: file.getName(),
          fileId: file.getId(),
          mimeType: file.getMimeType(),
          sizeBytes: file.getSize(),
          lastModified: file.getLastUpdated().toISOString(),
          batchFolderName: batchName,
          thumbnailUrl: file.getThumbnail()
            ? `https://drive.google.com/thumbnail?id=${file.getId()}&sz=w200`
            : null,
        });
      }
    }

    // Sort newest batch first (batch names start with YYYYMMDD-HHMMSS)
    files.sort((a, b) => b.batchFolderName.localeCompare(a.batchFolderName));

    return {
      status: ResultStatus.SUCCESS,
      message: `Found ${files.length} file(s) for "${clubName}"`,
      data: files,
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to list files for "${clubName}": ${String(err)}`,
    };
  }
}

/**
 * Returns fingerprints of all files in a club's subfolder tree.
 * Used by the duplicate detection pipeline.
 *
 * This is a lighter-weight call than listFilesInClubFolder because
 * it skips thumbnail URLs and other display metadata.
 *
 * @param eventId     Event to check
 * @param clubName    Normalized club name
 */
export function getExistingFileFingerprints(
  eventId: string,
  clubName: string
): ServiceResult<FileFingerprint[]> {
  const event = findEventById(eventId);
  if (!event) {
    return {
      status: ResultStatus.ERROR,
      message: `Event "${eventId}" not found`,
    };
  }

  const eventFolderResult = getFolderById(event.driveFolderId);
  if (eventFolderResult.status !== ResultStatus.SUCCESS || !eventFolderResult.data) {
    return { status: ResultStatus.ERROR, message: eventFolderResult.message };
  }

  const clubFolder = findSubfolder(eventFolderResult.data, clubName);
  if (!clubFolder) {
    return {
      status: ResultStatus.SUCCESS,
      message: 'No existing files',
      data: [],
    };
  }

  try {
    const fingerprints: FileFingerprint[] = [];
    const batchIter = clubFolder.getFolders();

    while (batchIter.hasNext()) {
      const batchFolder = batchIter.next();
      const fileIter = batchFolder.getFiles();

      while (fileIter.hasNext()) {
        const file = fileIter.next();
        fingerprints.push({
          fileName: file.getName(),
          sizeBytes: file.getSize(),
          lastModified: file.getLastUpdated().toISOString(),
        });
      }
    }

    return {
      status: ResultStatus.SUCCESS,
      message: `Found ${fingerprints.length} existing file(s)`,
      data: fingerprints,
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to read file fingerprints: ${String(err)}`,
    };
  }
}

/**
 * Returns the upload history for a specific club in a specific event.
 * Reads from the Upload_Log sheet rather than Drive to get audit metadata.
 *
 * @param eventId     Event to query
 * @param clubName    Normalized club name
 */
export function getUploadHistory(
  eventId: string,
  clubName: string
): ServiceResult<import('../types/models').UploadLogRecord[]> {
  try {
    const { getAllRows } = require('./sheetService');
    const { toUploadLogRecord } = require('../utils/sheetMapper');
    const config = require('../config/constants').getConfig();

    const rows = getAllRows(config.SHEET_NAMES.UPLOAD_LOG);
    const records = rows
      .map(toUploadLogRecord)
      .filter(
        (r: import('../types/models').UploadLogRecord | null): r is import('../types/models').UploadLogRecord =>
          r !== null &&
          r.eventId === eventId &&
          r.clubName === clubName
      )
      .sort(
        (a: import('../types/models').UploadLogRecord, b: import('../types/models').UploadLogRecord) =>
          b.uploadTimestamp.localeCompare(a.uploadTimestamp)
      );

    return {
      status: ResultStatus.SUCCESS,
      message: `Found ${records.length} upload log(s)`,
      data: records,
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to read upload history: ${String(err)}`,
    };
  }
}
```

### 4.1 Design Decisions

| Decision | Rationale |
|----------|-----------|
| **File listing traverses Drive, not Sheets** | The Upload_Log records batch-level data (counts, sizes), not per-file data. Drive is the source of truth for what files actually exist. |
| **Empty club folder returns success with empty array** | A missing club folder is normal (no uploads yet). Returning an error would force the UI to distinguish "real error" from "no data" unnecessarily. |
| **Separate fingerprint function** | `listFilesInClubFolder` fetches display metadata (thumbnails, etc.) which is slow. Duplicate detection needs only name + size + lastModified, so `getExistingFileFingerprints` is a lighter call. |
| **Thumbnail URL uses Drive's built-in thumbnail endpoint** | Avoids downloading full images. The `?sz=w200` parameter returns a 200px-wide thumbnail. HEIC files may not have thumbnails — the UI shows a placeholder icon. |

---

## 5. Route Wiring

### 5.1 Router Changes — src/routes/router.ts

Add the upload page and API routes:

```typescript
// Add to GET_ROUTES
const GET_ROUTES: Readonly<Record<string, RouteConfig>> = {
  // ... existing routes ...
  [RouteAction.UPLOAD]: { requiredRole: null },  // All authenticated users
};

// Add to POST_ROUTES
const POST_ROUTES: Readonly<Record<string, RouteConfig>> = {
  // ... existing routes ...
  [RouteAction.UPLOAD_PHOTOS]:      { requiredRole: null },
  [RouteAction.LIST_CLUB_FILES]:    { requiredRole: null },
  [RouteAction.GET_UPLOAD_HISTORY]: { requiredRole: null },
};
```

Add to `dispatchGetHandler`:

```typescript
function dispatchGetHandler(
  action: RouteAction,
  user: UserRecord
): GoogleAppsScript.HTML.HtmlOutput {
  switch (action) {
    // ... existing cases ...
    case RouteAction.UPLOAD:
      return uploadPage(user);
    default:
      return notFoundPage(action);
  }
}
```

Add to `dispatchPostHandler`:

```typescript
function dispatchPostHandler(
  action: RouteAction,
  payload: Record<string, unknown>,
  user: UserRecord
): GoogleAppsScript.Content.TextOutput {
  switch (action) {
    // ... existing cases ...
    case RouteAction.UPLOAD_PHOTOS:
      return handleUploadPhoto(payload, user);
    case RouteAction.LIST_CLUB_FILES:
      return handleListClubFiles(payload, user);
    case RouteAction.GET_UPLOAD_HISTORY:
      return handleGetUploadHistory(payload, user);
    default:
      return handleUnknownAction(action);
  }
}
```

### 5.2 API Route Handlers — src/routes/apiRoutes.ts

```typescript
import {
  startUploadSession,
  uploadSinglePhoto,
  writeUploadLog,
} from '../services/uploadService';
import {
  listFilesInClubFolder,
  getExistingFileFingerprints,
  getUploadHistory,
} from '../services/fileService';

/**
 * POST action=upload_photos
 * Handles both session-start and per-file upload based on payload shape.
 *
 * If payload contains `startSession: true`, creates a new upload session.
 * Otherwise, uploads a single file to an existing session.
 */
export function handleUploadPhoto(
  payload: Record<string, unknown>,
  user: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const clean = sanitizePayload(payload);

  // Branch: start session vs upload file
  if (clean['startSession'] === true) {
    return handleStartUploadSession(clean, user);
  }

  return handleSingleFileUpload(clean, user);
}

function handleStartUploadSession(
  payload: Record<string, unknown>,
  user: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const eventId = String(payload['eventId'] ?? '').trim();
  const fileCount = Number(payload['fileCount']) || 0;
  const totalSizeBytes = Number(payload['totalSizeBytes']) || 0;

  if (!eventId) {
    return jsonError('eventId is required', 400);
  }

  const result = startUploadSession(
    { eventId, fileCount, totalSizeBytes },
    user.email,
    user.runningClub
  );

  if (result.status !== ResultStatus.SUCCESS) {
    return jsonError(result.message, 400);
  }

  // Also fetch existing file fingerprints for duplicate detection
  const fingerprints = getExistingFileFingerprints(eventId, user.runningClub);

  return jsonOk({
    session: result.data,
    existingFiles: fingerprints.data ?? [],
  }, result.message);
}

function handleSingleFileUpload(
  payload: Record<string, unknown>,
  user: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const batchFolderId = String(payload['batchFolderId'] ?? '').trim();
  const fileName = String(payload['fileName'] ?? '').trim();
  const mimeType = String(payload['mimeType'] ?? '').trim();
  const base64Data = String(payload['base64Data'] ?? '');
  const fileSizeBytes = Number(payload['fileSizeBytes']) || 0;
  const lastModified = Number(payload['lastModified']) || 0;

  if (!batchFolderId || !fileName || !base64Data) {
    return jsonError('batchFolderId, fileName, and base64Data are required', 400);
  }

  // Parse existing files for duplicate check (sent from client)
  const existingFiles = Array.isArray(payload['existingFiles'])
    ? (payload['existingFiles'] as Array<Record<string, unknown>>).map((f) => ({
        fileName: String(f['fileName'] ?? ''),
        sizeBytes: Number(f['sizeBytes']) || 0,
        lastModified: String(f['lastModified'] ?? ''),
      }))
    : [];

  const result = uploadSinglePhoto(
    {
      eventId: String(payload['eventId'] ?? ''),
      fileName,
      mimeType,
      base64Data,
      fileSizeBytes,
      lastModified,
    },
    batchFolderId,
    existingFiles
  );

  return jsonOk(result, `File "${fileName}": ${result.status}`);
}

/**
 * POST action=list_club_files
 * Returns all files in the user's club folder for a given event.
 */
export function handleListClubFiles(
  payload: Record<string, unknown>,
  user: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const eventId = String(payload['eventId'] ?? '').trim();
  if (!eventId) {
    return jsonError('eventId is required', 400);
  }

  const result = listFilesInClubFolder(eventId, user.runningClub);
  if (result.status !== ResultStatus.SUCCESS) {
    return jsonError(result.message, 400);
  }

  return jsonOk(result.data, result.message);
}

/**
 * POST action=get_upload_history
 * Returns upload log entries for the user's club in a given event.
 */
export function handleGetUploadHistory(
  payload: Record<string, unknown>,
  user: UserRecord
): GoogleAppsScript.Content.TextOutput {
  const eventId = String(payload['eventId'] ?? '').trim();
  if (!eventId) {
    return jsonError('eventId is required', 400);
  }

  const result = getUploadHistory(eventId, user.runningClub);
  if (result.status !== ResultStatus.SUCCESS) {
    return jsonError(result.message, 400);
  }

  return jsonOk(result.data, result.message);
}
```

### 5.3 Page Route Handler — src/routes/pageRoutes.ts

```typescript
import { listAll as listAllEvents } from '../services/eventService';

/**
 * Renders the Upload page.
 * Pre-loads the event list so the event picker renders instantly.
 * The user's club name is injected into the template so the UI
 * knows which subfolder to browse and upload into.
 */
export function uploadPage(
  user: UserRecord
): GoogleAppsScript.HTML.HtmlOutput {
  const template = HtmlService.createTemplateFromFile('ui/templates/upload');
  template.userEmail = user.email;
  template.userRole = user.role;
  template.userClub = user.runningClub;

  // Pre-load event list for the picker
  const events = listAllEvents(1, 100, 'desc');
  template.events = JSON.stringify(events.items);

  return template.evaluate()
    .setTitle('Upload Photos — 湘舍动公益文件系统')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
```

### 5.4 Server Functions — src/main.ts

Add alongside the existing server functions:

```typescript
import {
  startUploadSession,
  uploadSinglePhoto,
  writeUploadLog,
} from './services/uploadService';
import {
  listFilesInClubFolder,
  getExistingFileFingerprints,
  getUploadHistory,
} from './services/fileService';

/**
 * google.script.run entry point for starting an upload session.
 * Creates the batch folder and returns session context + existing file fingerprints.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverStartUploadSession(
  payload: { eventId: string; fileCount: number; totalSizeBytes: number }
): ServerResponse {
  try {
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }
    const user = authResult.data;

    const sessionResult = startUploadSession(
      {
        eventId: payload.eventId,
        fileCount: payload.fileCount,
        totalSizeBytes: payload.totalSizeBytes,
      },
      user.email,
      user.runningClub
    );

    if (sessionResult.status !== ResultStatus.SUCCESS) {
      return { status: 'error', message: sessionResult.message };
    }

    // Fetch fingerprints for duplicate detection
    const fingerprints = getExistingFileFingerprints(
      payload.eventId,
      user.runningClub
    );

    return {
      status: 'success',
      message: sessionResult.message,
      data: {
        session: sessionResult.data,
        existingFiles: fingerprints.data ?? [],
      },
    };
  } catch (err) {
    Logger.log(`serverStartUploadSession error: ${String(err)}`);
    return { status: 'error', message: 'Internal error starting upload session' };
  }
}

/**
 * google.script.run entry point for uploading a single photo.
 * Called once per file, sequentially, from the browser.
 *
 * @param payload.batchFolderId   Batch folder from session context
 * @param payload.fileName        Original filename
 * @param payload.mimeType        Browser-reported MIME type
 * @param payload.base64Data      Base64-encoded file content
 * @param payload.fileSizeBytes   Original file size
 * @param payload.lastModified    File.lastModified timestamp
 * @param payload.existingFiles   Fingerprints for duplicate detection
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverUploadPhoto(
  payload: {
    eventId: string;
    batchFolderId: string;
    fileName: string;
    mimeType: string;
    base64Data: string;
    fileSizeBytes: number;
    lastModified: number;
    existingFiles: Array<{ fileName: string; sizeBytes: number; lastModified: string }>;
  }
): ServerResponse {
  try {
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const result = uploadSinglePhoto(
      {
        eventId: payload.eventId,
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        base64Data: payload.base64Data,
        fileSizeBytes: payload.fileSizeBytes,
        lastModified: payload.lastModified,
      },
      payload.batchFolderId,
      payload.existingFiles
    );

    return {
      status: result.status === 'uploaded' ? 'success' : 'warning',
      message: result.reason ?? `${result.fileName}: ${result.status}`,
      data: result,
    };
  } catch (err) {
    Logger.log(`serverUploadPhoto error: ${String(err)}`);
    return { status: 'error', message: 'Internal error uploading photo' };
  }
}

/**
 * google.script.run entry point for writing the upload log after all
 * files in a session have been processed.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverWriteUploadLog(
  payload: {
    batchFolderName: string;
    batchFolderId: string;
    clubFolderId: string;
    clubName: string;
    eventName: string;
    eventId: string;
    uploadedCount: number;
    totalSizeMb: number;
    skippedDuplicates: number;
    skippedNonPhoto: number;
  }
): ServerResponse {
  try {
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const session = {
      batchFolderName: payload.batchFolderName,
      batchFolderId: payload.batchFolderId,
      clubFolderId: payload.clubFolderId,
      clubName: payload.clubName,
      eventName: payload.eventName,
    };

    const result = writeUploadLog(
      session,
      payload.eventId,
      authResult.data.email,
      payload.uploadedCount,
      payload.totalSizeMb,
      payload.skippedDuplicates,
      payload.skippedNonPhoto
    );

    return {
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (err) {
    Logger.log(`serverWriteUploadLog error: ${String(err)}`);
    return { status: 'error', message: 'Internal error writing upload log' };
  }
}

/**
 * google.script.run entry point for listing files in the user's club folder.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverListClubFiles(
  payload: { eventId: string }
): ServerResponse {
  try {
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const result = listFilesInClubFolder(
      payload.eventId,
      authResult.data.runningClub
    );
    return {
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (err) {
    Logger.log(`serverListClubFiles error: ${String(err)}`);
    return { status: 'error', message: 'Internal error listing files' };
  }
}

/**
 * google.script.run entry point for fetching upload history.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function serverGetUploadHistory(
  payload: { eventId: string }
): ServerResponse {
  try {
    const authResult = authenticateRequest();
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      return { status: 'error', message: 'Authentication required' };
    }

    const result = getUploadHistory(
      payload.eventId,
      authResult.data.runningClub
    );
    return {
      status: result.status,
      message: result.message,
      data: result.data,
    };
  } catch (err) {
    Logger.log(`serverGetUploadHistory error: ${String(err)}`);
    return { status: 'error', message: 'Internal error fetching upload history' };
  }
}
```

---

## 6. Config Changes — src/config/constants.ts

Add upload-related constants alongside the existing configuration:

```typescript
// ─── Upload configuration ────────────────────────────────────────────────────

/**
 * Maximum number of files allowed in a single upload session.
 * Prevents users from accidentally selecting thousands of files.
 */
export const MAX_FILES_PER_SESSION = 100;

/**
 * Effective max file size for base64-encoded uploads.
 * GAS payload limit is 50MB, but base64 encoding adds ~33% overhead.
 * 33MB raw ≈ 44MB base64, leaving margin for JSON wrapper + metadata.
 */
export const EFFECTIVE_MAX_FILE_SIZE_MB = 33;

/**
 * Progress update interval for the upload UI.
 * The browser sends a progress callback every N files to keep the UI responsive.
 */
export const PROGRESS_UPDATE_INTERVAL = 1;

/**
 * Human-readable labels for accepted photo formats (shown in the UI).
 */
export const ACCEPTED_FORMATS_LABEL = 'JPG, PNG, HEIC';

/**
 * File input accept attribute value for the browser file picker.
 * Restricts the native file picker to show only photo types.
 */
export const FILE_INPUT_ACCEPT = '.jpg,.jpeg,.png,.heic,.heif';
```

---

## 7. Upload UI — src/ui/templates/upload.html

The upload page is a multi-step wizard with four states:

1. **Event Picker** — user selects an event from a dropdown with optional date filter
2. **File Browser** — shows existing files in the user's club folder (read-only tree view)
3. **File Selection & Upload** — browser file picker, client-side pre-validation, real-time upload progress
4. **Summary** — upload results with counts, skips, and sizes

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Upload Photos — 湘舍动公益文件系统</title>
  <link rel="stylesheet"
    href="https://fonts.googleapis.com/icon?family=Material+Icons">
  <link rel="stylesheet"
    href="https://code.getmdl.io/1.3.0/material.indigo-pink.min.css">
  <?!= HtmlService.createHtmlOutputFromFile('ui/css/styles').getContent() ?>
</head>
<body>
  <div class="mdl-layout mdl-js-layout mdl-layout--fixed-header">
    <header class="mdl-layout__header">
      <div class="mdl-layout__header-row">
        <a href="?action=dashboard" class="mdl-layout-title"
           style="color:inherit;text-decoration:none;">
          湘舍动公益文件系统
        </a>
        <div class="mdl-layout-spacer"></div>
        <nav class="mdl-navigation">
          <span class="mdl-navigation__link" style="opacity:0.8;">
            <i class="material-icons" style="vertical-align:middle;margin-right:4px;">group</i>
            <?= userClub ?>
          </span>
        </nav>
        <span class="mdl-chip" style="margin-left:12px;">
          <span class="mdl-chip__text"><?= userEmail ?></span>
        </span>
      </div>
    </header>

    <main class="mdl-layout__content">
      <div class="page-content">

        <!-- Step indicator -->
        <div id="step-indicator" style="display:flex;gap:24px;margin-bottom:24px;">
          <span class="step active" id="step-1-label">
            <i class="material-icons">event</i> 1. Select Event
          </span>
          <span class="step" id="step-2-label">
            <i class="material-icons">folder_open</i> 2. Browse Files
          </span>
          <span class="step" id="step-3-label">
            <i class="material-icons">cloud_upload</i> 3. Upload
          </span>
          <span class="step" id="step-4-label">
            <i class="material-icons">check_circle</i> 4. Summary
          </span>
        </div>

        <!-- Step 1: Event Picker -->
        <div id="step-1" class="card">
          <h5 style="margin:0 0 16px;">Select an Event</h5>
          <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;">
            <div class="mdl-textfield mdl-js-textfield mdl-textfield--floating-label"
                 style="width:auto;">
              <input type="date" id="filter-date-from" class="mdl-textfield__input"
                     onchange="filterEvents()">
              <label class="mdl-textfield__label" for="filter-date-from">From</label>
            </div>
            <div class="mdl-textfield mdl-js-textfield mdl-textfield--floating-label"
                 style="width:auto;">
              <input type="date" id="filter-date-to" class="mdl-textfield__input"
                     onchange="filterEvents()">
              <label class="mdl-textfield__label" for="filter-date-to">To</label>
            </div>
          </div>
          <div id="event-list" style="margin-top:16px;"></div>
        </div>

        <!-- Step 2: File Browser (hidden initially) -->
        <div id="step-2" class="card" style="display:none;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <h5 style="margin:0;">
              <span id="selected-event-name"></span> —
              <span style="color:#666;"><?= userClub ?></span>
            </h5>
            <button class="mdl-button mdl-js-button" onclick="goToStep(1)">
              <i class="material-icons">arrow_back</i> Change Event
            </button>
          </div>
          <div id="file-browser-loading" class="spinner"></div>
          <div id="file-browser-content" style="display:none;">
            <div id="file-count-badge" style="margin-bottom:12px;"></div>
            <div id="file-tree" style="max-height:300px;overflow-y:auto;"></div>
          </div>
          <div style="margin-top:16px;">
            <button class="mdl-button mdl-js-button mdl-button--raised mdl-button--colored"
                    onclick="goToStep(3)">
              <i class="material-icons" style="vertical-align:middle;margin-right:4px;">cloud_upload</i>
              Upload New Photos
            </button>
          </div>
        </div>

        <!-- Step 3: Upload -->
        <div id="step-3" class="card" style="display:none;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <h5 style="margin:0;">Upload Photos</h5>
            <button class="mdl-button mdl-js-button" onclick="goToStep(2)">
              <i class="material-icons">arrow_back</i> Back to Browser
            </button>
          </div>

          <!-- File picker (pre-upload state) -->
          <div id="upload-picker">
            <p style="color:#666;">
              Select photos to upload. Accepted formats: JPG, PNG, HEIC.
              Maximum file size: 33 MB per file. Maximum 100 files per session.
            </p>
            <input type="file" id="file-input"
                   accept=".jpg,.jpeg,.png,.heic,.heif"
                   multiple
                   onchange="handleFilesSelected(this.files)"
                   style="display:none;">
            <button class="mdl-button mdl-js-button mdl-button--raised"
                    onclick="document.getElementById('file-input').click()">
              <i class="material-icons" style="vertical-align:middle;margin-right:4px;">photo_library</i>
              Choose Photos
            </button>

            <!-- Selected files preview -->
            <div id="selected-files-preview" style="display:none;margin-top:16px;">
              <div id="selected-files-summary" style="margin-bottom:12px;"></div>
              <div id="selected-files-list"
                   style="max-height:200px;overflow-y:auto;font-size:14px;"></div>
              <div style="margin-top:16px;display:flex;gap:12px;">
                <button class="mdl-button mdl-js-button mdl-button--raised mdl-button--colored"
                        id="btn-start-upload"
                        onclick="startUpload()">
                  <i class="material-icons" style="vertical-align:middle;margin-right:4px;">cloud_upload</i>
                  Start Upload
                </button>
                <button class="mdl-button mdl-js-button"
                        onclick="clearSelection()">
                  Clear
                </button>
              </div>
            </div>
          </div>

          <!-- Upload progress (shown during upload) -->
          <div id="upload-progress" style="display:none;">
            <div id="progress-status" style="margin-bottom:8px;font-weight:500;"></div>
            <div style="width:100%;background:#e0e0e0;border-radius:4px;overflow:hidden;">
              <div id="progress-bar"
                   style="height:8px;background:#3f51b5;width:0%;transition:width 0.3s;"></div>
            </div>
            <div id="progress-details" style="margin-top:8px;font-size:14px;color:#666;"></div>
            <div id="progress-log"
                 style="margin-top:12px;max-height:200px;overflow-y:auto;font-size:13px;font-family:monospace;"></div>
          </div>
        </div>

        <!-- Step 4: Summary (hidden initially) -->
        <div id="step-4" class="card" style="display:none;">
          <h5 style="margin:0 0 16px;">
            <i class="material-icons" style="vertical-align:middle;color:#4caf50;">check_circle</i>
            Upload Complete
          </h5>
          <div id="summary-content"></div>
          <div style="margin-top:24px;display:flex;gap:12px;">
            <button class="mdl-button mdl-js-button mdl-button--raised mdl-button--colored"
                    onclick="goToStep(1)">
              Upload More Photos
            </button>
            <a href="?action=dashboard"
               class="mdl-button mdl-js-button mdl-button--raised">
              Back to Dashboard
            </a>
          </div>
        </div>

      </div>
    </main>
  </div>

  <script defer src="https://code.getmdl.io/1.3.0/material.min.js"></script>
  <?!= HtmlService.createHtmlOutputFromFile('ui/js/upload').getContent() ?>
</body>
</html>
```

---

## 8. Client-Side Upload Logic — src/ui/js/upload.html

This file contains all JavaScript for the upload page, wrapped in a `<script>` tag as required by GAS HtmlService.

```html
<script>
// ─── State ───────────────────────────────────────────────────────────────────

const allEvents = JSON.parse('<?!= events ?>');
let selectedEvent = null;
let selectedFiles = [];
let uploadSession = null;
let existingFileFingerprints = [];
let uploadResults = [];
let uploadStartTime = null;

// ─── Step Navigation ─────────────────────────────────────────────────────────

function goToStep(step) {
  for (let i = 1; i <= 4; i++) {
    document.getElementById('step-' + i).style.display = i === step ? 'block' : 'none';
    const label = document.getElementById('step-' + i + '-label');
    label.classList.toggle('active', i === step);
    label.classList.toggle('completed', i < step);
  }
  if (step === 2 && selectedEvent) {
    loadClubFiles();
  }
}

// ─── Step 1: Event Picker ────────────────────────────────────────────────────

function renderEventList(events) {
  const container = document.getElementById('event-list');
  if (events.length === 0) {
    container.innerHTML = '<p style="color:#999;">No events found for this date range.</p>';
    return;
  }
  container.innerHTML = events.map(function(evt) {
    return '<div class="event-row" onclick="selectEvent(\'' + evt.eventId + '\')" ' +
           'style="padding:12px;border:1px solid #e0e0e0;border-radius:4px;margin-bottom:8px;cursor:pointer;">' +
           '<strong>' + escapeHtml(evt.eventName) + '</strong>' +
           '<span style="float:right;color:#666;">' + evt.eventDate + '</span>' +
           '<div style="font-size:13px;color:#999;margin-top:4px;">' +
           '<i class="material-icons" style="font-size:14px;vertical-align:middle;">folder</i> ' +
           escapeHtml(evt.folderName) +
           '</div></div>';
  }).join('');
}

function filterEvents() {
  const from = document.getElementById('filter-date-from').value;
  const to = document.getElementById('filter-date-to').value;
  let filtered = allEvents;
  if (from) filtered = filtered.filter(function(e) { return e.eventDate >= from; });
  if (to) filtered = filtered.filter(function(e) { return e.eventDate <= to; });
  renderEventList(filtered);
}

function selectEvent(eventId) {
  selectedEvent = allEvents.find(function(e) { return e.eventId === eventId; });
  if (!selectedEvent) return;
  document.getElementById('selected-event-name').textContent = selectedEvent.eventName;
  goToStep(2);
}

// ─── Step 2: File Browser ────────────────────────────────────────────────────

function loadClubFiles() {
  var loading = document.getElementById('file-browser-loading');
  var content = document.getElementById('file-browser-content');
  loading.style.display = 'block';
  content.style.display = 'none';

  google.script.run
    .withSuccessHandler(function(response) {
      loading.style.display = 'none';
      content.style.display = 'block';
      if (response.status !== 'success') {
        document.getElementById('file-tree').innerHTML =
          '<p style="color:#f44336;">' + escapeHtml(response.message) + '</p>';
        return;
      }
      var files = response.data || [];
      document.getElementById('file-count-badge').innerHTML =
        '<span class="mdl-chip"><span class="mdl-chip__text">' +
        files.length + ' existing file(s)</span></span>';
      renderFileTree(files);
    })
    .withFailureHandler(function(err) {
      loading.style.display = 'none';
      content.style.display = 'block';
      document.getElementById('file-tree').innerHTML =
        '<p style="color:#f44336;">Error loading files: ' + escapeHtml(String(err)) + '</p>';
    })
    .serverListClubFiles({ eventId: selectedEvent.eventId });
}

function renderFileTree(files) {
  var tree = document.getElementById('file-tree');
  if (files.length === 0) {
    tree.innerHTML = '<p style="color:#999;">No files uploaded yet. Click "Upload New Photos" to get started.</p>';
    return;
  }

  // Group by batch folder
  var batches = {};
  files.forEach(function(f) {
    if (!batches[f.batchFolderName]) batches[f.batchFolderName] = [];
    batches[f.batchFolderName].push(f);
  });

  var html = '';
  Object.keys(batches).sort().reverse().forEach(function(batchName) {
    var batchFiles = batches[batchName];
    var totalSize = batchFiles.reduce(function(sum, f) { return sum + f.sizeBytes; }, 0);
    html += '<div style="margin-bottom:12px;">' +
            '<div style="font-weight:500;color:#3f51b5;font-size:14px;">' +
            '<i class="material-icons" style="font-size:16px;vertical-align:middle;">folder</i> ' +
            escapeHtml(batchName) +
            ' <span style="color:#999;font-weight:normal;">(' +
            batchFiles.length + ' files, ' + formatSize(totalSize) + ')</span>' +
            '</div>';
    batchFiles.forEach(function(f) {
      html += '<div style="padding:2px 0 2px 24px;font-size:13px;">' +
              '<i class="material-icons" style="font-size:14px;vertical-align:middle;color:#999;">image</i> ' +
              escapeHtml(f.fileName) +
              ' <span style="color:#999;">(' + formatSize(f.sizeBytes) + ')</span>' +
              '</div>';
    });
    html += '</div>';
  });
  tree.innerHTML = html;
}

// ─── Step 3: File Selection & Upload ─────────────────────────────────────────

function handleFilesSelected(fileList) {
  selectedFiles = Array.from(fileList);
  if (selectedFiles.length === 0) return;

  // Client-side pre-filter: count by type
  var accepted = [];
  var rejected = [];
  var acceptedTypes = new Set([
    'image/jpeg', 'image/png', 'image/heic', 'image/heif'
  ]);

  selectedFiles.forEach(function(f) {
    if (acceptedTypes.has(f.type)) {
      accepted.push(f);
    } else {
      rejected.push(f);
    }
  });

  var totalSize = accepted.reduce(function(sum, f) { return sum + f.size; }, 0);

  // Show preview
  document.getElementById('selected-files-preview').style.display = 'block';
  document.getElementById('selected-files-summary').innerHTML =
    '<strong>' + accepted.length + '</strong> photo(s) selected (' +
    formatSize(totalSize) + ')' +
    (rejected.length > 0
      ? ' — <span style="color:#ff9800;">' + rejected.length +
        ' non-photo file(s) will be skipped</span>'
      : '');

  // File list
  var listHtml = accepted.map(function(f) {
    return '<div style="padding:2px 0;">' +
           '<i class="material-icons" style="font-size:14px;vertical-align:middle;color:#4caf50;">check_circle</i> ' +
           escapeHtml(f.name) + ' (' + formatSize(f.size) + ')' +
           '</div>';
  }).join('');

  if (rejected.length > 0) {
    listHtml += '<div style="margin-top:8px;color:#ff9800;">';
    rejected.forEach(function(f) {
      listHtml += '<div style="padding:2px 0;">' +
                  '<i class="material-icons" style="font-size:14px;vertical-align:middle;">block</i> ' +
                  escapeHtml(f.name) + ' (' + f.type + ')' +
                  '</div>';
    });
    listHtml += '</div>';
  }

  document.getElementById('selected-files-list').innerHTML = listHtml;

  // Store only accepted files for upload
  selectedFiles = accepted;
}

function clearSelection() {
  selectedFiles = [];
  document.getElementById('file-input').value = '';
  document.getElementById('selected-files-preview').style.display = 'none';
}

function startUpload() {
  if (selectedFiles.length === 0) return;

  // Disable controls
  document.getElementById('btn-start-upload').disabled = true;
  document.getElementById('upload-picker').style.display = 'none';
  document.getElementById('upload-progress').style.display = 'block';

  uploadResults = [];
  uploadStartTime = Date.now();

  var totalSize = selectedFiles.reduce(function(sum, f) { return sum + f.size; }, 0);

  updateProgress(0, selectedFiles.length, 'Starting upload session...');

  // Step 1: Create upload session
  google.script.run
    .withSuccessHandler(function(response) {
      if (response.status !== 'success') {
        showUploadError('Failed to start session: ' + response.message);
        return;
      }
      uploadSession = response.data.session;
      existingFileFingerprints = response.data.existingFiles || [];
      // Step 2: Upload files one by one
      uploadNextFile(0);
    })
    .withFailureHandler(function(err) {
      showUploadError('Session creation failed: ' + String(err));
    })
    .serverStartUploadSession({
      eventId: selectedEvent.eventId,
      fileCount: selectedFiles.length,
      totalSizeBytes: totalSize,
    });
}

function uploadNextFile(index) {
  if (index >= selectedFiles.length) {
    // All files processed — write log and show summary
    finishUpload();
    return;
  }

  var file = selectedFiles[index];
  updateProgress(index, selectedFiles.length, 'Uploading: ' + file.name);

  var reader = new FileReader();
  reader.onload = function(e) {
    // Extract base64 from data URL (remove "data:image/jpeg;base64," prefix)
    var dataUrl = e.target.result;
    var base64 = dataUrl.split(',')[1];

    google.script.run
      .withSuccessHandler(function(response) {
        var result = response.data || {
          fileName: file.name,
          status: 'error',
          reason: response.message,
          sizeBytes: file.size,
        };
        uploadResults.push(result);
        logUploadResult(result);
        uploadNextFile(index + 1);
      })
      .withFailureHandler(function(err) {
        uploadResults.push({
          fileName: file.name,
          status: 'error',
          reason: String(err),
          sizeBytes: file.size,
        });
        logUploadResult({
          fileName: file.name,
          status: 'error',
          reason: String(err),
        });
        uploadNextFile(index + 1);
      })
      .serverUploadPhoto({
        eventId: selectedEvent.eventId,
        batchFolderId: uploadSession.batchFolderId,
        fileName: file.name,
        mimeType: file.type,
        base64Data: base64,
        fileSizeBytes: file.size,
        lastModified: file.lastModified,
        existingFiles: existingFileFingerprints,
      });
  };
  reader.onerror = function() {
    uploadResults.push({
      fileName: file.name,
      status: 'error',
      reason: 'Failed to read file from disk',
      sizeBytes: file.size,
    });
    uploadNextFile(index + 1);
  };
  reader.readAsDataURL(file);
}

function finishUpload() {
  // Aggregate results
  var uploaded = uploadResults.filter(function(r) { return r.status === 'uploaded'; });
  var skippedDups = uploadResults.filter(function(r) { return r.status === 'skipped_duplicate'; });
  var skippedType = uploadResults.filter(function(r) { return r.status === 'skipped_type'; });
  var skippedSize = uploadResults.filter(function(r) { return r.status === 'skipped_size'; });
  var errors = uploadResults.filter(function(r) { return r.status === 'error'; });

  var totalUploadedBytes = uploaded.reduce(function(sum, r) { return sum + r.sizeBytes; }, 0);
  var totalUploadedMb = totalUploadedBytes / (1024 * 1024);
  var durationSeconds = Math.round((Date.now() - uploadStartTime) / 1000);

  updateProgress(selectedFiles.length, selectedFiles.length, 'Writing upload log...');

  // Write upload log to Sheets
  google.script.run
    .withSuccessHandler(function() {
      showSummary({
        eventName: uploadSession.eventName,
        clubName: uploadSession.clubName,
        batchFolderName: uploadSession.batchFolderName,
        uploaded: uploaded.length,
        skippedDuplicates: skippedDups.length,
        skippedNonPhoto: skippedType.length,
        skippedOversize: skippedSize.length,
        errors: errors.length,
        totalSizeMb: totalUploadedMb,
        durationSeconds: durationSeconds,
      });
    })
    .withFailureHandler(function(err) {
      // Still show summary even if log write fails
      showSummary({
        eventName: uploadSession.eventName,
        clubName: uploadSession.clubName,
        batchFolderName: uploadSession.batchFolderName,
        uploaded: uploaded.length,
        skippedDuplicates: skippedDups.length,
        skippedNonPhoto: skippedType.length,
        skippedOversize: skippedSize.length,
        errors: errors.length,
        totalSizeMb: totalUploadedMb,
        durationSeconds: durationSeconds,
        logError: String(err),
      });
    })
    .serverWriteUploadLog({
      batchFolderName: uploadSession.batchFolderName,
      batchFolderId: uploadSession.batchFolderId,
      clubFolderId: uploadSession.clubFolderId,
      clubName: uploadSession.clubName,
      eventName: uploadSession.eventName,
      eventId: selectedEvent.eventId,
      uploadedCount: uploaded.length,
      totalSizeMb: Math.round(totalUploadedMb * 100) / 100,
      skippedDuplicates: skippedDups.length,
      skippedNonPhoto: skippedType.length + skippedSize.length,
    });
}

// ─── Step 4: Summary ─────────────────────────────────────────────────────────

function showSummary(summary) {
  goToStep(4);

  var html = '<table class="mdl-data-table" style="width:auto;border:none;">';
  html += summaryRow('Event', summary.eventName);
  html += summaryRow('Club', summary.clubName);
  html += summaryRow('Batch Folder', summary.batchFolderName);
  html += summaryRow('Uploaded', summary.uploaded + ' file(s), ' +
                     summary.totalSizeMb.toFixed(1) + ' MB', '#4caf50');
  if (summary.skippedDuplicates > 0) {
    html += summaryRow('Skipped (duplicates)', summary.skippedDuplicates + ' file(s)', '#ff9800');
  }
  if (summary.skippedNonPhoto > 0) {
    html += summaryRow('Skipped (wrong type)', summary.skippedNonPhoto + ' file(s)', '#ff9800');
  }
  if (summary.skippedOversize > 0) {
    html += summaryRow('Skipped (too large)', summary.skippedOversize + ' file(s)', '#ff9800');
  }
  if (summary.errors > 0) {
    html += summaryRow('Errors', summary.errors + ' file(s)', '#f44336');
  }
  html += summaryRow('Duration', summary.durationSeconds + ' seconds');
  html += '</table>';

  if (summary.logError) {
    html += '<p style="color:#ff9800;margin-top:12px;">' +
            '<i class="material-icons" style="vertical-align:middle;">warning</i> ' +
            'Upload log could not be saved: ' + escapeHtml(summary.logError) +
            '. Your files were uploaded successfully — please contact an admin to reconcile the log.</p>';
  }

  document.getElementById('summary-content').innerHTML = html;
}

function summaryRow(label, value, color) {
  return '<tr><td style="border:none;padding:4px 16px 4px 0;color:#666;">' +
         label + '</td><td style="border:none;padding:4px 0;' +
         (color ? 'color:' + color + ';font-weight:500;' : '') + '">' +
         escapeHtml(String(value)) + '</td></tr>';
}

// ─── UI Helpers ──────────────────────────────────────────────────────────────

function updateProgress(current, total, message) {
  var pct = total > 0 ? Math.round((current / total) * 100) : 0;
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('progress-status').textContent = message;
  document.getElementById('progress-details').textContent =
    current + ' / ' + total + ' files (' + pct + '%)';
}

function logUploadResult(result) {
  var log = document.getElementById('progress-log');
  var icon, color;
  switch (result.status) {
    case 'uploaded':
      icon = 'check_circle'; color = '#4caf50'; break;
    case 'skipped_duplicate':
      icon = 'content_copy'; color = '#ff9800'; break;
    case 'skipped_type':
    case 'skipped_size':
      icon = 'block'; color = '#ff9800'; break;
    default:
      icon = 'error'; color = '#f44336';
  }
  log.innerHTML += '<div style="color:' + color + ';">' +
    '<i class="material-icons" style="font-size:14px;vertical-align:middle;">' +
    icon + '</i> ' + escapeHtml(result.fileName) + ': ' + result.status +
    (result.reason ? ' — ' + escapeHtml(result.reason) : '') +
    '</div>';
  log.scrollTop = log.scrollHeight;
}

function showUploadError(message) {
  document.getElementById('progress-status').innerHTML =
    '<span style="color:#f44336;"><i class="material-icons" style="vertical-align:middle;">error</i> ' +
    escapeHtml(message) + '</span>';
  document.getElementById('btn-start-upload').disabled = false;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Init ────────────────────────────────────────────────────────────────────

renderEventList(allEvents);
</script>
```

---

## 9. Input Validation — src/middleware/inputValidator.ts

Add upload payload validators alongside the existing user and event validators:

```typescript
import { StartUploadSessionInput, UploadPhotoInput } from '../types/requests';
import { ServiceResult, ValidationError } from '../types/responses';
import { ResultStatus, PhotoMimeType } from '../types/enums';
import { MAX_FILES_PER_SESSION, EFFECTIVE_MAX_FILE_SIZE_MB } from '../config/constants';

/**
 * Validates the start-upload-session payload.
 */
export function validateStartSessionPayload(
  payload: Record<string, unknown>
): ServiceResult<StartUploadSessionInput> {
  const errors: ValidationError[] = [];

  const eventId = typeof payload['eventId'] === 'string'
    ? payload['eventId'].trim()
    : '';
  const fileCount = Number(payload['fileCount']);
  const totalSizeBytes = Number(payload['totalSizeBytes']);

  if (!eventId) {
    errors.push({ field: 'eventId', message: 'Event ID is required' });
  }
  if (!isFinite(fileCount) || fileCount < 1) {
    errors.push({ field: 'fileCount', message: 'File count must be at least 1' });
  } else if (fileCount > MAX_FILES_PER_SESSION) {
    errors.push({
      field: 'fileCount',
      message: `Maximum ${MAX_FILES_PER_SESSION} files per session`,
      value: fileCount,
    });
  }
  if (!isFinite(totalSizeBytes) || totalSizeBytes < 1) {
    errors.push({ field: 'totalSizeBytes', message: 'Total size must be positive' });
  }

  if (errors.length > 0) {
    return { status: ResultStatus.ERROR, message: 'Validation failed', errors };
  }

  return {
    status: ResultStatus.SUCCESS,
    message: 'Valid',
    data: { eventId, fileCount, totalSizeBytes },
  };
}

/**
 * Validates a single-file upload payload.
 * Checks presence and types of all required fields.
 */
export function validateUploadPhotoPayload(
  payload: Record<string, unknown>
): ServiceResult<UploadPhotoInput> {
  const errors: ValidationError[] = [];

  const eventId = String(payload['eventId'] ?? '').trim();
  const fileName = String(payload['fileName'] ?? '').trim();
  const mimeType = String(payload['mimeType'] ?? '').trim();
  const base64Data = String(payload['base64Data'] ?? '');
  const fileSizeBytes = Number(payload['fileSizeBytes']);
  const lastModified = Number(payload['lastModified']);

  if (!eventId) {
    errors.push({ field: 'eventId', message: 'Event ID is required' });
  }
  if (!fileName) {
    errors.push({ field: 'fileName', message: 'File name is required' });
  }
  if (!mimeType) {
    errors.push({ field: 'mimeType', message: 'MIME type is required' });
  }
  if (!base64Data) {
    errors.push({ field: 'base64Data', message: 'File data is required' });
  }
  if (!isFinite(fileSizeBytes) || fileSizeBytes < 1) {
    errors.push({ field: 'fileSizeBytes', message: 'File size must be positive' });
  }
  if (!isFinite(lastModified) || lastModified < 0) {
    errors.push({ field: 'lastModified', message: 'Last modified timestamp is required' });
  }

  // File name security: reject path traversal attempts
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    errors.push({
      field: 'fileName',
      message: 'File name must not contain path separators',
      value: fileName,
    });
  }

  if (errors.length > 0) {
    return { status: ResultStatus.ERROR, message: 'Validation failed', errors };
  }

  return {
    status: ResultStatus.SUCCESS,
    message: 'Valid',
    data: { eventId, fileName, mimeType, base64Data, fileSizeBytes, lastModified },
  };
}
```

---

## 10. Unit Tests

### 10.1 tests/unit/uploadService.test.ts

```typescript
import {
  startUploadSession,
  uploadSinglePhoto,
  writeUploadLog,
} from '../../src/services/uploadService';
import { ResultStatus } from '../../src/types/enums';

// Test groups:

describe('startUploadSession', () => {
  // 1. Valid session start: known event + known club → SUCCESS
  //    - Verify batch folder name matches YYYYMMDD-HHMMSS_username pattern
  //    - Verify club folder creation is idempotent (called twice → same ID)
  //    - Verify returned UploadSessionContext has all required fields

  // 2. Unknown event ID → ERROR with descriptive message

  // 3. Unknown club name → ERROR mentioning approved clubs

  // 4. Batch size exceeds MAX_BATCH_SIZE_MB → ERROR with size info

  // 5. Edge: eventId is empty string → ERROR

  // 6. Edge: fileCount is 0 → still succeeds (session can be created without files)
});

describe('uploadSinglePhoto', () => {
  // 1. Valid JPEG upload → status: 'uploaded', fileId is set

  // 2. Valid PNG upload → status: 'uploaded'

  // 3. Valid HEIC upload → status: 'uploaded'

  // 4. Unsupported MIME type (video/mp4) → status: 'skipped_type'
  //    - Verify reason mentions accepted formats

  // 5. Unsupported MIME type (application/pdf) → status: 'skipped_type'

  // 6. File exceeds MAX_FILE_SIZE_MB → status: 'skipped_size'
  //    - Verify reason mentions the limit

  // 7. Duplicate detected (same name + size + lastModified) → status: 'skipped_duplicate'
  //    - Verify reason mentions the duplicate file name

  // 8. Same name but different size → NOT a duplicate → uploaded

  // 9. Same name and size but different lastModified → NOT a duplicate → uploaded

  // 10. Drive API failure → status: 'error'
  //     - Mock DriveApp.getFolderById to throw

  // 11. Empty base64Data → Drive write fails → status: 'error'

  // 12. Edge: fileName with unicode characters → uploaded (Drive supports unicode)

  // 13. Edge: very long fileName (255 chars) → uploaded (within Drive limits)
});

describe('writeUploadLog', () => {
  // 1. Valid write → SUCCESS, returned UploadLogRecord has correct fields
  //    - logId is a UUID
  //    - source is 'web_app'
  //    - uploadTimestamp is ISO 8601
  //    - totalSizeMb is rounded to 2 decimal places

  // 2. Sheet write fails → ERROR with descriptive message

  // 3. Edge: uploadedCount = 0 (all files skipped) → still writes log

  // 4. Edge: totalSizeMb = 0 → valid (user selected only duplicates)
});
```

### 10.2 tests/unit/fileService.test.ts

```typescript
import {
  listFilesInClubFolder,
  getExistingFileFingerprints,
  getUploadHistory,
} from '../../src/services/fileService';
import { ResultStatus } from '../../src/types/enums';

describe('listFilesInClubFolder', () => {
  // 1. Event with files in club folder → returns FileListItem[] sorted newest first

  // 2. Event exists but no club folder → SUCCESS with empty array

  // 3. Unknown event ID → ERROR

  // 4. Club folder exists but is empty → SUCCESS with empty array

  // 5. Multiple batch folders → files grouped and sorted correctly

  // 6. Verify FileListItem fields: fileName, fileId, mimeType, sizeBytes,
  //    lastModified, batchFolderName, thumbnailUrl
});

describe('getExistingFileFingerprints', () => {
  // 1. Files exist → returns FileFingerprint[] with name, size, lastModified

  // 2. No files → SUCCESS with empty array

  // 3. Unknown event → ERROR

  // 4. Verify fingerprints exclude display metadata (no thumbnailUrl, etc.)
});

describe('getUploadHistory', () => {
  // 1. Upload logs exist for the event+club → returns UploadLogRecord[] sorted newest first

  // 2. No logs for this club → SUCCESS with empty array

  // 3. Logs exist for other clubs but not this one → empty array (correct filtering)
});
```

### 10.3 tests/unit/inputValidator.test.ts (additions)

```typescript
describe('validateStartSessionPayload', () => {
  // 1. Valid payload → SUCCESS with parsed StartUploadSessionInput

  // 2. Missing eventId → ERROR with field error

  // 3. fileCount exceeds MAX_FILES_PER_SESSION → ERROR

  // 4. fileCount is 0 → ERROR

  // 5. totalSizeBytes is negative → ERROR
});

describe('validateUploadPhotoPayload', () => {
  // 1. Valid payload → SUCCESS

  // 2. Missing fileName → ERROR

  // 3. Missing base64Data → ERROR

  // 4. fileName with path traversal (../) → ERROR with security message

  // 5. fileName with backslash → ERROR

  // 6. All fields missing → ERROR with multiple field errors
});
```

### 10.4 tests/mocks/gasGlobals.ts (additions)

Extend the existing GAS mock to support Drive file operations needed by upload tests:

```typescript
// Add to existing mock file:

/**
 * Mock for DriveApp.Folder.createFile(blob)
 * Returns a mock File object with getId(), getName(), getMimeType(), getSize()
 */
function createMockFile(
  name: string,
  mimeType: string,
  size: number
): MockFile {
  return {
    getId: () => `mock-file-id-${name}`,
    getName: () => name,
    getMimeType: () => mimeType,
    getSize: () => size,
    getLastUpdated: () => new Date(),
    getThumbnail: () => null,
  };
}

/**
 * Mock for Utilities.base64Decode(data)
 * Returns a mock byte array.
 */
const mockUtilities = {
  base64Decode: (data: string) => {
    // Return array of length proportional to input
    return new Array(Math.floor(data.length * 0.75)).fill(0);
  },
  newBlob: (data: number[], mimeType: string, name: string) => ({
    getContentType: () => mimeType,
    getName: () => name,
    getBytes: () => data,
  }),
};

// Register globally
(globalThis as any).Utilities = mockUtilities;
```

---

## 11. Integration Test

### 11.1 tests/integration/uploadFlow.test.ts

This test exercises the full upload pipeline end-to-end using mocked Drive and Sheets:

```typescript
describe('Upload Flow Integration', () => {
  // Setup:
  //   - Create a mock event in the Events sheet
  //   - Configure an approved club for the test user
  //   - Mock DriveApp with in-memory folder/file structures

  // Test 1: Happy path — full upload cycle
  //   1. Call startUploadSession → verify batch folder created
  //   2. Call uploadSinglePhoto 3x with valid JPEGs → all return 'uploaded'
  //   3. Call writeUploadLog → verify record in Upload_Log sheet
  //   4. Call listFilesInClubFolder → verify 3 files returned
  //   5. Verify Upload_Log record: fileCount=3, skippedDuplicates=0

  // Test 2: Mixed upload — some duplicates, some skipped types
  //   1. Pre-populate club folder with 2 existing files
  //   2. Upload 5 files: 2 duplicates, 1 video, 2 new photos
  //   3. Verify results: 2 uploaded, 2 skipped_duplicate, 1 skipped_type
  //   4. Verify Upload_Log: fileCount=2, skippedDuplicates=2, skippedNonPhoto=1

  // Test 3: Session start fails — unknown event
  //   1. Call startUploadSession with non-existent eventId → ERROR
  //   2. Verify no batch folder was created

  // Test 4: All files are duplicates
  //   1. Pre-populate with existing files matching all selected files
  //   2. Upload → all skipped_duplicate
  //   3. Upload log still written (with fileCount=0)

  // Test 5: Concurrent-safe batch folder naming
  //   1. Start two sessions within the same second
  //   2. Verify batch folder names are unique (username differs or timestamp resolution)
});
```

---

## 12. Implementation Order

Phase 3 has the most cross-cutting changes of any phase. The implementation order below minimizes the risk of merge conflicts and ensures each step is independently testable.

### Week 3: Service Layer

| # | Task | Files | Depends On | Test Coverage |
|---|------|-------|------------|---------------|
| 1 | Add new types (DTOs + responses) | `enums.ts`, `requests.ts`, `responses.ts` | — | Type-checked by `tsc --noEmit` |
| 2 | Add upload config constants | `constants.ts` | — | Referenced by later steps |
| 3 | Implement `fileService.ts` | New file | Types | `fileService.test.ts` |
| 4 | Implement `uploadService.ts` | New file | Types, fileService | `uploadService.test.ts` |
| 5 | Add input validators | `inputValidator.ts` | Types | `inputValidator.test.ts` (additions) |
| 6 | Extend GAS mocks | `gasGlobals.ts` | — | Used by all new tests |
| 7 | Run full test suite | — | Steps 1–6 | `jest --coverage` |

### Week 4: Route Wiring + Server Functions

| # | Task | Files | Depends On | Test Coverage |
|---|------|-------|------------|---------------|
| 8 | Add route actions to router | `router.ts` | Types | Existing router tests still pass |
| 9 | Add API route handlers | `apiRoutes.ts` | uploadService, fileService | Manual test via curl/GAS |
| 10 | Add page route handler | `pageRoutes.ts` | eventService | Manual test (load page) |
| 11 | Add server functions to `main.ts` | `main.ts` | Services | `google.script.run` callable |
| 12 | Integration test | `uploadFlow.test.ts` | Steps 3–11 | Full pipeline verification |

### Week 5: UI + Polish

| # | Task | Files | Depends On | Test Coverage |
|---|------|-------|------------|---------------|
| 13 | Create `upload.html` template | New file | Page route | Visual inspection |
| 14 | Create `upload.html` JS | New file | Server functions | Manual upload test |
| 15 | Add upload nav link to dashboard | `dashboard.html` | Upload page exists | Visual check |
| 16 | End-to-end manual test | — | All steps | Upload 10+ photos, verify Drive + Sheets |
| 17 | Edge case testing | — | Step 16 | Duplicates, oversized, HEIC, empty session |
| 18 | `clasp push` + deploy | — | All passing | Web App deployment verification |

---

## 13. GAS-Specific Constraints & Mitigations

| Constraint | Impact on Phase 3 | Mitigation |
|-----------|-------------------|------------|
| **6-minute execution timeout** | A single `google.script.run` call must finish within 6 minutes. Uploading many large files in one call would timeout. | Files are uploaded one at a time. Each `serverUploadPhoto` call handles exactly one file, well under the timeout. |
| **50 MB `google.script.run` payload** | Base64 encoding increases payload size by ~33%. A 50 MB file becomes ~67 MB encoded, exceeding the limit. | Effective limit is set to 33 MB per file. UI warns users and rejects files over this threshold before sending. |
| **No binary transfer via `google.script.run`** | Browser-to-server communication is JSON-only. | Files are base64-encoded client-side and decoded server-side using `Utilities.base64Decode`. |
| **No background jobs / web workers** | Can't upload files in parallel server-side. | Sequential upload is acceptable for the expected volume (tens of files per session, not thousands). |
| **`HtmlService` sandboxing** | Client JS runs in an iframe with limited API access. No `fetch`, no `XMLHttpRequest` to external URLs. | All server calls use `google.script.run`. UI state is managed with plain DOM manipulation (no framework). |
| **Drive API quota (1,000 req / 100 sec)** | Listing files across many batch folders makes many API calls. | `listFilesInClubFolder` is called once per event selection, not per upload. For events with >50 batches, consider paginating in Phase 4. |

---

## 14. Open Questions / Decisions for Phase 3

1. **Overwrite vs. skip for duplicates**: Currently, duplicates are always skipped. Should users have the option to overwrite? The project plan flowchart (Section 4.2) shows "ask user: skip or overwrite?" — the current implementation defaults to skip. Adding an overwrite option requires per-file UI decisions that significantly increase complexity.

2. **HEIC thumbnail support**: Google Drive may not generate thumbnails for HEIC files. Should we add a fallback (e.g., server-side conversion to JPEG thumbnail) or just show a placeholder icon? Recommendation: placeholder for v1, server-side conversion in v2.

3. **Upload cancellation**: If the user closes the browser mid-upload, files already written to Drive stay. Should we add a "Cancel" button that cleans up the batch folder? GAS has no `onbeforeunload` access in `HtmlService`. Recommendation: leave partial uploads as-is; the batch folder is visible for admin reconciliation.

4. **Progress persistence**: If the browser crashes, the user loses progress. Should we write partial results to a "pending uploads" sheet? Recommendation: not for v1 — the upload log captures only completed sessions, and partial uploads are visible in Drive.

5. **RAW format support**: The project plan lists RAW (CR2, ARW, NEF) as an open question. These are very large files (20–50 MB each) that will approach the effective per-file limit. Recommendation: exclude from v1, revisit when Node.js v2 removes the base64 overhead.
