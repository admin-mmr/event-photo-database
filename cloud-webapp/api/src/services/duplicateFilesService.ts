/**
 * duplicateFilesService.ts — find and remove byte-identical duplicate files in
 * an event's Google Drive tree.
 *
 * WHY: the same photo reaches Drive more than once all the time (a volunteer
 * re-uploads a card, two people upload the same shot, a batch is copied twice).
 * The indexer and the managed-folder rebuild both already *ignore* the extra
 * copies — the indexer collapses them by md5 (`duplicateCount`, surfaced by
 * GET /api/events/:id/duplicates) and `dedupePhotosByContent` keeps them out of
 * Photos_NNN / Album — but nothing ever removed the files themselves, so they
 * keep paying Drive storage and keep turning one filename into a dozen hits in
 * Drive search. This is that missing step.
 *
 * HOW IT SYNCS WITH DRIVE:
 *   - The scan reads LIVE Drive state (walkMediaFiles over the event folder),
 *     not the Firestore photo cache, so a copy added or removed a minute ago is
 *     accounted for.
 *   - Removal goes through the same soft-delete lifecycle as the admin
 *     delete tool (routes/adminDeletedFiles.ts): the Drive file is TRASHED
 *     (recoverable ~30 days, and the scheduled purge job permanently deletes it
 *     after SOFT_DELETE_RETENTION_DAYS), a row is appended to the Deleted_Files
 *     tab of the master Sheet (the SSOT), managed shortcuts/copies pointing at
 *     the trashed original are retired, and the public folder index is
 *     refreshed. Nothing is deleted outright.
 *
 * WHICH COPY SURVIVES: the first in `relPath` order — byte-for-byte the rule
 * the indexer uses (indexer/job.py sorts by relPath, then keeps the first file
 * per md5). Choosing the same canonical means removal never trashes the copy
 * the current index/gallery points at, and repeated runs converge.
 *
 * Managed folders (Photos_NNN / Videos / Album) are NEVER walked — their
 * contents are deliberate copies/shortcuts of the sources, so treating them as
 * duplicates would fight the rebuild. Files Drive reports no md5 for are always
 * kept: unknown must not read as "duplicate".
 *
 * WHAT LIVES WHERE: this module holds the read-only half (scan, plan, preview)
 * plus `trashDuplicateChunk`, the one-chunk write primitive. The loop that drives
 * those chunks to completion lives in services/duplicateRemovalQueue.ts, because
 * removing an event's duplicates takes minutes of rate-paced Drive calls and
 * cannot be done inside a single HTTP request.
 */

import { logger } from '../lib/logger.js';
import { firestore } from '../lib/firestore.js';
import { getDriveToken, walkMediaFiles, type DriveMediaFile } from './driveService.js';
import { trashDriveFile } from './driveShortcutClient.js';
import { recordSoftDeletes } from './deletedFilesStore.js';
import { isManagedFolderName, isVideoFile } from './specialFoldersService.js';

/** One file in a duplicate group, with enough context to ledger and explain it. */
export interface DuplicateFileInfo {
  driveFileId: string;
  name: string;
  relPath: string;
  mimeType: string;
  clubName: string;
  batchFolderName: string;
  sizeBytes: number;
}

export interface DuplicateGroupInfo {
  contentHash: string;
  canonical: DuplicateFileInfo;
  duplicates: DuplicateFileInfo[];
}

export interface DuplicateScanResult {
  eventId: string;
  eventName: string;
  filesScanned: number;
  unhashedFiles: number;
  duplicateFiles: number;
  reclaimableBytes: number;
  groups: DuplicateGroupInfo[];
}

export interface DuplicateRemovalResult {
  eventId: string;
  apply: boolean;
  candidates: number;
  removed: number;
  failed: number;
  remaining: number;
  bytesReclaimed: number;
  planned: DuplicateFileInfo[];
  warnings: string[];
}

export interface ServiceOutcome<T> {
  ok: boolean;
  message: string;
  data?: T;
}

/**
 * Default cap on the duplicates a dry run lists. The preview is read-only, so
 * this only bounds how much detail comes back in one response.
 */
export const DEFAULT_REMOVE_LIMIT = 150;

/**
 * Duplicates trashed per round trip: the chunk's Drive PATCHes go out together,
 * then the survivors are ledgered in one batched Sheets append. Also the unit of
 * progress the drain commits to Firestore, so a tick that dies loses at most one
 * chunk's worth of bookkeeping (the files themselves are already in Drive's
 * trash, and a re-trash is harmless).
 */
export const TRASH_CHUNK = 10;

/**
 * Media we consider. Any `image/*` matches the indexer's own filter
 * (indexer/drive.py accepts every image mime, which is wider than the
 * rebuild's PHOTO_MIME set) and videos are included because duplicate clips are
 * the most expensive copies of all.
 */
function isDedupeCandidateMime(mimeType: string): boolean {
  return mimeType.startsWith('image/') || isVideoFile(mimeType);
}

/**
 * Compare by UTF-16 code unit, NOT localeCompare — Python's `sorted()` in the
 * indexer orders by code point, and the canonical pick must agree with it.
 */
function compareRelPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** "Club/tag/batch/IMG_1.jpg" → club "Club", batch folder "batch". */
export function pathContext(relPath: string): { clubName: string; batchFolderName: string } {
  const parts = relPath.split('/').filter((p) => p.length > 0);
  if (parts.length < 2) return { clubName: '', batchFolderName: '' };
  return { clubName: parts[0]!, batchFolderName: parts[parts.length - 2]! };
}

function toInfo(f: DriveMediaFile): DuplicateFileInfo {
  const relPath = f.relPath ?? f.name;
  const size = Number.parseInt(f.size ?? '', 10);
  return {
    driveFileId: f.id,
    name: f.name,
    relPath,
    mimeType: f.mimeType,
    ...pathContext(relPath),
    sizeBytes: Number.isFinite(size) && size > 0 ? size : 0,
  };
}

/**
 * Group Drive files into byte-identical duplicate sets. Pure — exported for
 * tests. Files with no md5 are counted in `unhashedFiles` and never grouped.
 * Groups come back ordered by the canonical's relPath so output is stable.
 */
export function groupByContentHash(files: ReadonlyArray<DriveMediaFile>): {
  groups: DuplicateGroupInfo[];
  unhashedFiles: number;
} {
  const sorted = [...files].sort((a, b) => compareRelPath(a.relPath ?? a.name, b.relPath ?? b.name));
  const byHash = new Map<string, DriveMediaFile[]>();
  let unhashedFiles = 0;

  for (const f of sorted) {
    const hash = String(f.md5Checksum ?? '').trim().toLowerCase();
    if (!hash) {
      unhashedFiles += 1;
      continue;
    }
    const group = byHash.get(hash);
    if (group) group.push(f);
    else byHash.set(hash, [f]);
  }

  const groups: DuplicateGroupInfo[] = [];
  for (const [contentHash, group] of byHash) {
    if (group.length < 2) continue;
    groups.push({
      contentHash,
      canonical: toInfo(group[0]!),
      duplicates: group.slice(1).map(toInfo),
    });
  }
  groups.sort((a, b) => compareRelPath(a.canonical.relPath, b.canonical.relPath));
  return { groups, unhashedFiles };
}

interface EventDrive {
  driveFolderId: string;
  name: string;
}

/** Event → Drive folder from the Firestore events cache (mirrors the rebuild). */
async function getEventDrive(eventId: string): Promise<EventDrive | null> {
  const snap = await firestore().collection('events').doc(eventId).get();
  const data = snap.data();
  const driveFolderId = String(data?.driveFolderId ?? '').trim();
  if (!driveFolderId) return null;
  return { driveFolderId, name: String(data?.name ?? data?.folderName ?? eventId) };
}

/**
 * Scan one event's Drive tree for byte-identical duplicates. Read-only.
 *
 * `clubScope` (a club_admin's own club) restricts the scan to that club's
 * subtree BEFORE grouping, so a scoped admin never sees — or acts on — another
 * club's files, and the canonical they keep is one of their own.
 */
export async function scanEventDuplicates(
  eventId: string,
  opts: { clubScope?: string | undefined } = {},
): Promise<ServiceOutcome<DuplicateScanResult>> {
  const event = await getEventDrive(eventId);
  if (!event) return { ok: false, message: `Event "${eventId}" not found or has no Drive folder` };

  const token = await getDriveToken();
  const all = await walkMediaFiles(event.driveFolderId, isDedupeCandidateMime, {
    token,
    skipChildFolder: isManagedFolderName,
  });

  const scope = opts.clubScope;
  const files =
    scope === undefined ? all : all.filter((f) => pathContext(f.relPath ?? f.name).clubName === scope);

  const { groups, unhashedFiles } = groupByContentHash(files);
  const duplicateFiles = groups.reduce((n, g) => n + g.duplicates.length, 0);
  const reclaimableBytes = groups.reduce(
    (n, g) => n + g.duplicates.reduce((m, d) => m + d.sizeBytes, 0),
    0,
  );

  const data: DuplicateScanResult = {
    eventId,
    eventName: event.name,
    filesScanned: files.length,
    unhashedFiles,
    duplicateFiles,
    reclaimableBytes,
    groups,
  };
  logger.info(
    { eventId, scope: scope ?? 'all', filesScanned: files.length, groups: groups.length, duplicateFiles },
    'scanEventDuplicates done',
  );
  return {
    ok: true,
    message: duplicateFiles
      ? `${duplicateFiles} duplicate file(s) across ${groups.length} group(s) in "${event.name}"`
      : `No byte-identical duplicates in "${event.name}"`,
    data,
  };
}

/** One duplicate queued for removal, with the copy that is keeping its place. */
export interface DuplicateWorkItem {
  dup: DuplicateFileInfo;
  keptRelPath: string;
  contentHash: string;
}

/**
 * Flatten scanned groups into one canonical-path-ordered work list. Pure.
 * `hashes` narrows the run to specific duplicate groups.
 */
export function planDuplicateRemoval(
  groups: ReadonlyArray<DuplicateGroupInfo>,
  opts: { hashes?: ReadonlyArray<string> | undefined } = {},
): DuplicateWorkItem[] {
  const wanted =
    opts.hashes && opts.hashes.length > 0 ? new Set(opts.hashes.map((h) => h.toLowerCase())) : null;
  const work: DuplicateWorkItem[] = [];
  for (const g of groups) {
    if (wanted && !wanted.has(g.contentHash)) continue;
    for (const dup of g.duplicates) {
      work.push({ dup, keptRelPath: g.canonical.relPath, contentHash: g.contentHash });
    }
  }
  return work;
}

/**
 * Read-only preview of what a removal would trash — the DRY RUN half of the tool
 * (`apply` not set). Scans live Drive and lists the first `limit` duplicates.
 * Writes nothing, so it is safe to run at any time.
 *
 * The apply half is NOT here: trashing is queued and drained in bounded ticks
 * (services/duplicateRemovalQueue.ts) because it cannot fit in one request. See
 * that file for why.
 */
export async function previewEventDuplicates(
  eventId: string,
  opts: {
    limit?: number;
    hashes?: ReadonlyArray<string> | undefined;
    clubScope?: string | undefined;
  },
): Promise<ServiceOutcome<DuplicateRemovalResult>> {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_REMOVE_LIMIT;
  const scan = await scanEventDuplicates(eventId, { clubScope: opts.clubScope });
  if (!scan.ok || !scan.data) return { ok: false, message: scan.message };

  const work = planDuplicateRemoval(scan.data.groups, { hashes: opts.hashes });
  const planned = work.slice(0, limit).map((w) => w.dup);
  const result: DuplicateRemovalResult = {
    eventId,
    apply: false,
    candidates: work.length,
    removed: 0,
    failed: 0,
    remaining: Math.max(0, work.length - planned.length),
    bytesReclaimed: 0,
    planned,
    warnings: [],
  };
  return {
    ok: true,
    message: `Would trash ${planned.length} duplicate file(s) in "${scan.data.eventName}" (dry run)${
      result.remaining ? `, ${result.remaining} beyond this batch` : ''
    }`,
    data: result,
  };
}

/** What one chunk of trashing achieved. */
export interface TrashChunkResult {
  removed: number;
  failed: number;
  bytesReclaimed: number;
  /** Drive IDs actually trashed — the sweep's target list. */
  trashedIds: string[];
  warnings: string[];
}

/**
 * Trash one chunk of duplicates and ledger them in Deleted_Files.
 *
 * The Drive PATCHes go out together (the shared pacing gate still serialises the
 * start of each), then the survivors are ledgered in ONE batched Sheets append —
 * per-file appends cost a tab lock plus a round trip each, which used to be most
 * of the wall clock. Rows are written strictly AFTER their trash call succeeded,
 * so the Sheet never claims a delete that did not happen.
 */
export async function trashDuplicateChunk(
  items: ReadonlyArray<DuplicateWorkItem>,
  opts: { eventId: string; actorEmail: string; spreadsheetId: string; token: string },
): Promise<TrashChunkResult> {
  const out: TrashChunkResult = { removed: 0, failed: 0, bytesReclaimed: 0, trashedIds: [], warnings: [] };
  if (items.length === 0) return out;

  const outcomes = await Promise.all(
    items.map(async (item) => ({ item, res: await trashDriveFile(item.dup.driveFileId, { token: opts.token }) })),
  );

  const ledger: DuplicateWorkItem[] = [];
  for (const { item, res } of outcomes) {
    if (!res.ok) {
      out.failed += 1;
      out.warnings.push(`Trash failed for ${item.dup.relPath}: ${res.error}`);
      continue;
    }
    ledger.push(item);
    out.trashedIds.push(item.dup.driveFileId);
    out.removed += 1;
    out.bytesReclaimed += item.dup.sizeBytes;
  }
  if (ledger.length === 0) return out;

  // A failed ledger write is loud but not fatal: the files are already in Drive's
  // own trash and recoverable from there.
  try {
    await recordSoftDeletes(
      opts.spreadsheetId,
      ledger.map(({ dup, keptRelPath, contentHash }) => ({
        driveFileId: dup.driveFileId,
        fileName: dup.name,
        eventId: opts.eventId,
        clubName: dup.clubName,
        batchFolderName: dup.batchFolderName,
        reason: `duplicate (md5 ${contentHash}) of ${keptRelPath}`,
      })),
      opts.actorEmail,
    );
  } catch (err) {
    const names = ledger.map((l) => l.dup.relPath).join(', ');
    out.warnings.push(`Trashed ${names} but the Deleted_Files ledger write failed: ${String(err)}`);
  }
  return out;
}
