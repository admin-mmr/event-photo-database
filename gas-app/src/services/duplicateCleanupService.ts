/**
 * duplicateCleanupService.ts — post-upload duplicate photo/video detection.
 *
 * Problem
 * ───────
 * The upload pipeline already blocks duplicates at upload time
 * (duplicateCheckService.ts), but files added through the Drive UI bypass
 * that check entirely. Two patterns show up in practice:
 *
 *   1. "IMG_5518 (1).jpeg" next to "IMG_5518.jpeg"
 *      — Drive's auto-rename when the same file is uploaded twice into the
 *        same folder via drive.google.com.
 *   2. "Copy of Misty_Mountain_Frida_15633.jpeg"
 *      — Drive's "Make a copy" action.
 *
 * Detection (two tiers, per club subtree within one event)
 * ────────────────────────────────────────────────────────
 *   Tier 1 — MD5: the Drive v3 REST API exposes md5Checksum for binary
 *   content. Files with identical checksums inside the same club's subtree
 *   are duplicates regardless of name. Highest confidence; catches renamed
 *   copies too.
 *
 *   Tier 2 — name pattern: for files where Drive did not report an MD5,
 *   fall back to stripping the "Copy of " prefix / " (N)" suffix and
 *   matching the base-named file by exact byte size. When both files DO
 *   have checksums and they differ, the pair is NOT flagged (the copy was
 *   edited — content differs).
 *
 * Keeper selection
 * ────────────────
 * Within a duplicate group we keep the file whose name is canonical (no
 * "Copy of " / " (N)" noise); ties break to the earliest createdTime, then
 * lowest file ID for determinism. Everything else is flagged for deletion.
 *
 * This service only DETECTS — it never deletes. The admin reviews the scan
 * report and bulk-trashes through deleteService.softDeleteFile() (audited,
 * 30-day restorable). See routes/duplicateHandlers.ts.
 */

import { ResultStatus } from '../types/enums';
import { ServiceResult } from '../types/responses';
import {
  PHOTOS_FOLDER_PREFIX,
  VIDEOS_FOLDER_NAME,
  ALBUM_FOLDER_NAME,
} from '../config/constants';
import { findById as findEventById } from './eventService';
import { getFolderById } from './driveService';
import { listFilesInFolder, DriveFileMeta } from './driveShortcutClient';
import { isMediaFile } from './specialFoldersService';

/* global Logger */

// ─── Types ────────────────────────────────────────────────────────────────────

/** A media file discovered during the scan, with its location context. */
export interface ScannedFile extends DriveFileMeta {
  /** Normalized club name — first-level folder under the event. */
  clubName: string;
  /** Tag folder name (second level), '' for legacy tag-less layouts. */
  tag: string;
  /** Immediate parent folder name (usually the batch folder), '' when the file sits directly in the club/tag folder. */
  batchFolderName: string;
}

/** Why a group was flagged. */
export type DuplicateReason = 'md5' | 'name';

/** One file inside a duplicate group, as shown on the review UI. */
export interface DuplicateEntry {
  fileId: string;
  fileName: string;
  sizeBytes: number;
  createdTime: string;
  tag: string;
  batchFolderName: string;
}

/** One set of identical files: the keeper plus the redundant copies. */
export interface DuplicateGroup {
  clubName: string;
  reason: DuplicateReason;
  /** The file to KEEP — canonical name, earliest creation. */
  keeper: DuplicateEntry;
  /** The redundant copies proposed for deletion. */
  duplicates: DuplicateEntry[];
}

/** Full scan output for one event. */
export interface DuplicateScanReport {
  eventId: string;
  filesScanned: number;
  groups: DuplicateGroup[];
  /** Total number of redundant copies across all groups. */
  duplicateFileCount: number;
  /** Total bytes that deleting all flagged copies would reclaim. */
  duplicateBytes: number;
}

// ─── Pure helpers (exported for unit testing) ────────────────────────────────

/**
 * Strips Drive's duplicate-noise decorations from a filename:
 *   - one or more leading "Copy of " prefixes (any case), and
 *   - a single trailing " (N)" counter before the extension.
 *
 * Returns the canonical base name plus whether anything was stripped.
 *
 *   "Copy of a.jpeg"        → { base: "a.jpeg",  noisy: true }
 *   "a (1).jpeg"            → { base: "a.jpeg",  noisy: true }
 *   "Copy of a (2).jpeg"    → { base: "a.jpeg",  noisy: true }
 *   "a.jpeg"                → { base: "a.jpeg",  noisy: false }
 */
export function parseNoisyName(name: string): { base: string; noisy: boolean } {
  let base = name;
  let noisy = false;

  // Leading "Copy of " (possibly stacked: "Copy of Copy of x").
  const copyPrefix = /^copy of /i;
  while (copyPrefix.test(base)) {
    base = base.replace(copyPrefix, '');
    noisy = true;
  }

  // Trailing " (N)" before the extension ("a (1).jpeg") or at the very end
  // for extension-less names ("a (1)").
  const withExt = base.match(/^(.*) \(\d+\)(\.[^.]*)$/);
  if (withExt) {
    base = `${withExt[1]}${withExt[2]}`;
    noisy = true;
  } else {
    const noExt = base.match(/^(.*) \(\d+\)$/);
    if (noExt) {
      base = noExt[1];
      noisy = true;
    }
  }

  return { base, noisy };
}

/** Sort key: canonical-named files first, then earliest createdTime, then id. */
function keeperRank(f: ScannedFile): string {
  const noisy = parseNoisyName(f.name).noisy ? '1' : '0';
  // Missing createdTime sorts AFTER any real timestamp so an undated file
  // never beats a dated original.
  const created = f.createdTime || '9999-12-31T23:59:59Z';
  return `${noisy}|${created}|${f.id}`;
}

/** Picks the file to keep from a duplicate group (see module doc). */
export function chooseKeeper(files: ReadonlyArray<ScannedFile>): ScannedFile {
  if (files.length === 0) {
    throw new Error('chooseKeeper: empty group');
  }
  return [...files].sort((a, b) => keeperRank(a).localeCompare(keeperRank(b)))[0];
}

function toEntry(f: ScannedFile): DuplicateEntry {
  return {
    fileId: f.id,
    fileName: f.name,
    sizeBytes: f.sizeBytes,
    createdTime: f.createdTime,
    tag: f.tag,
    batchFolderName: f.batchFolderName,
  };
}

/**
 * Finds duplicate groups among the scanned files. Pure function — exported
 * for unit testing. Files are only ever compared within the same club.
 *
 * Tier 1: identical md5Checksum (and a positive size) → reason 'md5'.
 * Tier 2: for files without an MD5, a noisy name ("Copy of x" / "x (1)")
 *         whose base-named sibling exists with the same byte size → 'name'.
 */
export function findDuplicateGroups(
  files: ReadonlyArray<ScannedFile>
): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const inMd5Group = new Set<string>(); // file IDs already claimed by tier 1

  // ── Tier 1: MD5 ────────────────────────────────────────────────────────────
  const byMd5 = new Map<string, ScannedFile[]>();
  for (const f of files) {
    if (!f.md5Checksum || f.sizeBytes <= 0) continue;
    const key = `${f.clubName}::${f.md5Checksum}::${f.sizeBytes}`;
    const bucket = byMd5.get(key);
    if (bucket) bucket.push(f);
    else byMd5.set(key, [f]);
  }

  for (const bucket of byMd5.values()) {
    if (bucket.length < 2) continue;
    const keeper = chooseKeeper(bucket);
    for (const f of bucket) inMd5Group.add(f.id);
    groups.push({
      clubName: keeper.clubName,
      reason: 'md5',
      keeper: toEntry(keeper),
      duplicates: bucket
        .filter((f) => f.id !== keeper.id)
        .map(toEntry),
    });
  }

  // ── Tier 2: name pattern (only for files lacking an MD5) ──────────────────
  // Index canonical names → files, per club, for the base-name lookup.
  const byClubAndName = new Map<string, ScannedFile[]>();
  for (const f of files) {
    if (inMd5Group.has(f.id)) continue;
    const key = `${f.clubName}::${f.name}`;
    const bucket = byClubAndName.get(key);
    if (bucket) bucket.push(f);
    else byClubAndName.set(key, [f]);
  }

  // keeperId → accumulated noisy copies, so several "x (N)" files referencing
  // the same base collapse into one group.
  const nameGroups = new Map<string, { keeper: ScannedFile; dups: ScannedFile[] }>();

  for (const f of files) {
    if (inMd5Group.has(f.id)) continue;
    const { base, noisy } = parseNoisyName(f.name);
    if (!noisy) continue;

    const candidates = byClubAndName.get(`${f.clubName}::${base}`) ?? [];
    const match = candidates.find((c) => {
      if (c.id === f.id) return false;
      if (c.sizeBytes !== f.sizeBytes || c.sizeBytes <= 0) return false;
      // When BOTH files carry checksums tier 1 is authoritative: differing
      // checksums mean the copy was edited — not a duplicate.
      if (c.md5Checksum && f.md5Checksum && c.md5Checksum !== f.md5Checksum) {
        return false;
      }
      return true;
    });
    if (!match) continue;

    const existing = nameGroups.get(match.id);
    if (existing) existing.dups.push(f);
    else nameGroups.set(match.id, { keeper: match, dups: [f] });
  }

  for (const { keeper, dups } of nameGroups.values()) {
    groups.push({
      clubName: keeper.clubName,
      reason: 'name',
      keeper: toEntry(keeper),
      duplicates: dups.map(toEntry),
    });
  }

  // Stable report order: club, then keeper filename.
  groups.sort((a, b) => {
    const clubCmp = a.clubName.localeCompare(b.clubName);
    if (clubCmp !== 0) return clubCmp;
    return a.keeper.fileName.localeCompare(b.keeper.fileName);
  });

  return groups;
}

// ─── Drive walking ────────────────────────────────────────────────────────────

/** True when the folder is one of our system-managed shortcut folders. */
function isManagedFolderName(name: string): boolean {
  return (
    name === VIDEOS_FOLDER_NAME ||
    name === ALBUM_FOLDER_NAME ||
    name.startsWith(PHOTOS_FOLDER_PREFIX)
  );
}

/**
 * Collects every media file under one club folder, with tag / batch context.
 * Files are listed via the Drive REST API (listFilesInFolder) so each entry
 * carries md5Checksum + size + createdTime; the folder STRUCTURE is walked
 * with DriveApp, mirroring specialFoldersService.walkMediaFiles.
 */
function collectClubFiles(
  clubFolder: GoogleAppsScript.Drive.Folder,
  clubName: string
): ScannedFile[] {
  const out: ScannedFile[] = [];

  interface StackItem {
    folder: GoogleAppsScript.Drive.Folder;
    /** Depth below the club folder: 0 = club folder itself. */
    depth: number;
    /** Tag context inherited from the first-level subfolder. */
    tag: string;
  }
  const stack: StackItem[] = [{ folder: clubFolder, depth: 0, tag: '' }];

  while (stack.length > 0) {
    const { folder, depth, tag } = stack.pop()!;
    const folderName = folder.getName();

    for (const meta of listFilesInFolder(folder.getId())) {
      if (!isMediaFile(meta.mimeType)) continue;
      out.push({
        ...meta,
        clubName,
        tag,
        batchFolderName: depth === 0 ? '' : folderName,
      });
    }

    const children = folder.getFolders();
    while (children.hasNext()) {
      const child = children.next();
      const childName = child.getName();
      if (isManagedFolderName(childName)) continue;
      stack.push({
        folder: child,
        depth: depth + 1,
        // The first-level subfolder under the club is the tag folder.
        tag: depth === 0 ? childName : tag,
      });
    }
  }

  return out;
}

// ─── Public scan API ──────────────────────────────────────────────────────────

/**
 * Scans one event's Drive subtree for duplicate media files.
 *
 * Read-only: nothing is modified or deleted. Returns a report the admin UI
 * renders for review; the actual deletions go through deleteService.
 *
 * Scoped per event to stay well inside the 6-minute GAS execution cap —
 * the dominant cost is one files.list call per batch folder.
 */
export function scanEventForDuplicates(
  eventId: string
): ServiceResult<DuplicateScanReport> {
  const event = findEventById(eventId);
  if (!event) {
    return { status: ResultStatus.ERROR, message: `Event "${eventId}" not found` };
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

  const allFiles: ScannedFile[] = [];
  const clubIter = eventFolderResult.data.getFolders();
  while (clubIter.hasNext()) {
    const clubFolder = clubIter.next();
    const clubName = clubFolder.getName();
    if (isManagedFolderName(clubName)) continue;
    allFiles.push(...collectClubFiles(clubFolder, clubName));
  }

  const groups = findDuplicateGroups(allFiles);
  const duplicateFileCount = groups.reduce((n, g) => n + g.duplicates.length, 0);
  const duplicateBytes = groups.reduce(
    (n, g) => n + g.duplicates.reduce((m, d) => m + d.sizeBytes, 0),
    0
  );

  Logger.log(
    `[duplicateCleanupService.scanEventForDuplicates] event=${eventId} ` +
    `files=${allFiles.length} groups=${groups.length} duplicates=${duplicateFileCount}`
  );

  return {
    status: ResultStatus.SUCCESS,
    message:
      groups.length === 0
        ? `Scanned ${allFiles.length} file(s) — no duplicates found.`
        : `Scanned ${allFiles.length} file(s) — ${duplicateFileCount} redundant cop(ies) in ${groups.length} group(s).`,
    data: {
      eventId,
      filesScanned: allFiles.length,
      groups,
      duplicateFileCount,
      duplicateBytes,
    },
  };
}
