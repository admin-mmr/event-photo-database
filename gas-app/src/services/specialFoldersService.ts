/**
 * specialFoldersService.ts — consolidated photo + per-scope video shortcut folders.
 *
 * What this module owns
 * ─────────────────────
 * After every batch upload finishes writing photos and videos to Drive, we
 * maintain two extra folder hierarchies inside Drive that admins asked for:
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
 *   3. Per-(event, club, tag) Album folder (sibling of Videos):
 *        <Event>/<Club>/<Tag>/Album/   ← shortcuts to EVERY uploaded file
 *                                        (photos AND videos) for that scope
 *      Album rows (scope='albums') feed the per-club tabs on the public sheet.
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
 * Callers invoke tryRebuildSpecialFoldersForBatch() (or one of the
 * rebuild* helpers) after upload completion or admin folder edits.
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
  ALBUM_FOLDER_NAME,
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
  trashDriveFile,
  driveFolderUrl,
  ShortcutEntry,
} from './driveShortcutClient';
import {
  tryGrantAnyoneRead,
  grantAnyoneRead,
  foldBatchGrantSummary,
  EMPTY_BATCH_GRANT_SUMMARY,
  BatchGrantSummary,
} from './drivePermissionsService';
import { nowIsoTimestamp } from '../utils/dateFormatter';
import { parseNoisyName } from '../utils/noisyName';

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

/**
 * Returns true when a file's MIME type belongs in the per-scope Album folder.
 * Albums index EVERY uploaded media file — photos AND videos.
 */
export function isMediaFile(mimeType: string): boolean {
  return isPhotoFile(mimeType) || isVideoFile(mimeType);
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

/**
 * Plans a within-folder shortcut dedupe: when several shortcuts in the same
 * folder point at the *same* target file, only one should survive.
 *
 * Why this happens — the rebuilds only ever ADD shortcuts and dedupe by
 * targetId at creation time, so they never produce a duplicate. But a person
 * using drive.google.com directly can "Make a copy" of a shortcut, yielding a
 * second shortcut ("Copy of …") with the *same* targetId. The orphan-shortcut
 * sweep (removeShortcutsForTargets) won't touch it because its target is still
 * alive — so it lingers in the public-browse folders.
 *
 * Keeper rule (per targetId group):
 *   1. Prefer a clean name over a "Copy of …"/" (N)" decorated one, so the
 *      public folder shows "IMG_0017.jpeg" rather than "Copy of IMG_0017.jpeg".
 *   2. Tie-break on the lexicographically smallest shortcut id for a stable,
 *      deterministic choice.
 *
 * Pure — no Drive I/O — so it's exported for direct unit testing.
 *
 * @param existing  Shortcuts currently in one folder (from listShortcutsInFolder)
 * @returns survivors (one per targetId) and the shortcut ids to trash
 */
export function planShortcutDedupe(
  existing: ReadonlyArray<ShortcutEntry>
): { survivors: ShortcutEntry[]; trashShortcutIds: string[] } {
  const byTarget = new Map<string, ShortcutEntry[]>();
  for (const s of existing) {
    const group = byTarget.get(s.targetId);
    if (group) group.push(s);
    else byTarget.set(s.targetId, [s]);
  }

  const survivors: ShortcutEntry[] = [];
  const trashShortcutIds: string[] = [];

  for (const group of byTarget.values()) {
    if (group.length === 1) {
      survivors.push(group[0]);
      continue;
    }
    const ranked = [...group].sort((a, b) => {
      const aNoisy = parseNoisyName(a.name).noisy ? 1 : 0;
      const bNoisy = parseNoisyName(b.name).noisy ? 1 : 0;
      if (aNoisy !== bNoisy) return aNoisy - bNoisy; // clean name wins
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // deterministic tie-break
    });
    survivors.push(ranked[0]);
    for (let i = 1; i < ranked.length; i++) trashShortcutIds.push(ranked[i].id);
  }

  return { survivors, trashShortcutIds };
}

/**
 * Applies planShortcutDedupe to one folder's shortcut list: trashes the
 * redundant copies and returns the survivor list to drive the rest of the
 * rebuild. Best-effort — a failed trash is recorded in `warnings` and left in
 * place to retry next rebuild; the survivor list still has exactly one entry
 * per targetId, so the rebuild never re-creates a shortcut for those targets.
 */
function dedupeFolderShortcuts(
  existing: ShortcutEntry[],
  folderName: string,
  warnings: string[]
): { survivors: ShortcutEntry[]; removed: number } {
  const { survivors, trashShortcutIds } = planShortcutDedupe(existing);
  if (trashShortcutIds.length === 0) return { survivors, removed: 0 };

  let removed = 0;
  for (const id of trashShortcutIds) {
    const trashed = trashDriveFile(id);
    if (trashed.ok) {
      removed++;
    } else {
      warnings.push(
        `Failed to trash duplicate shortcut ${id} in ${folderName}: ${trashed.error}`
      );
    }
  }
  return { survivors, removed };
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
 * Returns the ISO 8601 timestamp of the most recently refreshed Special_Folders
 * record, or null when the sheet is empty.
 *
 * Used by the lazy public-sheet refresh trigger: if every Special_Folders row
 * has a lastRefreshedAt that is >= the latest Upload_Log uploadTimestamp, the
 * public sheet is already current and the refresh can be skipped.
 */
export function getLatestRefreshedAt(): string | null {
  const records = loadAllSpecialFolders().records;
  let latest: string | null = null;
  for (const r of records) {
    if (!r.lastRefreshedAt) continue;
    if (latest === null || r.lastRefreshedAt > latest) {
      latest = r.lastRefreshedAt;
    }
  }
  return latest;
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
 *     or equals VIDEOS_FOLDER_NAME / ALBUM_FOLDER_NAME — those are the
 *     consolidated folders we manage; never scan them for fresh source files.
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
        name === ALBUM_FOLDER_NAME ||
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
  let shortcutsDeduped = 0;
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

    // Existing shortcuts inside this bucket. First collapse any same-target
    // duplicates (e.g. a manual "Make a copy" of a shortcut on drive.google.com),
    // then dedupe links by targetId.
    const existingRaw = listShortcutsInFolder(bucketFolderId);
    const { survivors: existing, removed: dupShortcutsRemoved } =
      dedupeFolderShortcuts(existingRaw, folderName, warnings);
    if (dupShortcutsRemoved > 0) shortcutsDeduped += dupShortcutsRemoved;
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
    `existing=${shortcutsExisting} deduped=${shortcutsDeduped} warnings=${warnings.length}`
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
 * Per-scope spec describing one kind of (event, club, tag) shortcut folder.
 * Used by rebuildClubScopedFolder to share the rebuild algorithm between the
 * Videos folder (videos only) and the Album folder (every uploaded file).
 */
interface ClubScopedFolderSpec {
  /** Special_Folders scope value written into the sheet row. */
  readonly scope: SpecialFolderScope;
  /** Drive folder name, e.g. "Videos" or "Album". */
  readonly folderName: string;
  /** MIME filter selecting which files get a shortcut. */
  readonly accept: (mimeType: string) => boolean;
  /** Human noun for log/result messages, e.g. "videos" or "files". */
  readonly noun: string;
  /** Log prefix, e.g. "rebuildClubVideoFolder". */
  readonly logName: string;
}

const VIDEOS_FOLDER_SPEC: ClubScopedFolderSpec = {
  scope: 'videos',
  folderName: VIDEOS_FOLDER_NAME,
  accept: isVideoFile,
  noun: 'videos',
  logName: 'rebuildClubVideoFolder',
};

const ALBUM_FOLDER_SPEC: ClubScopedFolderSpec = {
  scope: 'albums',
  folderName: ALBUM_FOLDER_NAME,
  accept: isMediaFile,
  noun: 'files',
  logName: 'rebuildClubAlbumFolder',
};

/**
 * Shared rebuild for one per-(event, club, tag) shortcut folder (Videos or
 * Album).
 *
 * Locates the existing club / tag Drive folder, ensures a child folder named
 * spec.folderName exists, and links every matching file under the (event,
 * club, tag) subtree into it as a Drive shortcut.
 *
 * No-ops gracefully when the club / tag folder is missing (haven't synced
 * a batch yet) or when no matching files are found under the scope.
 */
function rebuildClubScopedFolder(
  eventId: string,
  clubName: string,
  tag: string,
  spec: ClubScopedFolderSpec
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
      `[specialFoldersService.${spec.logName}] event=${eventId} ` +
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

  const targets = walkMediaFiles(scopeFolder, spec.accept);
  targets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const warnings: string[] = [];
  let shortcutsCreated = 0;
  let shortcutsExisting = 0;
  let foldersTouched = 0;

  if (targets.length === 0) {
    Logger.log(
      `[specialFoldersService.${spec.logName}] event=${eventId} ` +
      `club=${clubName} tag="${tag}" — no ${spec.noun} under scope; skipping folder creation.`
    );
    return {
      status: ResultStatus.SUCCESS,
      message: `No ${spec.noun} found under (event, club, tag); nothing to rebuild.`,
      data: {
        shortcutsCreated: 0,
        shortcutsExisting: 0,
        targetFilesScanned: 0,
        foldersTouched: 0,
        warnings,
      },
    };
  }

  const folderResult = getOrCreateSubfolder(scopeFolder, spec.folderName);
  if (folderResult.status !== ResultStatus.SUCCESS || !folderResult.data) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to create or open ${spec.folderName} folder: ${folderResult.message}`,
    };
  }
  foldersTouched = 1;
  const shortcutFolder = folderResult.data;
  const shortcutFolderId = shortcutFolder.getId();

  // Make the folder public so the Folder Link works for unauthenticated
  // viewers — same rationale as the Photos_NNN buckets above.
  tryGrantAnyoneRead(shortcutFolderId);

  // Collapse same-target duplicate shortcuts (e.g. a manual "Make a copy" of a
  // shortcut) before linking, so the folder holds one shortcut per target.
  const existingRaw = listShortcutsInFolder(shortcutFolderId);
  const { survivors: existing, removed: shortcutsDeduped } =
    dedupeFolderShortcuts(existingRaw, spec.folderName, warnings);
  const linkedTargetIds = new Set(existing.map((s) => s.targetId));

  for (const f of targets) {
    if (linkedTargetIds.has(f.id)) {
      shortcutsExisting++;
      continue;
    }
    const created = createDriveShortcut(shortcutFolderId, f.id, f.name);
    if (!created.ok) {
      warnings.push(
        `Failed to link ${f.name} (${f.id}) into ${spec.folderName}: ${created.error}`
      );
      continue;
    }
    shortcutsCreated++;
    linkedTargetIds.add(f.id);
  }

  upsertSpecialFolderRow({
    folderId: shortcutFolderId,
    eventId,
    scope: spec.scope,
    clubName,
    tag,
    folderName: spec.folderName,
    folderIndex: 1,
    folderUrl: driveFolderUrl(shortcutFolderId),
    fileCount: targets.length,
    lastRefreshedAt: nowIsoTimestamp(),
  });

  Logger.log(
    `[specialFoldersService.${spec.logName}] event=${eventId} ` +
    `club=${clubName} tag="${tag}" ${spec.noun}=${targets.length} ` +
    `created=${shortcutsCreated} existing=${shortcutsExisting} ` +
    `deduped=${shortcutsDeduped} warnings=${warnings.length}`
  );

  return {
    status: ResultStatus.SUCCESS,
    message:
      `Rebuilt ${spec.folderName} for ${clubName}/${tag || '(no tag)'}: ` +
      `${shortcutsCreated} new shortcut(s), ${shortcutsExisting} already linked`,
    data: {
      shortcutsCreated,
      shortcutsExisting,
      targetFilesScanned: targets.length,
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
  return rebuildClubScopedFolder(eventId, clubName, tag, VIDEOS_FOLDER_SPEC);
}

/**
 * Rebuilds the per-(event, club, tag) Album folder.
 *
 * Same algorithm as rebuildClubVideoFolder, but the Album folder receives a
 * shortcut for EVERY uploaded file under the scope — photos AND videos. The
 * resulting scope='albums' rows feed the per-club tabs on the public sheet.
 */
export function rebuildClubAlbumFolder(
  eventId: string,
  clubName: string,
  tag: string
): ServiceResult<RebuildResult> {
  return rebuildClubScopedFolder(eventId, clubName, tag, ALBUM_FOLDER_SPEC);
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
  albumResults: Array<{
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
 * Videos + Albums: enumerates every first-level club subfolder under the
 * event, then every second-level tag subfolder under each club. For each
 * (club, '') scope AND each (club, tag) scope it calls rebuildClubVideoFolder
 * (sibling Videos/ folder with shortcuts to every video) and
 * rebuildClubAlbumFolder (sibling Album/ folder with shortcuts to EVERY
 * uploaded file in that scope).
 *
 * Returns a structured result so the caller can surface per-scope outcomes.
 * Errors inside individual scopes are captured, not thrown, so a single
 * failing club folder never aborts the rest of the rebuild.
 */
export function rebuildAllSpecialFoldersForEvent(eventId: string): RebuildAllResult {
  const photos = rebuildEventPhotoFolders(eventId);

  const event = findEventById(eventId);
  const videoResults: RebuildAllResult['videoResults'] = [];
  const albumResults: RebuildAllResult['albumResults'] = [];

  if (!event) return { photos, videoResults, albumResults };

  const eventFolderResult = getFolderById(event.driveFolderId);
  if (
    eventFolderResult.status !== ResultStatus.SUCCESS ||
    !eventFolderResult.data
  ) {
    return { photos, videoResults, albumResults };
  }

  const eventFolder = eventFolderResult.data;
  const clubIter = eventFolder.getFolders();

  // Rebuilds Videos + Album for one (club, tag) scope, capturing errors.
  const rebuildScope = (clubName: string, tag: string): void => {
    try {
      videoResults.push({
        clubName,
        tag,
        result: rebuildClubVideoFolder(eventId, clubName, tag),
      });
    } catch (err) {
      Logger.log(
        `[specialFoldersService.rebuildAllSpecialFoldersForEvent] event=${eventId} ` +
        `club=${clubName} tag="${tag}" videos threw: ${String(err)}`
      );
    }
    try {
      albumResults.push({
        clubName,
        tag,
        result: rebuildClubAlbumFolder(eventId, clubName, tag),
      });
    } catch (err) {
      Logger.log(
        `[specialFoldersService.rebuildAllSpecialFoldersForEvent] event=${eventId} ` +
        `club=${clubName} tag="${tag}" albums threw: ${String(err)}`
      );
    }
  };

  while (clubIter.hasNext()) {
    const clubFolder = clubIter.next();
    const clubName = clubFolder.getName();

    // Skip the managed Photos_NNN / Videos / Album folders at the event level.
    if (
      clubName.startsWith(PHOTOS_FOLDER_PREFIX) ||
      clubName === VIDEOS_FOLDER_NAME ||
      clubName === ALBUM_FOLDER_NAME
    ) {
      continue;
    }

    // Rebuild for (club, '') — files living directly inside the club folder.
    rebuildScope(clubName, '');

    // Rebuild for each tag subfolder inside the club folder.
    const tagIter = clubFolder.getFolders();
    while (tagIter.hasNext()) {
      const tagFolder = tagIter.next();
      const tag = tagFolder.getName();
      // Skip our own managed shortcut folders.
      if (tag === VIDEOS_FOLDER_NAME || tag === ALBUM_FOLDER_NAME) continue;
      rebuildScope(clubName, tag);
    }
  }

  return { photos, videoResults, albumResults };
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

  try {
    const albumResult = rebuildClubAlbumFolder(eventId, clubName, tag);
    if (albumResult.status !== ResultStatus.SUCCESS) {
      Logger.log(
        `[specialFoldersService.tryRebuildSpecialFoldersForBatch] event=${eventId} ` +
        `club=${clubName} tag="${tag}" albums rebuild non-fatal failure: ${albumResult.message}`
      );
    }
  } catch (err) {
    Logger.log(
      `[specialFoldersService.tryRebuildSpecialFoldersForBatch] event=${eventId} ` +
      `club=${clubName} tag="${tag}" albums rebuild threw: ${String(err)}`
    );
  }
}

// ─── Orphan-shortcut sweep ───────────────────────────────────────────────────

/** Outcome of removeShortcutsForTargets. */
export interface ShortcutSweepResult {
  /** Shortcut files moved to trash. */
  shortcutsRemoved: number;
  /** Shortcut folders that contained at least one removed shortcut. */
  foldersTouched: number;
  /** Soft errors (per-shortcut trash failures); never thrown. */
  errors: string[];
}

/**
 * Removes shortcuts pointing at the given target file IDs from EVERY managed
 * shortcut folder (Photos_NNN, Videos, Album) recorded in Special_Folders.
 *
 * Why: the rebuilds only ever ADD shortcuts. When an original file is
 * soft-deleted (e.g. by the duplicate cleanup flow) its shortcuts would
 * otherwise dangle in the public-browse folders. Call this right after a
 * batch of soft-deletes with the deleted Drive file IDs.
 *
 * Shortcuts are TRASHED (not hard-deleted) so a mistaken sweep is fully
 * recoverable; restoring the original file + re-running a rebuild also
 * recreates them. Each touched Special_Folders row gets its fileCount
 * decremented and lastRefreshedAt stamped.
 */
export function removeShortcutsForTargets(
  targetFileIds: ReadonlyArray<string>
): ShortcutSweepResult {
  const result: ShortcutSweepResult = {
    shortcutsRemoved: 0,
    foldersTouched: 0,
    errors: [],
  };
  const targets = new Set(targetFileIds.filter((id) => id && id.trim()));
  if (targets.size === 0) return result;

  let records: SpecialFolderRecord[];
  let rows: unknown[][];
  try {
    const loaded = loadAllSpecialFolders();
    records = loaded.records;
    rows = loaded.rows;
  } catch (err) {
    result.errors.push(`Could not load Special_Folders sheet: ${String(err)}`);
    return result;
  }

  const now = nowIsoTimestamp();

  for (const record of records) {
    if (!record.folderId) continue;

    let removedHere = 0;
    for (const shortcut of listShortcutsInFolder(record.folderId)) {
      if (!targets.has(shortcut.targetId)) continue;
      const trashed = trashDriveFile(shortcut.id);
      if (!trashed.ok) {
        result.errors.push(
          `Failed to trash shortcut "${shortcut.name}" (${shortcut.id}) in ` +
          `${record.folderName} (${record.folderId}): ${trashed.error}`
        );
        continue;
      }
      removedHere++;
    }

    if (removedHere > 0) {
      result.shortcutsRemoved += removedHere;
      result.foldersTouched++;
      upsertSpecialFolderRow(
        {
          ...record,
          fileCount: Math.max(0, record.fileCount - removedHere),
          lastRefreshedAt: now,
        },
        rows
      );
    }
  }

  Logger.log(
    `[specialFoldersService.removeShortcutsForTargets] targets=${targets.size} ` +
    `removed=${result.shortcutsRemoved} folders=${result.foldersTouched} ` +
    `errors=${result.errors.length}`
  );
  return result;
}

// ─── Backfill sharing on every existing special folder ──────────────────────

/**
 * Walks every row in the Special_Folders sheet and grants
 * "Anyone with link → Viewer" on each folder.
 *
 * Purpose
 *   New folders created via tryRebuildSpecialFoldersForBatch after the
 *   sharing hook landed are public by construction. This one-shot routine
 *   retroactively shares every Photos_NNN / Videos folder that pre-dates
 *   the hook so the public spreadsheet's Folder Link column becomes usable
 *   immediately for older events.
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

