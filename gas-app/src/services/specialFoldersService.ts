/**
 * specialFoldersService.ts — consolidated photo + per-scope video shortcut folders.
 *
 * What this module owns
 * ─────────────────────
 * After every batch upload finishes writing photos and videos to Drive, we
 * maintain two extra folder hierarchies inside Drive that admins asked for:
 *
 *   1. Per-event Photos folders, FLAT and INDEXED:
 *        <Event>/Photos_001/    ← real JPGs for up to MAX_SHORTCUTS_PER_PHOTOS_FOLDER photos
 *        <Event>/Photos_002/    ← overflow when the previous folder fills up
 *        ...
 *      These folders sit as siblings of the existing club folders inside the
 *      event folder. Each holds REAL, standalone files (NOT shortcuts): every
 *      photo under any club / tag / batch beneath the event is materialized
 *      here as a JPG. JPEG sources are copied byte-for-byte (files.copy);
 *      non-JPEG sources (PNG/HEIC/WEBP) are converted to JPG via the Cloud Run
 *      image-convert service. Each copy carries an appProperties.sourcePhotoId
 *      tag (= the original file's Drive ID) so rebuilds dedupe and the orphan
 *      sweep can retire a copy when its source is deleted. This duplicates
 *      storage (every photo exists twice) but the resulting files survive even
 *      if the original upload is deleted or its owner revokes access — the
 *      tradeoff admins asked for. When the Cloud Run service is not configured
 *      (or a conversion fails), the rebuild falls back to a Drive shortcut for
 *      that one photo so nothing is ever lost.
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
 * The Videos and Album folders still use native Drive shortcuts (mimeType
 * application/vnd.google-apps.shortcut) — videos can't be re-encoded into the
 * Photos pipeline, and the Album is a lightweight browse view. Only the
 * Photos_NNN buckets hold real, materialized JPG files. See
 * driveShortcutClient.ts for the REST plumbing (createDriveShortcut for
 * shortcuts; copyDriveFile / setFileAppProperties / listManagedCopiesInFolder
 * for real copies) and cloudRunClient.ts for the convert call.
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
  isSpecialLayer2Folder,
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
import { findById as findEventById, listAll as listAllEvents } from './eventService';
import {
  createDriveShortcut,
  listShortcutsInFolder,
  listManagedCopiesInFolder,
  copyDriveFile,
  setFileAppProperties,
  trashDriveFile,
  getDriveFileBasics,
  driveFolderUrl,
  ShortcutEntry,
  SOURCE_PHOTO_ID_PROPERTY,
} from './driveShortcutClient';
import { convertImage } from './cloudRunClient';
import { isCloudRunConfigured, JPG_QUALITY_DEFAULT } from '../config/superAdmins';
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
  /**
   * Number of new entries created on this rebuild. For Videos/Album this is
   * shortcut files; for Photos_NNN it is the total of real copies + converted
   * JPGs + any shortcut fallbacks created. Kept under this name for backward
   * compatibility with existing callers/logging.
   */
  shortcutsCreated: number;
  /** Number of source files we found that were already represented (deduped). */
  shortcutsExisting: number;
  /** How many target files we considered (photos for scope='photos', videos for 'videos'). */
  targetFilesScanned: number;
  /** Number of distinct folders the rebuild touched (Photos_001, Photos_002, ... or 1 Videos folder). */
  foldersTouched: number;
  /** Soft errors collected during the rebuild — folder/copy/convert/shortcut failures we logged but didn't throw on. */
  warnings: string[];
  /** Photos_NNN only: JPEG sources copied byte-for-byte via files.copy. */
  copiesCreated?: number;
  /** Photos_NNN only: non-JPEG sources converted to JPG via Cloud Run. */
  conversionsCreated?: number;
  /** Photos_NNN only: photos that fell back to a shortcut (Cloud Run unavailable or conversion failed). */
  shortcutFallbacks?: number;
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

// ─── Photo materialization helpers (pure) ────────────────────────────────────

/**
 * Decides how a photo should be materialized into a Photos_NNN bucket:
 *   'copy'    — JPEGs are copied byte-for-byte (no re-encode, no quality loss)
 *   'convert' — everything else (PNG/HEIC/WEBP) is converted to JPG via Cloud Run
 *
 * walkMediaFiles only surfaces PhotoMimeType files, so the input is always one
 * of JPEG/PNG/HEIC/WEBP; JPEG is the only "copy" case.
 *
 * Pure function — exported for direct unit testing.
 */
export function decidePhotoAction(mimeType: string): 'copy' | 'convert' {
  return mimeType === PhotoMimeType.JPEG ? 'copy' : 'convert';
}

/**
 * Computes the JPG filename for a materialized photo, avoiding collisions with
 * names already present in the same bucket.
 *
 * Policy (mirrors uploadPrepService.resolveDestName, decision D2):
 *   - The extension is always normalized to lowercase ".jpg".
 *   - If "<stem>.jpg" is taken, try "<stem>__2.jpg", "<stem>__3.jpg", …
 *
 * Pure function — exported for direct unit testing.
 *
 * @param sourceName Original source filename, e.g. "IMG_5001.HEIC"
 * @param usedNames  Names already committed in this bucket (case-sensitive)
 */
export function photoCopyDestName(
  sourceName: string,
  usedNames: ReadonlySet<string>
): string {
  const lastDot = sourceName.lastIndexOf('.');
  const stem = lastDot >= 0 ? sourceName.substring(0, lastDot) : sourceName;
  const candidate = `${stem}.jpg`;
  if (!usedNames.has(candidate)) return candidate;

  let suffix = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const withSuffix = `${stem}__${suffix}.jpg`;
    if (!usedNames.has(withSuffix)) return withSuffix;
    suffix++;
  }
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
 * One bucket folder's live state during a photo rebuild.
 */
interface PhotoBucketCtx {
  /** 1-based bucket index (1 → Photos_001). */
  index: number;
  /** Folder name, e.g. "Photos_003". */
  folderName: string;
  /** Drive folder ID. */
  folderId: string;
  /** Filenames already present in the bucket (for collision-free naming). */
  usedNames: Set<string>;
  /** Count of entries (copies + converts + shortcuts) that will live here after this rebuild. */
  placed: number;
}

/** Outcome of materializing one photo into a bucket. */
type MaterializeOutcome = 'copied' | 'converted' | 'shortcut' | 'skipped' | 'failed';

/**
 * Materializes one photo into a Photos_NNN bucket as a real file:
 *   - JPEG  → byte-for-byte copy via files.copy (tagged with sourcePhotoId)
 *   - other → convert to JPG via Cloud Run, then tag the result
 *
 * When the conversion can't happen (Cloud Run unconfigured, or the call fails)
 * the `allowShortcutFallback` flag decides what happens:
 *   - true  (normal rebuild): create a native Drive shortcut so the photo is
 *            still represented in the bucket → returns 'shortcut'
 *   - false (one-time migration): do nothing and leave any existing entry in
 *            place → returns 'skipped' (Cloud Run off) or 'failed' (convert
 *            errored). The migration must never create shortcuts, since it is
 *            trying to REMOVE them.
 *
 * Updates ctx.usedNames so subsequent photos in the same bucket avoid name
 * collisions. Soft errors are pushed onto `warnings`; never throws.
 */
function materializePhotoIntoBucket(
  photo: MediaFile,
  ctx: PhotoBucketCtx,
  cloudRunReady: boolean,
  warnings: string[],
  allowShortcutFallback: boolean
): MaterializeOutcome {
  const action = decidePhotoAction(photo.mimeType);

  if (action === 'copy') {
    const destName = photoCopyDestName(photo.name, ctx.usedNames);
    const res = copyDriveFile(photo.id, ctx.folderId, destName, {
      [SOURCE_PHOTO_ID_PROPERTY]: photo.id,
    });
    if (!res.ok) {
      warnings.push(
        `Failed to copy ${photo.name} (${photo.id}) into ${ctx.folderName}: ${res.error}`
      );
      return 'failed';
    }
    ctx.usedNames.add(destName);
    return 'copied';
  }

  // action === 'convert'
  if (cloudRunReady) {
    const destName = photoCopyDestName(photo.name, ctx.usedNames);
    const resp = convertImage({
      sourceFileId: photo.id,
      destFolderId: ctx.folderId,
      destName,
      jpgQuality: JPG_QUALITY_DEFAULT,
      maxDim: null,
      bakeOrientation: true,
      preserveExif: true,
    });
    if (resp.ok && resp.destFileId) {
      ctx.usedNames.add(destName);
      // Cloud Run uploads the JPG without our dedupe tag — stamp it now so the
      // next rebuild recognizes this source as already materialized.
      const tagged = setFileAppProperties(resp.destFileId, {
        [SOURCE_PHOTO_ID_PROPERTY]: photo.id,
      });
      if (!tagged.ok) {
        warnings.push(
          `Converted ${photo.name} (${photo.id}) into ${ctx.folderName} but could not tag ` +
          `sourcePhotoId on ${resp.destFileId}: ${tagged.error}. It may be re-converted next rebuild.`
        );
      }
      return 'converted';
    }
    warnings.push(
      `Conversion failed for ${photo.name} (${photo.id}) in ${ctx.folderName}: ` +
      `${resp.message ?? resp.error ?? 'unknown'}` +
      (allowShortcutFallback ? '; falling back to a shortcut.' : '.')
    );
    if (!allowShortcutFallback) return 'failed';
    // fall through to the shortcut fallback below
  } else if (!allowShortcutFallback) {
    // Cloud Run isn't configured and we're forbidden from creating shortcuts
    // (migration mode) — leave whatever is already there untouched.
    return 'skipped';
  }

  // Fallback: a native Drive shortcut (Cloud Run unconfigured, or convert failed).
  const sc = createDriveShortcut(ctx.folderId, photo.id, photo.name);
  if (!sc.ok) {
    warnings.push(
      `Failed to create fallback shortcut for ${photo.name} (${photo.id}) in ${ctx.folderName}: ${sc.error}`
    );
    return 'failed';
  }
  if (photo.name) ctx.usedNames.add(photo.name);
  return 'shortcut';
}

/**
 * Rebuilds the consolidated Photos_NNN folders for one event.
 *
 * Walks every photo under the event subtree, partitions them into buckets of
 * up to MAX_SHORTCUTS_PER_PHOTOS_FOLDER, ensures the right number of
 * Photos_NNN folders exist directly under the event folder, and materializes a
 * REAL JPG file for every photo not yet present: JPEG sources are copied
 * byte-for-byte, non-JPEG sources (PNG/HEIC/WEBP) are converted to JPG via the
 * Cloud Run image-convert service. When Cloud Run is unconfigured or a
 * conversion fails, that one photo falls back to a Drive shortcut so nothing
 * is lost.
 *
 * Idempotent: every materialized file carries an appProperties.sourcePhotoId
 * tag (legacy/fallback shortcuts are matched by their targetId), so a source
 * already represented in ANY bucket is never copied again — re-running the
 * function only fills in newly uploaded photos. Dedupe spans all buckets, so a
 * photo whose bucket assignment shifts (Drive IDs aren't strictly time-ordered)
 * is not duplicated across buckets.
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
  // Stable order means a rebuild after a no-op upload keeps bucket assignments
  // steady: sort by Drive file ID (immutable, lexicographic).
  photos.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const warnings: string[] = [];
  let copiesCreated = 0;
  let conversionsCreated = 0;
  let shortcutFallbacks = 0;
  let entriesExisting = 0;
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
        copiesCreated: 0,
        conversionsCreated: 0,
        shortcutFallbacks: 0,
      },
    };
  }

  const totalBuckets = bucketCountForFiles(photos.length);
  const now = nowIsoTimestamp();

  const cloudRunReady = isCloudRunConfigured();
  if (!cloudRunReady) {
    warnings.push(
      'Cloud Run image-convert service is not configured (CLOUD_RUN_URL Script ' +
      'Property is unset); non-JPEG photos will fall back to shortcuts until it is set.'
    );
  }

  // ── Pass 1: ensure every bucket folder exists and collect what's already in
  // it. We gather represented source IDs across ALL buckets up front so a photo
  // already materialized in one bucket is never re-created in another.
  const buckets: Array<PhotoBucketCtx | null> = [];
  const representedSourceIds = new Set<string>();

  for (let bucket = 1; bucket <= totalBuckets; bucket++) {
    const folderName = photosFolderName(bucket);
    const folderResult = getOrCreateSubfolder(eventFolder, folderName);
    if (folderResult.status !== ResultStatus.SUCCESS || !folderResult.data) {
      warnings.push(
        `Failed to create or open ${folderName}: ${folderResult.message}`
      );
      buckets.push(null);
      continue;
    }
    foldersTouched++;
    const folderId = folderResult.data.getId();

    // Make this Photos_NNN bucket public ("Anyone with link → Viewer") so the
    // Folder Link rendered on the public spreadsheet works for unauthenticated
    // viewers. Idempotent; errors NEVER fail the rebuild — share state
    // self-heals on the next sync. See drivePermissionsService.ts.
    tryGrantAnyoneRead(folderId);

    // Collapse any same-target duplicate shortcuts (e.g. a manual "Make a copy"
    // on drive.google.com), then read both the surviving shortcuts (legacy or
    // fallback) and the real copies already in the bucket.
    const existingShortcutsRaw = listShortcutsInFolder(folderId);
    const { survivors: shortcuts, removed: dupRemoved } =
      dedupeFolderShortcuts(existingShortcutsRaw, folderName, warnings);
    if (dupRemoved > 0) shortcutsDeduped += dupRemoved;
    const copies = listManagedCopiesInFolder(folderId);

    const usedNames = new Set<string>();
    let placed = 0;
    for (const s of shortcuts) {
      representedSourceIds.add(s.targetId);
      if (s.name) usedNames.add(s.name);
      placed++;
    }
    for (const c of copies) {
      representedSourceIds.add(c.sourcePhotoId);
      if (c.name) usedNames.add(c.name);
      placed++;
    }

    buckets.push({ index: bucket, folderName, folderId, usedNames, placed });
  }

  // ── Pass 2: materialize every not-yet-represented photo into its position bucket.
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    if (representedSourceIds.has(photo.id)) {
      entriesExisting++;
      continue;
    }

    const ctx = buckets[bucketIndexForPosition(i) - 1];
    if (!ctx) continue; // bucket folder couldn't be created; warning already recorded

    const outcome = materializePhotoIntoBucket(photo, ctx, cloudRunReady, warnings, true);
    // 'skipped' can't occur with allowShortcutFallback=true, but treat it (and
    // 'failed') as "not represented" so the next rebuild retries.
    if (outcome === 'failed' || outcome === 'skipped') continue;
    if (outcome === 'copied') copiesCreated++;
    else if (outcome === 'converted') conversionsCreated++;
    else shortcutFallbacks++;

    representedSourceIds.add(photo.id);
    ctx.placed++;
  }

  // ── Upsert one Special_Folders row per bucket that exists on Drive.
  for (const ctx of buckets) {
    if (!ctx) continue;
    upsertSpecialFolderRow(
      {
        folderId: ctx.folderId,
        eventId,
        scope: 'photos' as SpecialFolderScope,
        clubName: '',
        tag: '',
        folderName: ctx.folderName,
        folderIndex: ctx.index,
        folderUrl: driveFolderUrl(ctx.folderId),
        fileCount: ctx.placed,
        lastRefreshedAt: now,
      },
      sheetRows
    );
  }

  const created = copiesCreated + conversionsCreated + shortcutFallbacks;
  Logger.log(
    `[specialFoldersService.rebuildEventPhotoFolders] event=${eventId} ` +
    `photos=${photos.length} buckets=${totalBuckets} created=${created} ` +
    `(copied=${copiesCreated} converted=${conversionsCreated} shortcutFallback=${shortcutFallbacks}) ` +
    `existing=${entriesExisting} deduped=${shortcutsDeduped} warnings=${warnings.length}`
  );

  return {
    status: ResultStatus.SUCCESS,
    message:
      `Rebuilt ${foldersTouched} Photos_NNN folder(s) for "${event.folderName}": ` +
      `${created} new file(s) (${copiesCreated} copied, ${conversionsCreated} converted, ` +
      `${shortcutFallbacks} shortcut fallback(s)), ${entriesExisting} already present`,
    data: {
      shortcutsCreated: created,
      shortcutsExisting: entriesExisting,
      targetFilesScanned: photos.length,
      foldersTouched,
      warnings,
      copiesCreated,
      conversionsCreated,
      shortcutFallbacks,
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
  /**
   * Managed entries moved to trash — shortcuts (Videos/Album, plus any legacy
   * or fallback shortcuts in Photos_NNN) AND materialized Photos_NNN copies
   * whose source was deleted. Kept under this name for backward compatibility.
   */
  shortcutsRemoved: number;
  /** Managed folders that contained at least one removed entry. */
  foldersTouched: number;
  /** Soft errors (per-entry trash failures); never thrown. */
  errors: string[];
}

/**
 * Removes every managed entry pointing at the given target file IDs from EVERY
 * managed folder (Photos_NNN, Videos, Album) recorded in Special_Folders.
 *
 * Two kinds of entry are retired:
 *   - native Drive shortcuts whose shortcutDetails.targetId is a deleted target
 *     (Videos/Album, and legacy/fallback shortcuts in Photos_NNN), and
 *   - materialized Photos_NNN copies whose appProperties.sourcePhotoId is a
 *     deleted target (the JPGs produced by the photo rebuild).
 *
 * Why: the rebuilds only ever ADD entries. When an original file is
 * soft-deleted (e.g. by the duplicate cleanup flow) its shortcuts would dangle
 * and its copies would linger in the public-browse folders. Call this right
 * after a batch of soft-deletes with the deleted Drive file IDs.
 *
 * Entries are TRASHED (not hard-deleted) so a mistaken sweep is fully
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

    // Shortcuts whose target was deleted (Videos/Album + legacy/fallback in Photos_NNN).
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

    // Materialized copies whose source was deleted (Photos_NNN real JPGs).
    for (const copy of listManagedCopiesInFolder(record.folderId)) {
      if (!targets.has(copy.sourcePhotoId)) continue;
      const trashed = trashDriveFile(copy.id);
      if (!trashed.ok) {
        result.errors.push(
          `Failed to trash copy "${copy.name}" (${copy.id}) in ` +
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

// ─── One-time migration: replace Photos_NNN shortcuts with real JPGs ─────────

/** Per-event outcome of migratePhotoShortcutsToFiles. */
export interface PhotoMigrationResult {
  /** Total shortcuts examined across the event's Photos_NNN buckets. */
  shortcutsScanned: number;
  /** JPEG shortcuts replaced by a byte-for-byte copy. */
  copiesCreated: number;
  /** Non-JPEG shortcuts replaced by a Cloud Run conversion. */
  conversionsCreated: number;
  /** Shortcuts trashed because a real file now represents their source (migrated or already-present). */
  shortcutsTrashed: number;
  /** Shortcuts trashed because their target no longer exists under the event (dangling). */
  danglingTrashed: number;
  /** Non-JPEG shortcuts left in place because Cloud Run is not configured. */
  skippedNoCloudRun: number;
  /** Photos_NNN buckets visited. */
  foldersTouched: number;
  /** Soft errors collected (per-file copy/convert/trash failures); never thrown. */
  warnings: string[];
}

const EMPTY_PHOTO_MIGRATION: PhotoMigrationResult = {
  shortcutsScanned: 0,
  copiesCreated: 0,
  conversionsCreated: 0,
  shortcutsTrashed: 0,
  danglingTrashed: 0,
  skippedNoCloudRun: 0,
  foldersTouched: 0,
  warnings: [],
};

/**
 * ONE-TIME migration for a single event: replaces every Drive shortcut sitting
 * in the event's Photos_NNN buckets with a REAL JPG (JPEG sources copied,
 * other formats converted via Cloud Run), then trashes the shortcut.
 *
 * Why this exists
 *   Photos_NNN used to hold shortcuts. The rebuild now materializes real files
 *   for NEW photos, but it treats an existing shortcut as "already
 *   represented" and won't upgrade it. This routine performs that upgrade for
 *   the historical shortcuts.
 *
 * Per shortcut:
 *   - target already has a real copy in the bucket → trash the shortcut (it's
 *     now redundant).
 *   - target no longer exists under the event → trash the dangling shortcut.
 *   - otherwise → materialize a real JPG (NO shortcut fallback), and on success
 *     trash the shortcut. A non-JPEG when Cloud Run is unconfigured is left
 *     untouched (counted in skippedNoCloudRun) so nothing is lost.
 *
 * Idempotent & resumable: a shortcut is only ever trashed once its real file
 * exists, so re-running continues where a timed-out run left off, and a fully
 * migrated event is a fast no-op (no shortcuts remain to scan). Trashed (not
 * hard-deleted) shortcuts are recoverable from Drive trash.
 *
 * Finishes by calling rebuildEventPhotoFolders to refresh Special_Folders
 * counts and materialize any source photo that had neither a shortcut nor a
 * copy.
 */
export function migrateEventPhotoShortcutsToFiles(
  eventId: string
): ServiceResult<PhotoMigrationResult> {
  const event = findEventById(eventId);
  if (!event) {
    return { status: ResultStatus.ERROR, message: `Event "${eventId}" not found` };
  }

  const eventFolderResult = getFolderById(event.driveFolderId);
  if (eventFolderResult.status !== ResultStatus.SUCCESS || !eventFolderResult.data) {
    return {
      status: ResultStatus.ERROR,
      message: `Cannot open event Drive folder "${event.driveFolderId}": ${eventFolderResult.message}`,
    };
  }
  const eventFolder = eventFolderResult.data;

  // NOTE: we deliberately do NOT walk the whole event subtree here. Each shortcut
  // in a Photos_NNN bucket already carries its target's id, name and MIME type
  // (shortcutDetails.targetMimeType, surfaced by listShortcutsInFolder), which is
  // everything materializePhotoIntoBucket needs to choose copy-vs-convert and to
  // name the output. Resolving targets straight from the shortcut list avoids a
  // full recursive Drive traversal per event. A per-file metadata lookup
  // (getDriveFileBasics) is used only in the rare cases where targetMimeType is
  // absent or a materialization fails (to tell a dangling target from a transient
  // error).
  const cloudRunReady = isCloudRunConfigured();
  const result: PhotoMigrationResult = { ...EMPTY_PHOTO_MIGRATION, warnings: [] };
  if (!cloudRunReady) {
    result.warnings.push(
      'Cloud Run image-convert service is not configured (CLOUD_RUN_URL Script ' +
      'Property is unset); non-JPEG shortcuts will be left in place until it is set.'
    );
  }

  // Visit each Photos_NNN bucket directly under the event folder.
  const childIter = eventFolder.getFolders();
  while (childIter.hasNext()) {
    const folder = childIter.next();
    const folderName = folder.getName();
    if (!isSpecialLayer2Folder(folderName)) continue; // only Photos_NNN buckets
    result.foldersTouched++;
    const folderId = folder.getId();

    // Collapse any same-target duplicate shortcuts first, then read the real
    // copies already present so we never duplicate a migration.
    const shortcutsRaw = listShortcutsInFolder(folderId);
    const { survivors: shortcuts } = dedupeFolderShortcuts(shortcutsRaw, folderName, result.warnings);
    const copies = listManagedCopiesInFolder(folderId);

    const copiesBySource = new Set(copies.map((c) => c.sourcePhotoId));
    const ctx: PhotoBucketCtx = {
      index: 0, // unused by materializePhotoIntoBucket
      folderName,
      folderId,
      usedNames: new Set<string>([
        ...copies.map((c) => c.name).filter(Boolean),
        ...shortcuts.map((s) => s.name).filter(Boolean),
      ]),
      placed: 0,
    };

    for (const shortcut of shortcuts) {
      result.shortcutsScanned++;
      const sourceId = shortcut.targetId;

      // A real copy already represents this source — the shortcut is redundant.
      if (copiesBySource.has(sourceId)) {
        const trashed = trashDriveFile(shortcut.id);
        if (trashed.ok) result.shortcutsTrashed++;
        else result.warnings.push(`Failed to trash redundant shortcut ${shortcut.id} in ${folderName}: ${trashed.error}`);
        continue;
      }

      // Resolve the source's name + MIME straight from the shortcut. If Drive
      // didn't populate targetMimeType, fall back to a single metadata fetch —
      // and treat a definitive 404 there as a dangling shortcut.
      let src: MediaFile = {
        id: sourceId,
        name: shortcut.name,
        mimeType: shortcut.targetMimeType ?? '',
      };
      if (!src.mimeType) {
        const lookup = getDriveFileBasics(sourceId);
        if (lookup.found) {
          src = { id: sourceId, name: lookup.file.name || shortcut.name, mimeType: lookup.file.mimeType };
        } else if (lookup.gone) {
          const trashed = trashDriveFile(shortcut.id);
          if (trashed.ok) result.danglingTrashed++;
          else result.warnings.push(`Failed to trash dangling shortcut ${shortcut.id} in ${folderName}: ${trashed.error}`);
          continue;
        } else {
          // Ambiguous error — leave the shortcut for a later retry.
          result.warnings.push(`Could not resolve target ${sourceId} for shortcut ${shortcut.id} in ${folderName}; leaving for retry.`);
          continue;
        }
      }

      const outcome = materializePhotoIntoBucket(src, ctx, cloudRunReady, result.warnings, false);
      if (outcome === 'copied' || outcome === 'converted') {
        if (outcome === 'copied') result.copiesCreated++;
        else result.conversionsCreated++;
        copiesBySource.add(sourceId);
        const trashed = trashDriveFile(shortcut.id);
        if (trashed.ok) result.shortcutsTrashed++;
        else result.warnings.push(`Materialized ${src.name} but failed to trash its shortcut ${shortcut.id} in ${folderName}: ${trashed.error}`);
      } else if (outcome === 'skipped') {
        result.skippedNoCloudRun++; // non-JPEG, Cloud Run off — leave the shortcut
      } else if (outcome === 'failed') {
        // Materialization failed. If the target no longer exists, this is a
        // dangling shortcut (matching the old photosById-based sweep) — trash it
        // so the migration can reach completion. Otherwise it's a transient
        // failure: leave the shortcut in place for a retry (warning already logged).
        const lookup = getDriveFileBasics(sourceId);
        if (lookup.found === false && lookup.gone) {
          const trashed = trashDriveFile(shortcut.id);
          if (trashed.ok) result.danglingTrashed++;
          else result.warnings.push(`Failed to trash dangling shortcut ${shortcut.id} in ${folderName}: ${trashed.error}`);
        }
      }
    }
  }

  // Refresh Special_Folders counts and fill any photo that had no entry at all.
  const rebuild = rebuildEventPhotoFolders(eventId);
  if (rebuild.status !== ResultStatus.SUCCESS) {
    result.warnings.push(`Post-migration rebuild reported: ${rebuild.message}`);
  }

  Logger.log(
    `[specialFoldersService.migrateEventPhotoShortcutsToFiles] event=${eventId} ` +
    `scanned=${result.shortcutsScanned} copied=${result.copiesCreated} ` +
    `converted=${result.conversionsCreated} trashed=${result.shortcutsTrashed} ` +
    `dangling=${result.danglingTrashed} skippedNoCloudRun=${result.skippedNoCloudRun} ` +
    `folders=${result.foldersTouched} warnings=${result.warnings.length}`
  );

  return {
    status: ResultStatus.SUCCESS,
    message:
      `Migrated Photos_NNN for "${event.folderName}": ${result.copiesCreated} copied, ` +
      `${result.conversionsCreated} converted, ${result.shortcutsTrashed} shortcut(s) removed` +
      (result.skippedNoCloudRun > 0 ? `, ${result.skippedNoCloudRun} left (Cloud Run off)` : '') +
      (result.danglingTrashed > 0 ? `, ${result.danglingTrashed} dangling removed` : ''),
    data: result,
  };
}

/** Aggregate outcome of migrateAllPhotoShortcutsToFiles. */
export interface PhotoMigrationSummary {
  eventsProcessed: number;
  eventsFailed: number;
  copiesCreated: number;
  conversionsCreated: number;
  shortcutsTrashed: number;
  danglingTrashed: number;
  skippedNoCloudRun: number;
  /** Sample of per-event error messages (capped). */
  errors: string[];
}

/**
 * ONE-TIME migration across EVERY event: runs migrateEventPhotoShortcutsToFiles
 * for each event and aggregates the results. Per-event failures are captured,
 * not thrown, so one bad event never aborts the rest.
 *
 * Heavy: each non-JPEG shortcut triggers a Cloud Run conversion. For a large
 * catalogue this may exceed the 6-minute GAS execution limit — the routine is
 * idempotent and resumable, so simply re-run it until a run reports zero
 * shortcuts scanned. Prefer running per-event via migrateEventPhotoShortcutsToFiles
 * for very large events.
 */
export function migrateAllPhotoShortcutsToFiles(): PhotoMigrationSummary {
  const summary: PhotoMigrationSummary = {
    eventsProcessed: 0,
    eventsFailed: 0,
    copiesCreated: 0,
    conversionsCreated: 0,
    shortcutsTrashed: 0,
    danglingTrashed: 0,
    skippedNoCloudRun: 0,
    errors: [],
  };

  const events = listAllEvents(1, 100000, 'desc').items;
  for (const ev of events) {
    try {
      const r = migrateEventPhotoShortcutsToFiles(ev.eventId);
      if (r.status === ResultStatus.SUCCESS && r.data) {
        summary.eventsProcessed++;
        summary.copiesCreated += r.data.copiesCreated;
        summary.conversionsCreated += r.data.conversionsCreated;
        summary.shortcutsTrashed += r.data.shortcutsTrashed;
        summary.danglingTrashed += r.data.danglingTrashed;
        summary.skippedNoCloudRun += r.data.skippedNoCloudRun;
      } else {
        summary.eventsFailed++;
        if (summary.errors.length < 10) {
          summary.errors.push(`${ev.folderName}: ${r.message}`);
        }
      }
    } catch (err) {
      summary.eventsFailed++;
      if (summary.errors.length < 10) {
        summary.errors.push(`${ev.folderName}: ${String(err)}`);
      }
    }
  }

  Logger.log(
    `[specialFoldersService.migrateAllPhotoShortcutsToFiles] ` +
    `events=${summary.eventsProcessed} failed=${summary.eventsFailed} ` +
    `copied=${summary.copiesCreated} converted=${summary.conversionsCreated} ` +
    `trashed=${summary.shortcutsTrashed} dangling=${summary.danglingTrashed} ` +
    `skippedNoCloudRun=${summary.skippedNoCloudRun}`
  );
  return summary;
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

