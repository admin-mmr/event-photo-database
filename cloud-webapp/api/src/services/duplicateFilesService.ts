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
 */

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { firestore } from '../lib/firestore.js';
import { getDriveToken, walkMediaFiles, DRIVE_SCOPE_READWRITE, type DriveMediaFile } from './driveService.js';
import { trashDriveFile } from './driveShortcutClient.js';
import { recordSoftDeletes } from './deletedFilesStore.js';
import { isManagedFolderName, isVideoFile, removeShortcutsForTargets } from './specialFoldersService.js';
import { tryRebuildPublicFolderIndex } from './publicFolderIndexService.js';

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
 * Default cap on files trashed per removal call. Each file costs a Drive PATCH
 * plus a share of a batched Sheet append, so a user-facing call (60s Firebase
 * Hosting ceiling) has to stop somewhere and report `remaining`; the UI / script
 * just calls again.
 */
export const DEFAULT_REMOVE_LIMIT = 150;

/**
 * Wall-clock budget for one removal call, measured from the moment the call
 * starts and covering EVERYTHING it does — the live Drive scan, the trashing
 * loop and the managed-folder sweep.
 *
 * This used to clock only the trashing loop, which is the bug that made the tool
 * unusable on a real event: the scan of a ~2,000-file tree takes 10–17s and the
 * sweep takes seconds more, so `scan + 40s loop + sweep` sailed past the 60s
 * Firebase Hosting ceiling and every single call died at 59.98s with a 502. The
 * files were being trashed, but the caller never got the result — so the UI
 * showed only an error, `remaining` never came back, and pressing the button
 * again just repeated the same doomed request.
 */
const CALL_BUDGET_MS = 45_000;

/**
 * Tail of the budget held back for the post-loop shortcut sweep + public-index
 * refresh, so the work that keeps managed folders consistent is never the thing
 * that runs out of clock.
 */
const SWEEP_RESERVE_MS = 10_000;

/**
 * Duplicates trashed per round trip: the chunk's Drive PATCHes go out together,
 * then the survivors are ledgered in one batched Sheets append. Kept modest so a
 * chunk cannot overshoot the deadline by much, and so Drive sees a sane rate.
 */
const TRASH_CHUNK = 10;

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

/**
 * Trash the redundant copies found by `scanEventDuplicates`, ledgering each one
 * in Deleted_Files so it stays restorable. DRY RUN unless `apply` is true.
 *
 * Bounded by `limit` (files) and a wall-clock budget covering the WHOLE call —
 * scan included — so the response always comes back inside the 60s Hosting
 * ceiling; whatever is left comes back as `remaining` for the next call.
 * Idempotent: a trashed file drops out of the next scan, so re-running only ever
 * picks up what is still there.
 */
export async function removeEventDuplicates(
  eventId: string,
  opts: {
    apply?: boolean;
    limit?: number;
    hashes?: ReadonlyArray<string> | undefined;
    clubScope?: string | undefined;
    actorEmail: string;
    /** Whole-call wall-clock budget; overridable for tests. */
    budgetMs?: number;
  },
): Promise<ServiceOutcome<DuplicateRemovalResult>> {
  const startedAt = Date.now();
  const budgetMs = opts.budgetMs && opts.budgetMs > 0 ? opts.budgetMs : CALL_BUDGET_MS;
  const apply = opts.apply === true;
  const limit = opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_REMOVE_LIMIT;
  const scan = await scanEventDuplicates(eventId, { clubScope: opts.clubScope });
  const scanMs = Date.now() - startedAt;
  if (!scan.ok || !scan.data) return { ok: false, message: scan.message };

  const wanted = opts.hashes && opts.hashes.length > 0 ? new Set(opts.hashes.map((h) => h.toLowerCase())) : null;
  const result: DuplicateRemovalResult = {
    eventId,
    apply,
    candidates: 0,
    removed: 0,
    failed: 0,
    remaining: 0,
    bytesReclaimed: 0,
    planned: [],
    warnings: [],
  };

  // One flat work list, canonical-path ordered, each duplicate tagged with the
  // copy that is keeping its place (so the ledger reason explains itself).
  const work: Array<{ dup: DuplicateFileInfo; keptRelPath: string; contentHash: string }> = [];
  for (const g of scan.data.groups) {
    if (wanted && !wanted.has(g.contentHash)) continue;
    for (const dup of g.duplicates) work.push({ dup, keptRelPath: g.canonical.relPath, contentHash: g.contentHash });
  }
  result.candidates = work.length;

  if (!apply) {
    result.planned = work.slice(0, limit).map((w) => w.dup);
    result.remaining = Math.max(0, work.length - result.planned.length);
    return {
      ok: true,
      message: `Would trash ${result.planned.length} duplicate file(s) in "${scan.data.eventName}" (dry run)${
        result.remaining ? `, ${result.remaining} beyond this batch` : ''
      }`,
      data: result,
    };
  }

  const spreadsheetId = env.MASTER_SPREADSHEET_ID;
  if (!spreadsheetId) return { ok: false, message: 'MASTER_SPREADSHEET_ID is not set — cannot ledger removals' };

  const driveToken = await getDriveToken(DRIVE_SCOPE_READWRITE);
  // Stop starting new chunks once the sweep's reserve is all that is left. The
  // deadline is anchored to the start of the CALL, so a slow scan eats into the
  // trashing time rather than pushing the response past the Hosting ceiling.
  const trashDeadline = startedAt + budgetMs - SWEEP_RESERVE_MS;
  const target = Math.min(limit, work.length);
  const trashedIds: string[] = [];
  let processed = 0;

  while (processed < target) {
    // Always run the first chunk: if the scan alone spent the budget, doing a
    // little work beats returning zero progress forever (the UI and the shell
    // script both stop looping on a round that removes nothing).
    if (processed > 0 && Date.now() >= trashDeadline) break;
    const chunk = work.slice(processed, Math.min(processed + TRASH_CHUNK, target));
    processed += chunk.length;

    const outcomes = await Promise.all(
      chunk.map(async (item) => ({ item, res: await trashDriveFile(item.dup.driveFileId, { token: driveToken }) })),
    );

    // Ledger AFTER the trash succeeded, so the sheet never claims a delete that
    // did not happen — one batched append for the whole chunk. A failed ledger
    // write is loud but not fatal: the files are already in Drive's own trash
    // and recoverable from there.
    const ledger: Array<{ dup: DuplicateFileInfo; keptRelPath: string; contentHash: string }> = [];
    for (const { item, res } of outcomes) {
      if (!res.ok) {
        result.failed += 1;
        result.warnings.push(`Trash failed for ${item.dup.relPath}: ${res.error}`);
        continue;
      }
      ledger.push(item);
      trashedIds.push(item.dup.driveFileId);
      result.removed += 1;
      result.bytesReclaimed += item.dup.sizeBytes;
    }
    if (ledger.length === 0) continue;
    try {
      await recordSoftDeletes(
        spreadsheetId,
        ledger.map(({ dup, keptRelPath, contentHash }) => ({
          driveFileId: dup.driveFileId,
          fileName: dup.name,
          eventId,
          clubName: dup.clubName,
          batchFolderName: dup.batchFolderName,
          reason: `duplicate (md5 ${contentHash}) of ${keptRelPath}`,
        })),
        opts.actorEmail,
      );
    } catch (err) {
      const names = ledger.map((l) => l.dup.relPath).join(', ');
      result.warnings.push(`Trashed ${names} but the Deleted_Files ledger write failed: ${String(err)}`);
    }
  }

  result.remaining = Math.max(0, work.length - processed);

  // Retire managed shortcuts/copies that pointed at the now-trashed originals so
  // Photos_NNN / Album don't dangle, then refresh the public index — one sweep
  // for the whole batch. Scoped to this event: another event's managed folders
  // cannot hold a shortcut to these files, and sweeping them all costs two Drive
  // list calls per folder in the entire system. Best-effort and gated, exactly
  // like the delete route.
  if (trashedIds.length > 0 && env.MANAGED_FOLDERS_ENABLED === 'true') {
    try {
      const sweep = await removeShortcutsForTargets(trashedIds, { eventId });
      for (const e of sweep.errors) result.warnings.push(`Shortcut sweep: ${e}`);
      await tryRebuildPublicFolderIndex();
    } catch (err) {
      result.warnings.push(`Managed-folder sweep after removal failed (non-fatal): ${String(err)}`);
    }
  }

  logger.info(
    {
      ...result,
      planned: result.planned.length,
      warnings: result.warnings.length,
      scanMs,
      totalMs: Date.now() - startedAt,
    },
    'removeEventDuplicates done',
  );
  return {
    ok: true,
    message: `Trashed ${result.removed} duplicate file(s) in "${scan.data.eventName}"${
      result.failed ? `, ${result.failed} failed` : ''
    }${result.remaining ? `, ${result.remaining} left — run again to continue` : ''}`,
    data: result,
  };
}
