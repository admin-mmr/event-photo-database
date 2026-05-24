/**
 * specialFoldersService.ts — consolidated photo + per-scope video shortcut folders.
 *
 * What this module owns
 * ─────────────────────
 * After every batch of photos finishes syncing to Google Photos, we maintain
 * two extra folder hierarchies inside Drive that admins asked for:
 *
 *   1. Per-event Photos folders, FLAT and INDEXED:
 *        <Event>/Photos_001/    ← shortcut to up to MAX_SHORTCUTS_PER_PHOTOS_FOLDER photos
 *        <Event>/Photos_002/    ← overflow when the previous folder fills up
 *        ...
 *      These folders sit as siblings of the existing club folders inside the
 *      event folder. Each holds Drive shortcut files (NOT copies) that point
 *      to every photo under any club / tag / batch beneath the event.
 *
 *   2. Per-(event, club, tag) Videos folder:
 *        <Event>/<Club>/<Tag>/Videos/  ← shortcuts to every video for that scope
 *      For legacy tag-less rows the folder hangs directly off the club folder.
 *
 * Every shortcut entry is a native Drive shortcut (mimeType
 * application/vnd.google-apps.shortcut), so opening it shows the original
 * file's preview/metadata and the original is never copied. See
 * driveShortcutClient.ts for the REST plumbing.
 *
 * State
 * ─────
 * Authoritative state for "which folders exist and what their counts are"
 * lives in the Special_Folders sheet. Each rebuild is idempotent — if a
 * folder already exists, we reuse its Drive ID and update the row in place.
 *
 * Triggering
 * ──────────
 * The hot path lives in photosService.syncBatchToAlbums(): after a
 * successful sync, that function calls tryRebuildSpecialFoldersForBatch().
 * The "try" wrapper swallows any error so a transient Drive API hiccup
 * never fails the upload pipeline.
 *
 * Performance
 * ───────────
 * Drive walks happen once per rebuild. For an event with 5,000 photos
 * spread across 20 (club, tag) buckets, the photo rebuild does roughly
 * one files.list page per batch folder and one files.create per new file
 * (existing shortcuts are deduped by targetId). All work fits comfortably
 * under the 6-minute GAS execution limit for events up to a few thousand
 * files; for very large events the caller should prefer to invoke the
 * scoped rebuild after each batch (incremental) rather than the full
 * rebuildEventPhotoFolders() call.
 */

import { ResultStatus } from '../types/enums';
import { ServiceResult } from '../types/responses';
import { SpecialFolderRecord, SpecialFolderScope } from '../types/models';
import {
  getConfig,
  PHOTOS_FOLDER_PREFIX,
  VIDEOS_FOLDER_NAME,
  MAX_SHORTCUTS_PER_PHOTOS_FOLDER,
  SPECIAL_FOLDERS_HEADERS,
} from '../config/constants';
import { PhotoMimeType, VideoMimeType } from '../types/enums';
import {
  getAllRows,
  appendRow,
  updateRow,
  ensureHeaders,
} from './sheetService';
import {
  toSpecialFolderRecord,
  fromSpecialFolderRecord,
} from '../utils/sheetMapper';
import {
  getFolderById,
  findSubfolder,
  getOrCreateSubfolder,
} from './driveService';
import { findById as findEventById } from './eventService';
import {
  createDriveShortcut,
  listShortcutsInFolder,
  driveFolderUrl,
} from './driveShortcutClient';
import {
  tryGrantAnyoneRead,
  grantAnyoneRead,
  foldBatchGrantSummary,
  EMPTY_BATCH_GRANT_SUMMARY,
  BatchGrantSummary,
} from './drivePermissionsService';
import { nowIsoTimestamp } from '../utils/dateFormatter';

/* global Logger */

// ─── Types ────────────────────────────────────────────────────────────────────

/** A photo or video file discovered while walking an event's Drive subtree. */
interface MediaFile {
  /** Drive file ID. */
  id: string;
  /** Original filename, e.g. "IMG_0042.JPG". */
  name: string;
  /** MIME type as Drive reports it. */
  mimeType: string;
}

/** Outcome envelope for a per-scope rebuild call. */
export interface RebuildResult {
  /** Number of new shortcut files created on this rebuild. */
  shortcutsCreated: number;
  /** Number of files we found that already had a shortcut (deduped). */
  shortcutsExisting: number;
  /** How many target files we considered (photos for scope='photos', videos for 'videos'). */
  targetFilesScanned: number;
  /** Number of distinct shortcut folders the rebuild touched (Photos_001, Photos_002, ... or 1 Videos folder). */
  foldersTouched: number;
  /** Soft errors collected during the rebuild — folder-creation or shortcut-creation failures we logged but didn't throw on. */
  warnings: string[];
}

// ─── MIME classification helpers ─────────────────────────────────────────────

/**
 * Set of MIME types that the Photos folders should index.
 * Mirrors PhotoMimeType so the classification stays in lock-step with the
 * rest of the Photos pipeline.
 */
export const PHOTO_TARGET_MIME_TYPES: ReadonlySet<string> = new Set(
  Object.values(PhotoMimeType)
);

/**
 * Set of MIME types that the Videos folders should index.
 * Mirrors VideoMimeType.
 */
export const VIDEO_TARGET_MIME_TYPES: ReadonlySet<string> = new Set(
  Object.values(VideoMimeType)
);

/** Returns true when a file's MIME type belongs in the consolidated Photos buckets. */
export function isPhotoFile(mimeType: string): boolean {
  return PHOTO_TARGET_MIME_TYPES.has(mimeType);
}

/** Returns true when a file's MIME type belongs in the per-scope Videos folder. */
export function isVideoFile(mimeType: string): boolean {
  return VIDEO_TARGET_MIME_TYPES.has(mimeType);
}

// ─── Folder name helpers ─────────────────────────────────────────────────────

/**
 * Returns the zero-padded folder name for the i-th Photos bucket.
 * 1 → "Photos_001", 42 → "Photos_042", 999 → "Photos_999".
 *
 * Pure function — exported for direct unit testing.
 */
export function photosFolderName(index1Based: number): string {
  if (index1Based < 1 || !Number.isFinite(index1Based)) {
    throw new Error(`photosFolderName: index must be a positive integer, got ${index1Based}`);
  }
  const padded = String(Math.floor(index1Based)).padStart(3, '0');
  return `${PHOTOS_FOLDER_PREFIX}${padded}`;
}

/**
 * Computes the 1-based bucket index for the (zero-based) sequential photo
 * position. With MAX_SHORTCUTS_PER_PHOTOS_FOLDER = 800:
 *   position 0..799    → bucket 1
 *   position 800..1599 → bucket 2
 *   ...
 *
 * Pure function — exported for direct unit testing of overflow math.
 */
export function bucketIndexForPosition(position0Based: number): number {
  if (position0Based < 0 || !Number.isFinite(position0Based)) {
    throw new Error(
      `bucketIndexForPosition: position must be a non-negative integer, got ${position0Based}`
    );
  }
  return Math.floor(position0Based / MAX_SHORTCUTS_PER_PHOTOS_FOLDER) + 1;
}

/**
 * Number of Photos_NNN buckets needed to hold `count` photos.
 * 0 photos → 0 buckets; 1..800 → 1; 801..1600 → 2; etc.
 *
 * Pure function — exported for direct unit testing.
 */
export function bucketCountForFiles(count: number): number {
  if (count <= 0 || !Number.isFinite(count)) return 0;
  return Math.ceil(count / MAX_SHORTCUTS_PER_PHOTOS_FOLDER);
}

// ─── Sheet helpers (Special_Folders) ─────────────────────────────────────────

/**
 * Loads every row in the Special_Folders sheet, mapped to typed records.
 * Malformed rows are silently skipped.
 *
 * Ensures the header is present so a fresh deployment that hasn't yet
 * created the sheet/header doesn't throw on the first call.
 */
function loadAllSpecialFolders(): { rows: unknown[][]; records: SpecialFolderRecord[] } {
  const config = getConfig();
  const name = config.SHEET_NAMES.SPECIAL_FOLDERS;
  ensureHeaders(name, [...SPECIAL_FOLDERS_HEADERS]);
  const rows = getAllRows(name);
  const records = rows
    .map(toSpecialFolderRecord)
    .filter((r): r is SpecialFolderRecord => r !== null);
  return { rows, records };
}

/** Public read-only accessor used by publicSpreadsheetService when rebuilding the Folders tab. */
export function listAllSpecialFolders(): SpecialFolderRecord[] {
  return loadAllSpecialFolders().records;
}

/**
 * Upserts a Special_Folders row keyed by folderId. Appends a new row when
 * folderId isn't yet present, otherwise updates the existing row in place.
 *
 * preloadedRows can be passed when the caller already holds the sheet's
 * raw rows (avoids an extra getAllRows call).
 */
function upsertSpecialFolderRow(
  record: SpecialFolderRecord,
  preloadedRows?: unknown[][]
): void {
  const config = getConfig();
  const name = config.SHEET_NAMES.SPECIAL_FOLDERS;
  const rows = preloadedRows ?? getAllRows(name);

  const idx = rows.findIndex(
    (row) => String(row[0] ?? '').trim() === record.folderId
  );

  if (idx < 0) {
    appendRow(name, fromSpecialFolderRecord(record));
    return;
  }
  // updateRow uses 1-based row indices and accounts for the header row.
  updateRow(name, idx + 2, fromSpecialFolderRecord(record));
}

// ─── Drive walking ───────────────────────────────────────────────────────────

/**
 * Walks every descendant folder of `eventFolder` and yields every
 * non-shortcut file we find that matches `accept`.
 *
 * Excludes:
 *   - Shortcut files themselves (so we don't index our own shortcuts and
 *     create a feedback loop).
 *   - Files inside any descendant whose name starts with PHOTOS_FOLDER_PREFIX
 *     or equals VIDEOS_FOLDER_NAME — those are the consolidated folders we
 *     manage; never scan them for fresh source files.
 *   - Files inside trashed folders (Drive's getFolders/getFiles already
 *     filter those out by default).
 *
 * The function is depth-first iterative to keep the GAS call stack shallow.
 */
function walkMediaFiles(
  rootFolder: GoogleAppsScript.Drive.Folder,
  accept: (mimeType: string) => boolean
): MediaFile[] {
  const out: MediaFile[] = [];
  const stack: GoogleAppsScript.Drive.Folder[] = [rootFolder];

  while (stack.length > 0) {
    const folder = stack.pop()!;

    // Files in this folder
    const files = folder.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      const mimeType = file.getMimeType();
      // Native Drive shortcuts also appear here; skip them so the consolidator
      // never tries to index its own shortcuts.
      if (mimeType === 'application/vnd.google-apps.shortcut') continue;
      if (!accept(mimeType)) continue;
      out.push({ id: file.getId(), name: file.getName(), mimeType });
    }

    // Recurse into child folders, skipping our own managed folders
    const children = folder.getFolders();
    while (children.hasNext()) {
      const child = children.next();
      const name = child.getName();
      if (
        name === VIDEOS_FOLDER_NAME ||
        name.startsWith(PHOTOS_FOLDER_PREFIX)
      ) {
        continue;
      }
      stack.push(child);
    }
  }

  return out;
}

/**
 * Resolves the (event, club, tag) folder where the per-scope Videos folder
 * should live. Mirrors the structure produced by the upload pipeline:
 *
 *   <Event>/<Club>/<Tag>/    ← when the upload link carries a tag
 *   <Event>/<Club>/          ← legacy links with empty tag
 *
 * Returns null when the club folder doesn't exist yet (which can happen if
 * the very first batch sync for a club fails before the Drive folder is
 * created — the rebuild becomes a no-op in that case).
 */
function resolveClubTagFolder(
  eventFolder: GoogleAppsScript.Drive.Folder,
  clubName: string,
  tag: string
): GoogleAppsScript.Drive.Folder | null {
  const clubFolder = findSubfolder(eventFolder, clubName);
  if (!clubFolder) return null;
  if (!tag.trim()) return clubFolder;
  return findSubfolder(clubFolder, tag) ?? null;
}

// ─── Public rebuild API ──────────────────────────────────────────────────────

/**
 * Rebuilds the consolidated Photos_NNN folders for one event.
 *
 * Walks every photo under the event subtree, partitions them into buckets of
 * up to MAX_SHORTCUTS_PER_PHOTOS_FOLDER, ensures the right number of
 * Photos_NNN folders exist directly under the event folder, and creates
 * shortcut files for any photos not yet linked.
 *
 * Idempotent: existing shortcuts are deduped by their targetId, so re-running
 * the function never produces duplicate shortcuts. New photos uploaded since
 * the last rebuild are appended into the latest bucket; when a bucket fills
 * up the next bucket is created on demand.
 *
 * Returns SUCCESS even if zero photos were found — an empty event simply
 * yields zero buckets.
 */
export function rebuildEventPhotoFolders(
  eventId: string
): ServiceResult<RebuildResult> {
  const event = findEventById(eventId);
  if (!event) {
    return {
      status: ResultStatus.ERROR,
      message: `Event "${eventId}" not found`,
    };
  }

  const eventFolderResult = getFolderById(event.driveFolderId);
  if (
    eventFolderResult.status !== ResultStatus.SUCCESS ||
    !eventFolderResult.data
  ) {
    return {
      status: ResultStatus.ERROR,
      message: `Cannot open event Drive folder "${event.driveFolderId}": ${eventFolderResult.message}`,
    };
  }
  const eventFolder = eventFolderResult.data;

  const photos = walkMediaFiles(eventFolder, isPhotoFile);
  // Stable order means a rebuild after a no-op upload never reshuffles
  // existing shortcuts: sort by Drive file ID (immutable, lexicographic).
  photos.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const warnings: string[] = [];
  let shortcutsCreated = 0;
  let shortcutsExisting = 0;
  let foldersTouched = 0;

  // Pre-load Special_Folders rows once — we'll upsert at most one row per bucket.
  const { rows: sheetRows } = loadAllSpecialFolders();

  if (photos.length === 0) {
    Logger.log(
      `[specialFoldersService.rebuildEventPhotoFolders] event=${eventId} ` +
      `no photos found under "${event.folderName}"; skipping bucket creation.`
    );
    return {
      status: ResultStatus.SUCCESS,
      message: 'No photos found; nothing to rebuild.',
      data: {
        shortcutsCreated: 0,
        shortcutsExisting: 0,
        targetFilesScanned: 0,
        foldersTouched: 0,
        warnings,
      },
    };
  }

  const totalBuckets = bucketCountForFiles(photos.length);
  const now = nowIsoTimestamp();

  for (let bucket = 1; bucket <= totalBuckets; bucket++) {
    const folderName = photosFolderName(bucket);
    const folderResult = getOrCreateSubfolder(eventFolder, folderName);
    if (
      folderResult.status !== ResultStatus.SUCCESS ||
      !folderResult.data
    ) {
      warnings.push(
        `Failed to create or open ${folderName}: ${folderResult.message}`
      );
      continue;
    }
    foldersTouched++;
    const bucketFolder = folderResult.data;
    const bucketFolderId = bucketFolder.getId();

    // Make this Photos_NNN bucket public ("Anyone with link → Viewer") so the
    // Folder Link rendered on the public spreadsheet works for unauthenticated
    // viewers. Idempotent — calling on an already-shared folder is a no-op.
    // Errors here NEVER fail the shortcut rebuild; share state self-heals on
    // the next sync. See drivePermissionsService.ts for the API contract.
    tryGrantAnyoneRead(bucketFolderId);

    // Slice of photos that belong in this bucket (0-based math, bucket is 1-based).
    const start = (bucket - 1) * MAX_SHORTCUTS_PER_PHOTOS_FOLDER;
    const end = Math.min(
      start + MAX_SHORTCUTS_PER_PHOTOS_FOLDER,
      photos.length
    );

    // Existing shortcuts inside this bucket — dedupe by targetId.
    const existing = listShortcutsInFolder(bucketFolderId);
    const linkedTargetIds = new Set(existing.map((s) => s.targetId));

    for (let i = start; i < end; i++) {
      const photo = photos[i];
      if (linkedTargetIds.has(photo.id)) {
        shortcutsExisting++;
        continue;
      }
      const created = createDriveShortcut(bucketFolderId, photo.id, photo.name);
      if (!created.ok) {
        warnings.push(
          `Failed to link ${photo.name} (${photo.id}) into ${folderName}: ${created.error}`
        );
        continue;
      }
      shortcutsCreated++;
      linkedTargetIds.add(photo.id);
    }

    upsertSpecialFolderRow(
      {
        folderId: bucketFolderId,
        eventId,
        scope: 'photos' as SpecialFolderScope,
        clubName: '',
        tag: '',
        folderName,
        folderIndex: bucket,
        folderUrl: driveFolderUrl(bucketFolderId),
        fileCount: end - start,
        lastRefreshedAt: now,
      },
      sheetRows
    );
  }

  Logger.log(
    `[specialFoldersService.rebuildEventPhotoFolders] event=${eventId} ` +
    `photos=${photos.length} buckets=${totalBuckets} created=${shortcutsCreated} ` +
    `existing=${shortcutsExisting} warnings=${warnings.length}`
  );

  return {
    status: ResultStatus.SUCCESS,
    message:
      `Rebuilt ${foldersTouched} Photos_NNN folder(s) for "${event.folderName}": ` +
      `${shortcutsCreated} new shortcut(s), ${shortcutsExisting} already linked`,
    data: {
      shortcutsCreated,
      shortcutsExisting,
      targetFilesScanned: photos.length,
      foldersTouched,
      warnings,
    },
  };
}

/**
 * Rebuilds the per-(event, club, tag) Videos folder.
 *
 * Locates the existing club / tag Drive folder, ensures a sibling folder
 * named VIDEOS_FOLDER_NAME exists, and links every video under the (event,
 * club, tag) subtree into it as a Drive shortcut.
 *
 * No-ops gracefully when the club / tag folder is missing (haven't synced
 * a batch yet) or when no videos are found under the scope.
 */
export function rebuildClubVideoFolder(
  eventId: string,
  clubName: string,
  tag: string
): ServiceResult<RebuildResult> {
  const event = findEventById(eventId);
  if (!event) {
    return {
      status: ResultStatus.ERROR,
      message: `Event "${eventId}" not found`,
    };
  }

  const eventFolderResult = getFolderById(event.driveFolderId);
  if (
    eventFolderResult.status !== ResultStatus.SUCCESS ||
    !eventFolderResult.data
  ) {
    return {
      status: ResultStatus.ERROR,
      message: `Cannot open event Drive folder "${event.driveFolderId}": ${eventFolderResult.message}`,
    };
  }
  const eventFolder = eventFolderResult.data;

  const scopeFolder = resolveClubTagFolder(eventFolder, clubName, tag);
  if (!scopeFolder) {
    Logger.log(
      `[specialFoldersService.rebuildClubVideoFolder] event=${eventId} ` +
      `club=${clubName} tag="${tag}" — scope folder not yet on Drive; skipping.`
    );
    return {
      status: ResultStatus.SUCCESS,
      message: 'Scope folder not present on Drive; nothing to do.',
      data: {
        shortcutsCreated: 0,
        shortcutsExisting: 0,
        targetFilesScanned: 0,
        foldersTouched: 0,
        warnings: [],
      },
    };
  }

  const videos = walkMediaFiles(scopeFolder, isVideoFile);
  videos.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const warnings: string[] = [];
  let shortcutsCreated = 0;
  let shortcutsExisting = 0;
  let foldersTouched = 0;

  if (videos.length === 0) {
    Logger.log(
      `[specialFoldersService.rebuildClubVideoFolder] event=${eventId} ` +
      `club=${clubName} tag="${tag}" — no videos under scope; skipping folder creation.`
    );
    return {
      status: ResultStatus.SUCCESS,
      message: 'No videos found under (event, club, tag); nothing to rebuild.',
      data: {
        shortcutsCreated: 0,
        shortcutsExisting: 0,
        targetFilesScanned: 0,
        foldersTouched: 0,
        warnings,
      },
    };
  }

  const folderResult = getOrCreateSubfolder(scopeFolder, VIDEOS_FOLDER_NAME);
  if (folderResult.status !== ResultStatus.SUCCESS || !folderResult.data) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to create or open ${VIDEOS_FOLDER_NAME} folder: ${folderResult.message}`,
    };
  }
  foldersTouched = 1;
  const videosFolder = folderResult.data;
  const videosFolderId = videosFolder.getId();

  // Make the Videos folder public so the Folder Link works for unauthenticated
  // viewers — same rationale as the Photos_NNN buckets above.
  tryGrantAnyoneRead(videosFolderId);

  const existing = listShortcutsInFolder(videosFolderId);
  const linkedTargetIds = new Set(existing.map((s) => s.targetId));

  for (const v of videos) {
    if (linkedTargetIds.has(v.id)) {
      shortcutsExisting++;
      continue;
    }
    const created = createDriveShortcut(videosFolderId, v.id, v.name);
    if (!created.ok) {
      warnings.push(
        `Failed to link ${v.name} (${v.id}) into ${VIDEOS_FOLDER_NAME}: ${created.error}`
      );
      continue;
    }
    shortcutsCreated++;
    linkedTargetIds.add(v.id);
  }

  upsertSpecialFolderRow({
    folderId: videosFolderId,
    eventId,
    scope: 'videos' as SpecialFolderScope,
    clubName,
    tag,
    folderName: VIDEOS_FOLDER_NAME,
    folderIndex: 1,
    folderUrl: driveFolderUrl(videosFolderId),
    fileCount: videos.length,
    lastRefreshedAt: nowIsoTimestamp(),
  });

  Logger.log(
    `[specialFoldersService.rebuildClubVideoFolder] event=${eventId} ` +
    `club=${clubName} tag="${tag}" videos=${videos.length} ` +
    `created=${shortcutsCreated} existing=${shortcutsExisting} warnings=${warnings.length}`
  );

  return {
    status: ResultStatus.SUCCESS,
    message:
      `Rebuilt ${VIDEOS_FOLDER_NAME} for ${clubName}/${tag || '(no tag)'}: ` +
      `${shortcutsCreated} new shortcut(s), ${shortcutsExisting} already linked`,
    data: {
      shortcutsCreated,
      shortcutsExisting,
      targetFilesScanned: videos.length,
      foldersTouched,
      warnings,
    },
  };
}

// ─── Per-event full rebuild ───────────────────────────────────────────────────

/** Aggregate result returned by rebuildAllSpecialFoldersForEvent. */
export interface RebuildAllResult {
  photos: ServiceResult<RebuildResult>;
  videoResults: Array<{
    clubName: string;
    tag: string;
    result: ServiceResult<RebuildResult>;
  }>;
}

/**
 * Rebuilds Photos_NNN AND all Videos folders for one event.
 *
 * Photos: delegates to rebuildEventPhotoFolders — walks every photo under the
 * event subtree and partitions them into Photos_001, Photos_002, … buckets.
 *
 * Videos: enumerates every first-level club subfolder under the event, then
 * every second-level tag subfolder under each club. For each (club, '') scope
 * AND each (club, tag) scope it calls rebuildClubVideoFolder, which creates
 * (or updates) a sibling Videos/ folder containing shortcuts to every video
 * in that scope.
 *
 * Returns a structured result so the caller can surface per-scope outcomes.
 * Errors inside individual scopes are captured, not thrown, so a single
 * failing club folder never aborts the rest of the rebuild.
 */
export function rebuildAllSpecialFoldersForEvent(eventId: string): RebuildAllResult {
  const photos = rebuildEventPhotoFolders(eventId);

  const event = findEventById(eventId);
  const videoResults: RebuildAllResult['videoResults'] = [];

  if (!event) return { photos, videoResults };

  const eventFolderResult = getFolderById(event.driveFolderId);
  if (
    eventFolderResult.status !== ResultStatus.SUCCESS ||
    !eventFolderResult.data
  ) {
    return { photos, videoResults };
  }

  const eventFolder = eventFolderResult.data;
  const clubIter = eventFolder.getFolders();

  while (clubIter.hasNext()) {
    const clubFolder = clubIter.next();
    const clubName = clubFolder.getName();

    // Skip the managed Photos_NNN and any Videos folders at the event level.
    if (
      clubName.startsWith(PHOTOS_FOLDER_PREFIX) ||
      clubName === VIDEOS_FOLDER_NAME
    ) {
      continue;
    }

    // Rebuild for (club, '') — videos living directly inside the club folder.
    try {
      videoResults.push({
        clubName,
        tag: '',
        result: rebuildClubVideoFolder(eventId, clubName, ''),
      });
    } catch (err) {
      Logger.log(
        `[specialFoldersService.rebuildAllSpecialFoldersForEvent] event=${eventId} ` +
        `club=${clubName} tag="" threw: ${String(err)}`
      );
    }

    // Rebuild for each tag subfolder inside the club folder.
    const tagIter = clubFolder.getFolders();
    while (tagIter.hasNext()) {
      const tagFolder = tagIter.next();
      const tag = tagFolder.getName();
      if (tag === VIDEOS_FOLDER_NAME) continue; // skip any stray Videos folder
      try {
        videoResults.push({
          clubName,
          tag,
          result: rebuildClubVideoFolder(eventId, clubName, tag),
        });
      } catch (err) {
        Logger.log(
          `[specialFoldersService.rebuildAllSpecialFoldersForEvent] event=${eventId} ` +
          `club=${clubName} tag="${tag}" threw: ${String(err)}`
        );
      }
    }
  }

  return { photos, videoResults };
}

/**
 * Best-effort wrapper called by the post-batch-sync hot path. Refreshes both
 * the per-event Photos_NNN folders and the (event, club, tag) Videos folder
 * after a successful batch sync. Swallows every error and logs it — special
 * folders are a downstream convenience, never a source of truth, so a
 * transient Drive API failure must not fail the upload.
 */
export function tryRebuildSpecialFoldersForBatch(
  eventId: string,
  clubName: string,
  tag: string
): void {
  try {
    const photoResult = rebuildEventPhotoFolders(eventId);
    if (photoResult.status !== ResultStatus.SUCCESS) {
      Logger.log(
        `[specialFoldersService.tryRebuildSpecialFoldersForBatch] event=${eventId} ` +
        `photos rebuild non-fatal failure: ${photoResult.message}`
      );
    }
  } catch (err) {
    Logger.log(
      `[specialFoldersService.tryRebuildSpecialFoldersForBatch] event=${eventId} ` +
      `photos rebuild threw: ${String(err)}`
    );
  }

  try {
    const videoResult = rebuildClubVideoFolder(eventId, clubName, tag);
    if (videoResult.status !== ResultStatus.SUCCESS) {
      Logger.log(
        `[specialFoldersService.tryRebuildSpecialFoldersForBatch] event=${eventId} ` +
        `club=${clubName} tag="${tag}" videos rebuild non-fatal failure: ${videoResult.message}`
      );
    }
  } catch (err) {
    Logger.log(
      `[specialFoldersService.tryRebuildSpecialFoldersForBatch] event=${eventId} ` +
      `club=${clubName} tag="${tag}" videos rebuild threw: ${String(err)}`
    );
  }
}

// ─── Backfill sharing on every existing special folder ──────────────────────

/**
 * Walks every row in the Special_Folders sheet and grants
 * "Anyone with link → Viewer" on each folder.
 *
 * Purpose
 *   New folders created by syncBatchToAlbums after the sharing hook landed
 *   are public by construction. This one-shot routine retroactively shares
 *   every Photos_NNN / Videos folder that pre-dates the hook so the public
 *   spreadsheet's Folder Link column becomes usable immediately for older
 *   events.
 *
 * Idempotent — calling it repeatedly on a fully-shared catalogue is a no-op
 * (each individual grantAnyoneRead returns outcome='exists'). Safe to
 * schedule as a periodic trigger if desired, though one-time use is the
 * intended workflow.
 *
 * Performance — one Drive API round-trip per folder, ~150 ms each. With
 * hundreds of folders the total runtime stays well under the 6-minute GAS
 * execution cap. If the catalogue ever grows past a few thousand folders,
 * paginate by event in a time-driven trigger.
 *
 * Errors are absorbed (never thrown) so a partial failure leaves the rest
 * of the catalogue in a healed state. The returned summary tells the
 * caller exactly how many folders changed state.
 */
export function backfillSpecialFoldersSharing(): BatchGrantSummary {
  let summary: BatchGrantSummary = EMPTY_BATCH_GRANT_SUMMARY;

  let records: ReadonlyArray<SpecialFolderRecord>;
  try {
    records = loadAllSpecialFolders().records;
  } catch (err) {
    Logger.log(
      `[specialFoldersService.backfillSpecialFoldersSharing] ` +
      `Could not load Special_Folders sheet: ${String(err)}`
    );
    return summary;
  }

  if (records.length === 0) {
    Logger.log(
      `[specialFoldersService.backfillSpecialFoldersSharing] ` +
      `Special_Folders sheet is empty — nothing to share.`
    );
    return summary;
  }

  for (const r of records) {
    if (!r.folderId) continue;
    // Use the strict (non-try) variant so the summary can distinguish
    // "exists" from "created" — tryGrantAnyoneRead would log success twice.
    const result = grantAnyoneRead(r.folderId);
    summary = foldBatchGrantSummary(
      summary,
      result,
      `${r.scope}/${r.folderName}(${r.folderId})`
    );
  }

  Logger.log(
    `[specialFoldersService.backfillSpecialFoldersSharing] ` +
    `Done: created=${summary.created} alreadyShared=${summary.alreadyShared} ` +
    `errors=${summary.errors} (of ${records.length} folder(s))`
  );
  return summary;
}

