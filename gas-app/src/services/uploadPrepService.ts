/**
 * uploadPrepService.ts — Core orchestration for the Upload Prep feature.
 *
 * Workflow for one event:
 *   1. assertSuperAdmin()
 *   2. Resolve event folder + ensure _UploadPrep/<EventName>/ exists
 *   3. Load (or create) per-event manifest into a Map keyed by source_file_id
 *   4. Enumerate source files in batches (FileIterator + ContinuationToken)
 *   5. For each file:
 *        a. Classify: copy | convert | skip
 *        b. If not force and manifest has a matching (file_id + md5), skip (already done)
 *        c. Resolve dest_name with collision policy (keep stem, append __2, __3, …)
 *        d. Execute: DriveApp.makeCopy (copy) | cloudRunClient.convertImage (convert) | skip row
 *        e. Append manifest row (in-memory)
 *   6. Write manifest.csv back to Drive
 *   7. Upsert _index.csv row
 *   8. Return counts
 *
 * Chunked execution (6-min GAS limit, spec §8):
 *   prepareEventForUploadBatch() processes at most BATCH_SIZE files per call.
 *   The sidebar loops this until it receives { done: true }.
 *   Run state (progress counters, continuation token) lives in
 *   PropertiesService (script-scoped) so any admin can resume a run started
 *   by a different admin. CacheService is user-scoped and would silently
 *   produce a cache miss if a second admin checked the same runId.
 *
 * See UPLOAD_PREP_FEATURE_SPEC.md §7.3 for full specification.
 */

/* global DriveApp, Session, PropertiesService, Logger */

import {
  getSuperAdmins,
  UPLOAD_PREP_ROOT_NAME,
  JPG_QUALITY_DEFAULT,
  FORMAT_POLICY,
  BATCH_SIZE,
} from '../config/superAdmins';
import { convertImage } from './cloudRunClient';
import {
  ManifestRow,
  ManifestAction,
  loadManifest,
  writeManifest,
  upsertIndex,
} from './manifestService';
import { getConfig } from '../config/constants';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PrepEventRequest {
  readonly eventFolderId: string;
  readonly dryRun?: boolean;   // default false
  readonly force?: boolean;    // default false — bypass incremental skip
}

export interface PrepEventResult {
  readonly runId: string;
  readonly eventName: string;
  readonly counts: {
    readonly total: number;
    readonly copied: number;
    readonly converted: number;
    readonly skipped: number;
    readonly errored: number;
  };
  readonly durationMs: number;
}

/**
 * Request for a single batch step (chunked execution path).
 * Pass continuationToken from the previous batch's response to resume.
 */
export interface PrepEventBatchRequest extends PrepEventRequest {
  readonly runId: string;
  readonly continuationToken?: string; // FileIterator continuation token
}

export interface PrepEventBatchResult {
  readonly runId: string;
  readonly eventName: string;
  readonly done: boolean;            // true = all files processed
  readonly continuationToken?: string;
  readonly batchCounts: {
    readonly processed: number;
    readonly copied: number;
    readonly converted: number;
    readonly skipped: number;
    readonly errored: number;
  };
  readonly totalSoFar: {
    readonly total: number;
    readonly copied: number;
    readonly converted: number;
    readonly skipped: number;
    readonly errored: number;
  };
}

export interface EventPrepStatus {
  readonly eventName: string;
  readonly sourceFileCount: number;
  readonly alreadyPreppedCount: number;
  readonly newOrChangedCount: number;
  readonly lastRunAt?: string;
}

// ─── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Checks that the currently active user is in the SUPER_ADMINS allowlist.
 * Throws if not — callers do not need to check the return value.
 */
export function assertSuperAdmin(): void {
  const email = Session.getEffectiveUser().getEmail();
  if (!getSuperAdmins().includes(email.toLowerCase())) {
    throw new Error(`Forbidden: super admin only (${email} is not in the allowlist)`);
  }
}

// ─── File classification ───────────────────────────────────────────────────────

interface SkipReason {
  readonly reason: 'video' | 'audio' | 'not_an_image' | 'unsupported_format';
}

type ClassifyResult =
  | { class: 'copy' | 'convert' }
  | { class: 'skip'; skipReason: SkipReason['reason'] };

/**
 * Classifies a Drive file by MIME type and extension into copy / convert / skip.
 *
 * Priority order:
 *   1. Google-native files → skip (not_an_image)
 *   2. Video/audio MIME prefix → skip
 *   3. Skip-by-extension → skip
 *   4. Copy MIME list → copy
 *   5. Convert MIME list → convert
 *   6. Convert-by-extension (RAW) → convert
 *   7. Everything else → skip (unsupported_format)
 */
export function classifyFile(
  mimeType: string,
  fileName: string
): ClassifyResult {
  const ext = fileName.includes('.')
    ? fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase()
    : '';

  // Google-native files (Docs, Sheets, Slides, etc.)
  if (mimeType.startsWith('application/vnd.google-apps.')) {
    return { class: 'skip', skipReason: 'not_an_image' };
  }

  // Skip hidden/system files that aren't images
  if ((fileName.startsWith('.') || fileName.startsWith('_')) && !mimeType.startsWith('image/')) {
    return { class: 'skip', skipReason: 'not_an_image' };
  }

  // Video / audio by MIME prefix
  for (const prefix of FORMAT_POLICY.skipByPrefix) {
    if (mimeType.startsWith(prefix)) {
      return {
        class: 'skip',
        skipReason: mimeType.startsWith('video/') ? 'video' : 'audio',
      } as ClassifyResult;
    }
  }

  // Skip by extension (catches video containers mislabeled by Drive)
  if (ext && FORMAT_POLICY.skipByExt.has(ext)) {
    const videoExts = new Set(['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm', '3gp', 'm4v']);
    return {
      class: 'skip',
      skipReason: videoExts.has(ext) ? 'video' : 'not_an_image',
    } as ClassifyResult;
  }

  // Copy (JPEG)
  if (FORMAT_POLICY.copy.has(mimeType)) {
    return { class: 'copy' };
  }

  // Convert by MIME
  if (FORMAT_POLICY.convert.has(mimeType)) {
    return { class: 'convert' };
  }

  // Convert by extension (RAW files reported as octet-stream)
  if (ext && FORMAT_POLICY.convertByExt.has(ext)) {
    return { class: 'convert' };
  }

  return { class: 'skip', skipReason: 'unsupported_format' };
}

// ─── Filename collision resolution ────────────────────────────────────────────

/**
 * Returns a dest filename that does not collide with existing dest names.
 *
 * Policy (decision D2):
 *   - Extension is always lowercased to .jpg
 *   - If <stem>.jpg is taken, try <stem>__2.jpg, <stem>__3.jpg, …
 *
 * @param sourceName   Original source filename (e.g. "IMG_5001.HEIC")
 * @param usedNames    Set of dest names already committed in this run + prior manifest rows
 */
export function resolveDestName(
  sourceName: string,
  usedNames: ReadonlySet<string>
): string {
  const lastDot = sourceName.lastIndexOf('.');
  const stem = lastDot >= 0 ? sourceName.substring(0, lastDot) : sourceName;
  const candidate = `${stem}.jpg`;

  if (!usedNames.has(candidate)) return candidate;

  let suffix = 2;
  while (true) {
    const withSuffix = `${stem}__${suffix}.jpg`;
    if (!usedNames.has(withSuffix)) return withSuffix;
    suffix++;
  }
}

// ─── Run-state helpers ────────────────────────────────────────────────────────

interface RunState {
  eventName: string;
  prepFolderId: string;
  uploadPrepRootId: string;
  eventFolderId: string;
  dryRun: boolean;
  copied: number;
  converted: number;
  skipped: number;
  errored: number;
  total: number; // running total of files seen so far
}

function cacheKey(runId: string): string {
  return `upload_prep_run_${runId}`;
}

/**
 * Persists run state to script-scoped PropertiesService so that any admin
 * (not just the one who started the run) can resume or check progress.
 * CacheService is user-scoped and would silently miss if a second admin
 * called uploadPrep_runBatch with the same runId.
 *
 * PropertiesService values are capped at 9 KB; RunState is ~300 bytes, well
 * within limits.
 */
function saveRunState(runId: string, state: RunState): void {
  PropertiesService.getScriptProperties().setProperty(
    cacheKey(runId),
    JSON.stringify(state)
  );
}

function loadRunState(runId: string): RunState | null {
  const raw = PropertiesService.getScriptProperties().getProperty(cacheKey(runId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RunState;
  } catch {
    return null;
  }
}

function deleteRunState(runId: string): void {
  PropertiesService.getScriptProperties().deleteProperty(cacheKey(runId));
}

// ─── UploadPrep folder helpers ────────────────────────────────────────────────

/**
 * Ensures the _UploadPrep/ root and _UploadPrep/<EventName>/ folders exist.
 * Creates them if missing. Returns their IDs.
 */
function ensureUploadPrepFolders(
  rootFolder: GoogleAppsScript.Drive.Folder,
  eventName: string
): { uploadPrepRootId: string; prepFolderId: string } {
  // Ensure _UploadPrep root
  let uploadPrepRoot: GoogleAppsScript.Drive.Folder;
  const rootIter = rootFolder.getFoldersByName(UPLOAD_PREP_ROOT_NAME);
  if (rootIter.hasNext()) {
    uploadPrepRoot = rootIter.next();
  } else {
    uploadPrepRoot = rootFolder.createFolder(UPLOAD_PREP_ROOT_NAME);
    Logger.log(`[uploadPrepService] Created _UploadPrep root folder`);
  }

  // Ensure _UploadPrep/<EventName>
  let prepFolder: GoogleAppsScript.Drive.Folder;
  const eventIter = uploadPrepRoot.getFoldersByName(eventName);
  if (eventIter.hasNext()) {
    prepFolder = eventIter.next();
  } else {
    prepFolder = uploadPrepRoot.createFolder(eventName);
    Logger.log(`[uploadPrepService] Created prep folder for event "${eventName}"`);
  }

  return {
    uploadPrepRootId: uploadPrepRoot.getId(),
    prepFolderId: prepFolder.getId(),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Lists all event folders in the SSOT root, sorted by name descending.
 * Excludes the _UploadPrep folder itself.
 */
export function listEventFolders(): Array<{ id: string; name: string }> {
  assertSuperAdmin();
  const config = getConfig();
  const rootFolder = DriveApp.getFolderById(config.ROOT_FOLDER_ID);
  const folders: Array<{ id: string; name: string }> = [];
  const iter = rootFolder.getFolders();
  while (iter.hasNext()) {
    const folder = iter.next();
    if (folder.getName() !== UPLOAD_PREP_ROOT_NAME) {
      folders.push({ id: folder.getId(), name: folder.getName() });
    }
  }
  return folders.sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * Returns quick prep statistics for the sidebar preview (before a run).
 * Does NOT start a run.
 */
export function getEventPrepStatus(eventFolderId: string): EventPrepStatus {
  assertSuperAdmin();

  const eventFolder = DriveApp.getFolderById(eventFolderId);
  const eventName = eventFolder.getName();
  const config = getConfig();
  const rootFolder = DriveApp.getFolderById(config.ROOT_FOLDER_ID);

  // Find the prep folder if it exists (don't create it here)
  let prepFolderId: string | null = null;
  const uploadPrepRootIter = rootFolder.getFoldersByName(UPLOAD_PREP_ROOT_NAME);
  if (uploadPrepRootIter.hasNext()) {
    const uploadPrepRoot = uploadPrepRootIter.next();
    const prepIter = uploadPrepRoot.getFoldersByName(eventName);
    if (prepIter.hasNext()) {
      prepFolderId = prepIter.next().getId();
    }
  }

  // Count source files (all files, any type)
  let sourceFileCount = 0;
  const fileIter = eventFolder.getFiles();
  while (fileIter.hasNext()) {
    fileIter.next();
    sourceFileCount++;
  }

  // Build the "already done" set from manifest
  let alreadyPreppedCount = 0;
  let lastRunAt: string | undefined;
  if (prepFolderId) {
    const rows = loadManifest(prepFolderId);
    const doneSet = new Set<string>();
    for (const row of rows) {
      if (row.action === 'copied' || row.action === 'converted') {
        doneSet.add(`${row.source_file_id}:${row.source_md5_checksum}`);
      }
      if (!lastRunAt || row.processed_at > lastRunAt) {
        lastRunAt = row.processed_at;
      }
    }
    alreadyPreppedCount = doneSet.size;
  }

  return {
    eventName,
    sourceFileCount,
    alreadyPreppedCount,
    newOrChangedCount: Math.max(0, sourceFileCount - alreadyPreppedCount),
    lastRunAt,
  };
}

/**
 * Initializes a new batch run and processes the first batch of files.
 * Call this to start a run; use prepareEventForUploadBatch() for continuation.
 *
 * Returns a PrepEventBatchResult. When done = false, pass continuationToken
 * back in the next call to continue processing.
 */
export function startUploadPrepRun(req: PrepEventRequest): PrepEventBatchResult {
  assertSuperAdmin();

  const runId = `run_${new Date().toISOString().replace(/[-:.]/g, '').substring(0, 15)}Z`;

  const eventFolder = DriveApp.getFolderById(req.eventFolderId);
  const eventName = eventFolder.getName();
  const config = getConfig();
  const rootFolder = DriveApp.getFolderById(config.ROOT_FOLDER_ID);

  const { uploadPrepRootId, prepFolderId } = ensureUploadPrepFolders(rootFolder, eventName);

  const initialState: RunState = {
    eventName,
    prepFolderId,
    uploadPrepRootId,
    eventFolderId: req.eventFolderId,
    dryRun: req.dryRun ?? false,
    copied: 0,
    converted: 0,
    skipped: 0,
    errored: 0,
    total: 0,
  };

  saveRunState(runId, initialState);

  return prepareEventForUploadBatch({
    ...req,
    runId,
    continuationToken: undefined,
  });
}

/**
 * Processes one batch of up to BATCH_SIZE files for an in-progress run.
 * Pass continuationToken from the previous batch's response.
 *
 * When the returned { done: true }, the run is complete and the manifest
 * and index have been written to Drive.
 */
export function prepareEventForUploadBatch(
  req: PrepEventBatchRequest
): PrepEventBatchResult {
  assertSuperAdmin();

  const state = loadRunState(req.runId);
  if (!state) {
    throw new Error(`Run "${req.runId}" not found in cache. It may have expired (6h TTL).`);
  }

  const dryRun = req.dryRun ?? state.dryRun;
  const force  = req.force ?? false;
  const { eventName, prepFolderId, uploadPrepRootId, eventFolderId } = state;

  // Load manifest and build lookup map + used-dest-names set
  const existingRows   = loadManifest(prepFolderId);
  const manifestMap    = new Map<string, ManifestRow>(); // key: source_file_id
  const usedDestNames  = new Set<string>();

  for (const row of existingRows) {
    manifestMap.set(row.source_file_id, row);
    if (row.dest_name) usedDestNames.add(row.dest_name);
  }

  // Resume file iteration
  const eventFolder = DriveApp.getFolderById(eventFolderId);
  const prepFolder  = DriveApp.getFolderById(prepFolderId);
  const fileIter    = req.continuationToken
    ? DriveApp.continueFileIterator(req.continuationToken)
    : eventFolder.getFiles();

  // Exclude _UploadPrep folder from source enumeration by collecting its file IDs
  // (Files in the prep folder won't appear in eventFolder.getFiles(), but this
  //  guard future-proofs against the prep folder being inside the event folder.)
  const prepFolderIdLocal = prepFolder.getId();

  const newRows: ManifestRow[] = [];
  let batchCopied    = 0;
  let batchConverted = 0;
  let batchSkipped   = 0;
  let batchErrored   = 0;
  let batchProcessed = 0;

  const processedAt = new Date().toISOString();

  while (fileIter.hasNext() && batchProcessed < BATCH_SIZE) {
    const file = fileIter.next();

    // Skip if this file lives inside the prep folder itself (shouldn't happen, but guard)
    try {
      const parents = file.getParents();
      let inPrepFolder = false;
      while (parents.hasNext()) {
        if (parents.next().getId() === prepFolderIdLocal) {
          inPrepFolder = true;
          break;
        }
      }
      if (inPrepFolder) continue;
    } catch {
      // If we can't determine parents, continue processing
    }

    const fileId  = file.getId();
    const fileName = file.getName();
    const mimeType = file.getMimeType();
    const md5      = (file as unknown as { getMd5Checksum?(): string }).getMd5Checksum?.() ?? '';
    const sizeByte = String(file.getSize());
    const modTime  = file.getLastUpdated().toISOString();

    batchProcessed++;
    state.total++;

    // ── Incremental skip check ────────────────────────────────────────────────
    if (!force) {
      const prior = manifestMap.get(fileId);
      if (prior && (prior.action === 'copied' || prior.action === 'converted') && prior.source_md5_checksum === md5) {
        // Already processed and unchanged — count as skipped in this run
        batchSkipped++;
        state.skipped++;
        // Record a row marking it as already_prepped
        newRows.push({
          event_name:           eventName,
          source_file_id:       fileId,
          source_name:          fileName,
          source_mime_type:     mimeType,
          source_md5_checksum:  md5,
          source_size_bytes:    sizeByte,
          source_modified_time: modTime,
          dest_file_id:         prior.dest_file_id,
          dest_name:            prior.dest_name,
          action:               'skipped',
          skip_reason:          'already_prepped',
          jpg_quality:          prior.jpg_quality,
          exif_preserved:       prior.exif_preserved,
          processed_at:         processedAt,
          run_id:               req.runId,
        });
        continue;
      }
    }

    // ── Classify ──────────────────────────────────────────────────────────────
    const classification = classifyFile(mimeType, fileName);

    if (classification.class === 'skip') {
      batchSkipped++;
      state.skipped++;
      const skipAction: ManifestAction = dryRun ? 'would_skip' : 'skipped';
      newRows.push(buildRow({
        eventName, fileId, fileName, mimeType, md5, sizeByte, modTime,
        destFileId: '', destName: '', action: skipAction,
        skipReason: classification.skipReason,
        jpgQuality: '', exifPreserved: '', processedAt, runId: req.runId,
      }));
      continue;
    }

    // ── Resolve destination filename ──────────────────────────────────────────
    const destName = resolveDestName(fileName, usedDestNames);
    usedDestNames.add(destName);

    // ── Execute ───────────────────────────────────────────────────────────────
    if (classification.class === 'copy') {
      if (dryRun) {
        batchSkipped++;
        state.skipped++;
        newRows.push(buildRow({
          eventName, fileId, fileName, mimeType, md5, sizeByte, modTime,
          destFileId: '', destName, action: 'would_copy',
          skipReason: '', jpgQuality: '', exifPreserved: '',
          processedAt, runId: req.runId,
        }));
      } else {
        try {
          const copiedFile = DriveApp.getFileById(fileId).makeCopy(destName, prepFolder);
          batchCopied++;
          state.copied++;
          newRows.push(buildRow({
            eventName, fileId, fileName, mimeType, md5, sizeByte, modTime,
            destFileId: copiedFile.getId(), destName, action: 'copied',
            skipReason: '', jpgQuality: '', exifPreserved: 'true',
            processedAt, runId: req.runId,
          }));
        } catch (err) {
          Logger.log(`[uploadPrepService] Copy failed for ${fileName}: ${String(err)}`);
          batchErrored++;
          state.errored++;
          newRows.push(buildRow({
            eventName, fileId, fileName, mimeType, md5, sizeByte, modTime,
            destFileId: '', destName, action: 'error',
            skipReason: `error: ${String(err)}`,
            jpgQuality: '', exifPreserved: '',
            processedAt, runId: req.runId,
          }));
        }
      }
    } else {
      // convert
      if (dryRun) {
        batchSkipped++;
        state.skipped++;
        newRows.push(buildRow({
          eventName, fileId, fileName, mimeType, md5, sizeByte, modTime,
          destFileId: '', destName, action: 'would_convert',
          skipReason: '', jpgQuality: String(JPG_QUALITY_DEFAULT), exifPreserved: 'true',
          processedAt, runId: req.runId,
        }));
      } else {
        const convertResp = convertImage({
          sourceFileId:    fileId,
          destFolderId:    prepFolderId,
          destName,
          jpgQuality:      JPG_QUALITY_DEFAULT,
          maxDim:          null,
          bakeOrientation: true,
          preserveExif:    true,
        });

        if (convertResp.ok && convertResp.destFileId) {
          batchConverted++;
          state.converted++;
          newRows.push(buildRow({
            eventName, fileId, fileName,
            mimeType: convertResp.sourceMimeType ?? mimeType,
            md5, sizeByte, modTime,
            destFileId: convertResp.destFileId, destName, action: 'converted',
            skipReason: '', jpgQuality: String(JPG_QUALITY_DEFAULT), exifPreserved: 'true',
            processedAt, runId: req.runId,
          }));
        } else {
          Logger.log(`[uploadPrepService] Conversion failed for ${fileName}: ${convertResp.message ?? convertResp.error}`);
          batchErrored++;
          state.errored++;
          newRows.push(buildRow({
            eventName, fileId, fileName, mimeType, md5, sizeByte, modTime,
            destFileId: '', destName, action: 'error',
            skipReason: `error: ${convertResp.message ?? convertResp.error ?? 'unknown'}`,
            jpgQuality: '', exifPreserved: '',
            processedAt, runId: req.runId,
          }));
        }
      }
    }
  }

  const done = !fileIter.hasNext();
  const continuationToken = done ? undefined : fileIter.getContinuationToken();

  // Write manifest with all prior rows replaced by fresh rows for this run
  // (existing done rows carry over; new rows are appended)
  const allRows = mergeManifestRows(existingRows, newRows);
  writeManifest(prepFolderId, allRows);

  if (done) {
    // Upsert the global index
    const actorEmail = Session.getEffectiveUser().getEmail();
    upsertIndex(uploadPrepRootId, {
      event_name:       eventName,
      event_folder_id:  eventFolderId,
      prep_folder_id:   prepFolderId,
      last_run_id:      req.runId,
      last_run_at:      processedAt,
      last_run_by:      actorEmail,
      files_total:      state.total,
      files_copied:     state.copied,
      files_converted:  state.converted,
      files_skipped:    state.skipped,
      files_errored:    state.errored,
    });

    deleteRunState(req.runId);
    Logger.log(
      `[uploadPrepService] Run ${req.runId} complete — ` +
      `total=${state.total} copied=${state.copied} converted=${state.converted} ` +
      `skipped=${state.skipped} errored=${state.errored}`
    );
  } else {
    saveRunState(req.runId, state);
  }

  return {
    runId: req.runId,
    eventName,
    done,
    continuationToken,
    batchCounts: {
      processed: batchProcessed,
      copied: batchCopied,
      converted: batchConverted,
      skipped: batchSkipped,
      errored: batchErrored,
    },
    totalSoFar: {
      total:     state.total,
      copied:    state.copied,
      converted: state.converted,
      skipped:   state.skipped,
      errored:   state.errored,
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Builds a ManifestRow from named parameters. */
function buildRow(p: {
  eventName: string; fileId: string; fileName: string; mimeType: string;
  md5: string; sizeByte: string; modTime: string;
  destFileId: string; destName: string; action: ManifestAction;
  skipReason: string; jpgQuality: string; exifPreserved: string;
  processedAt: string; runId: string;
}): ManifestRow {
  return {
    event_name:           p.eventName,
    source_file_id:       p.fileId,
    source_name:          p.fileName,
    source_mime_type:     p.mimeType,
    source_md5_checksum:  p.md5,
    source_size_bytes:    p.sizeByte,
    source_modified_time: p.modTime,
    dest_file_id:         p.destFileId,
    dest_name:            p.destName,
    action:               p.action,
    skip_reason:          p.skipReason,
    jpg_quality:          p.jpgQuality,
    exif_preserved:       p.exifPreserved,
    processed_at:         p.processedAt,
    run_id:               p.runId,
  };
}

/**
 * Merges prior manifest rows with new rows from the current run.
 * For each source_file_id, the new row (if any) replaces the old one.
 * Source files not seen in this run retain their existing rows.
 */
function mergeManifestRows(
  existing: ManifestRow[],
  newRows: ManifestRow[]
): ManifestRow[] {
  const newMap = new Map<string, ManifestRow>();
  for (const row of newRows) {
    newMap.set(row.source_file_id, row);
  }

  const merged: ManifestRow[] = [];
  for (const row of existing) {
    merged.push(newMap.has(row.source_file_id) ? newMap.get(row.source_file_id)! : row);
    newMap.delete(row.source_file_id);
  }
  // Append rows for files not previously in the manifest
  for (const row of newMap.values()) {
    merged.push(row);
  }
  return merged;
}
