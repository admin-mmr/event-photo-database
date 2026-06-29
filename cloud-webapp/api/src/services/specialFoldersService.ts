/**
 * specialFoldersService.ts — managed "special folders" rebuild engine.
 * Cloud-webapp port of the gas-app module of the same name.
 *
 * After a batch is copied into Drive, we maintain three extra folder
 * hierarchies inside the event subtree:
 *
 *   1. <Event>/Photos_NNN/   — per-event, flat, indexed photo buckets
 *        (≤ MAX_PHOTOS_PER_BUCKET entries each). STORAGE-MINIMIZING POLICY:
 *        JPEG sources are linked as Drive SHORTCUTS (no byte copy); non-JPEG
 *        sources (PNG/HEIC/WEBP) are materialised as a real converted JPG via
 *        the Cloud Run image-convert service, tagged with appProperties
 *        .sourcePhotoId. When convert is unconfigured or fails, that one photo
 *        falls back to a shortcut so nothing is lost.
 *   2. <Event>/<Club>/<Tag>/Videos/  — shortcuts to every video in the scope.
 *   3. <Event>/<Club>/<Tag>/Album/   — shortcuts to EVERY media file in scope.
 *
 * Authoritative state lives in the Special_Folders sheet (specialFoldersStore).
 * Every rebuild is idempotent: a source already represented (a shortcut with
 * that targetId, or a managed copy with that sourcePhotoId) is never re-linked.
 * All Drive calls are paced + retried (driveRateLimit) so a large rebuild never
 * trips Drive's per-user quota.
 */

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { firestore } from '../lib/firestore.js';
import {
  getDriveToken,
  getFolderById,
  findSubfolder,
  findSubfoldersByName,
  getOrCreateSubfolder,
  listChildFolders,
  walkMediaFiles,
  DRIVE_SCOPE_READWRITE,
  type DriveMediaFile,
} from './driveService.js';
import {
  createDriveShortcut,
  listShortcutsInFolder,
  listManagedCopiesInFolder,
  setFileAppProperties,
  trashDriveFile,
  getDriveFileBasics,
  driveFolderUrl,
  SOURCE_PHOTO_ID_PROPERTY,
  type ShortcutEntry,
} from './driveShortcutClient.js';
import {
  grantAnyoneRead,
  tryGrantAnyoneRead,
  foldBatchGrantSummary,
  EMPTY_BATCH_GRANT_SUMMARY,
  type BatchGrantSummary,
} from './drivePermissionsService.js';
import { convertImage, isImageConvertConfigured } from './imageConvertClient.js';
import {
  listAllSpecialFolders,
  loadSpecialFolderRows,
  upsertSpecialFolderRow,
  deleteSpecialFolderRowsByFolderId,
  ensureSpecialFoldersTab,
  type SpecialFolderRecord,
  type SpecialFolderScope,
} from './specialFoldersStore.js';

// ─── Constants ──────────────────────────────────────────────────────────────

export const PHOTOS_FOLDER_PREFIX = 'Photos_';
export const VIDEOS_FOLDER_NAME = 'Videos';
export const ALBUM_FOLDER_NAME = 'Album';

const PHOTO_MIME = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp']);
const VIDEO_MIME = new Set(['video/mp4', 'video/quicktime']);
const JPEG_MIME = 'image/jpeg';

export function isPhotoFile(mimeType: string): boolean {
  return PHOTO_MIME.has(mimeType);
}
export function isVideoFile(mimeType: string): boolean {
  return VIDEO_MIME.has(mimeType);
}
export function isMediaFile(mimeType: string): boolean {
  return isPhotoFile(mimeType) || isVideoFile(mimeType);
}

/** True for the system-managed folders the rebuild must never treat as sources. */
export function isManagedFolderName(name: string): boolean {
  return name === VIDEOS_FOLDER_NAME || name === ALBUM_FOLDER_NAME || name.startsWith(PHOTOS_FOLDER_PREFIX);
}

// ─── Pure helpers (exported for unit tests) ──────────────────────────────────

const maxPerBucket = (): number => env.MAX_PHOTOS_PER_BUCKET;

/** "Photos_001" for 1, "Photos_042" for 42. */
export function photosFolderName(index1Based: number): string {
  if (index1Based < 1 || !Number.isFinite(index1Based)) {
    throw new Error(`photosFolderName: index must be a positive integer, got ${index1Based}`);
  }
  return `${PHOTOS_FOLDER_PREFIX}${String(Math.floor(index1Based)).padStart(3, '0')}`;
}

/** 1-based bucket index for a 0-based sequential photo position. */
export function bucketIndexForPosition(position0Based: number): number {
  if (position0Based < 0 || !Number.isFinite(position0Based)) {
    throw new Error(`bucketIndexForPosition: position must be a non-negative integer, got ${position0Based}`);
  }
  return Math.floor(position0Based / maxPerBucket()) + 1;
}

/** Number of buckets needed to hold `count` photos. */
export function bucketCountForFiles(count: number): number {
  if (count <= 0 || !Number.isFinite(count)) return 0;
  return Math.ceil(count / maxPerBucket());
}

/**
 * Storage-minimizing policy: JPEGs are linked as shortcuts (no real copy),
 * everything else is converted to a real JPG.
 */
export function decidePhotoAction(mimeType: string): 'shortcut' | 'convert' {
  return mimeType === JPEG_MIME ? 'shortcut' : 'convert';
}

/** Collision-free ".jpg" name for a converted photo within one bucket. */
export function photoCopyDestName(sourceName: string, usedNames: ReadonlySet<string>): string {
  const lastDot = sourceName.lastIndexOf('.');
  const stem = lastDot >= 0 ? sourceName.substring(0, lastDot) : sourceName;
  const candidate = `${stem}.jpg`;
  if (!usedNames.has(candidate)) return candidate;
  let suffix = 2;
  for (;;) {
    const withSuffix = `${stem}__${suffix}.jpg`;
    if (!usedNames.has(withSuffix)) return withSuffix;
    suffix++;
  }
}

/**
 * A "Copy of …" / " (N)" decorated name (loses the clean-name tiebreak in
 * planShortcutDedupe). Matches gas-app parseNoisyName: the counter form requires
 * a SPACE before "(N)" so a legitimate "Photo(2020).jpg" is not treated as noisy.
 */
export function isNoisyName(name: string): boolean {
  return /^copy of /i.test(name) || / \(\d+\)(\.[^.]+)?$/.test(name);
}

/**
 * Plan a within-folder shortcut dedupe: when several shortcuts point at the same
 * target, keep one (clean name beats a decorated one; tie-break on smallest id).
 */
export function planShortcutDedupe(
  existing: ReadonlyArray<ShortcutEntry>,
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
      survivors.push(group[0]!);
      continue;
    }
    const ranked = [...group].sort((a, b) => {
      const an = isNoisyName(a.name) ? 1 : 0;
      const bn = isNoisyName(b.name) ? 1 : 0;
      if (an !== bn) return an - bn;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    survivors.push(ranked[0]!);
    for (let i = 1; i < ranked.length; i++) trashShortcutIds.push(ranked[i]!.id);
  }
  return { survivors, trashShortcutIds };
}

// ─── Result types ─────────────────────────────────────────────────────────────

export interface RebuildResult {
  shortcutsCreated: number;
  shortcutsExisting: number;
  targetFilesScanned: number;
  foldersTouched: number;
  warnings: string[];
  conversionsCreated?: number;
  shortcutFallbacks?: number;
}

export interface ServiceResult<T> {
  ok: boolean;
  message: string;
  data?: T;
}

type MaterializeOutcome = 'converted' | 'shortcut' | 'skipped' | 'failed';

// ─── Helpers ────────────────────────────────────────────────────────────────

interface EventDrive {
  driveFolderId: string;
  name: string;
}

/** Read an event's Drive folder id + name from the Firestore events cache. */
async function getEventDrive(eventId: string): Promise<EventDrive | null> {
  try {
    const snap = await firestore().collection('events').doc(eventId).get();
    const data = snap.data();
    const driveFolderId = String(data?.driveFolderId ?? '').trim();
    if (!driveFolderId) return null;
    return { driveFolderId, name: String(data?.name ?? data?.folderName ?? eventId) };
  } catch (err) {
    logger.warn({ err, eventId }, 'getEventDrive failed');
    return null;
  }
}

function sid(): string {
  return env.MASTER_SPREADSHEET_ID;
}

/**
 * getOrCreate that also HEALS duplicates: `getOrCreateSubfolder` does a
 * non-atomic find-then-create, so two rebuilds racing on the same managed folder
 * (e.g. the inline per-upload hook firing for several volunteer folders at once)
 * can each create one — leaving two "Album"/"Videos"/"Photos_NNN" folders. This
 * lists ALL same-named folders, keeps the oldest (lowest id, deterministic so
 * repeated runs converge), trashes the rest (recoverable; their shortcuts/copies
 * are regenerated idempotently into the survivor), and returns the survivor plus
 * the trashed ids so the caller can drop their stale Special_Folders rows.
 */
async function consolidateManagedSubfolder(
  parentId: string,
  name: string,
  driveToken: string,
  warnings: string[],
): Promise<{ folder: { id: string; name: string }; trashedFolderIds: string[] }> {
  const matches = await findSubfoldersByName(parentId, name, { token: driveToken });
  if (matches.length <= 1) {
    const folder = matches[0] ?? (await getOrCreateSubfolder(parentId, name, { token: driveToken }));
    return { folder: { id: folder.id, name: folder.name }, trashedFolderIds: [] };
  }
  const [survivor, ...dups] = matches; // sorted by id ⇒ survivor is the oldest
  const trashedFolderIds: string[] = [];
  for (const dup of dups) {
    const trashed = await trashDriveFile(dup.id, { token: driveToken });
    if (trashed.ok) trashedFolderIds.push(dup.id);
    else warnings.push(`Failed to trash duplicate "${name}" folder ${dup.id}: ${trashed.error}`);
  }
  if (trashedFolderIds.length) {
    logger.info({ parentId, name, survivor: survivor!.id, trashed: trashedFolderIds.length }, 'consolidated duplicate managed folder');
  }
  return { folder: { id: survivor!.id, name: survivor!.name }, trashedFolderIds };
}

/**
 * consolidateManagedSubfolder + immediate stale-row cleanup. Used by the rebuild
 * so duplicates are healed in place as folders are (re)built.
 */
async function getOrHealManagedSubfolder(
  parentId: string,
  name: string,
  spreadsheetId: string,
  driveToken: string,
  warnings: string[],
): Promise<{ id: string; name: string }> {
  const { folder, trashedFolderIds } = await consolidateManagedSubfolder(parentId, name, driveToken, warnings);
  if (trashedFolderIds.length) {
    try {
      await deleteSpecialFolderRowsByFolderId(spreadsheetId, new Set(trashedFolderIds));
    } catch (err) {
      warnings.push(`Trashed ${trashedFolderIds.length} duplicate "${name}" folder(s) but stale-row cleanup failed: ${String(err)}`);
    }
  }
  return folder;
}

async function dedupeFolderShortcuts(
  existing: ShortcutEntry[],
  folderName: string,
  warnings: string[],
  driveToken: string,
): Promise<{ survivors: ShortcutEntry[]; removed: number }> {
  const { survivors, trashShortcutIds } = planShortcutDedupe(existing);
  if (trashShortcutIds.length === 0) return { survivors, removed: 0 };
  let removed = 0;
  for (const id of trashShortcutIds) {
    const trashed = await trashDriveFile(id, { token: driveToken });
    if (trashed.ok) removed++;
    else warnings.push(`Failed to trash duplicate shortcut ${id} in ${folderName}: ${trashed.error}`);
  }
  return { survivors, removed };
}

interface PhotoBucketCtx {
  index: number;
  folderName: string;
  folderId: string;
  usedNames: Set<string>;
  placed: number;
}

/**
 * Materialise one photo into a Photos_NNN bucket under the storage-minimizing
 * policy. JPEG → shortcut; non-JPEG → converted JPG (or shortcut fallback).
 */
export async function materializePhotoIntoBucket(
  photo: DriveMediaFile,
  ctx: PhotoBucketCtx,
  convertReady: boolean,
  warnings: string[],
  allowShortcutFallback: boolean,
  driveToken: string,
): Promise<MaterializeOutcome> {
  const action = decidePhotoAction(photo.mimeType);

  const linkShortcut = async (): Promise<MaterializeOutcome> => {
    const sc = await createDriveShortcut(ctx.folderId, photo.id, photo.name, { token: driveToken });
    if (!sc.ok) {
      warnings.push(`Failed to create shortcut for ${photo.name} (${photo.id}) in ${ctx.folderName}: ${sc.error}`);
      return 'failed';
    }
    // A shortcut inherits the TARGET's permissions, so share the target itself.
    await tryGrantAnyoneRead(photo.id, { token: driveToken });
    if (photo.name) ctx.usedNames.add(photo.name);
    return 'shortcut';
  };

  if (action === 'shortcut') return linkShortcut();

  // action === 'convert' (non-JPEG)
  if (convertReady) {
    const destName = photoCopyDestName(photo.name, ctx.usedNames);
    const resp = await convertImage({
      sourceFileId: photo.id,
      destFolderId: ctx.folderId,
      destName,
      jpgQuality: env.IMAGE_CONVERT_JPG_QUALITY,
      maxDim: null,
      bakeOrientation: true,
      preserveExif: true,
    });
    if (resp.ok && resp.destFileId) {
      ctx.usedNames.add(destName);
      const tagged = await setFileAppProperties(resp.destFileId, { [SOURCE_PHOTO_ID_PROPERTY]: photo.id }, { token: driveToken });
      if (!tagged.ok) {
        warnings.push(
          `Converted ${photo.name} (${photo.id}) into ${ctx.folderName} but could not tag sourcePhotoId on ` +
            `${resp.destFileId}: ${tagged.error}; it may be re-converted next rebuild.`,
        );
      }
      return 'converted';
    }
    warnings.push(
      `Conversion failed for ${photo.name} (${photo.id}) in ${ctx.folderName}: ${resp.message ?? resp.error ?? 'unknown'}` +
        (allowShortcutFallback ? '; falling back to a shortcut.' : '.'),
    );
    if (!allowShortcutFallback) return 'failed';
    return linkShortcut();
  }

  if (!allowShortcutFallback) return 'skipped';
  return linkShortcut();
}

// ─── Photos_NNN rebuild ─────────────────────────────────────────────────────

const EMPTY_RESULT = (): RebuildResult => ({
  shortcutsCreated: 0,
  shortcutsExisting: 0,
  targetFilesScanned: 0,
  foldersTouched: 0,
  warnings: [],
});

/**
 * Rebuild the per-event Photos_NNN buckets. Walks every photo under the event
 * subtree, partitions into buckets of ≤ MAX_PHOTOS_PER_BUCKET, and materialises
 * every photo not yet represented (JPEG→shortcut, non-JPEG→converted JPG /
 * shortcut fallback). Idempotent across all buckets.
 */
export async function rebuildEventPhotoFolders(eventId: string): Promise<ServiceResult<RebuildResult>> {
  const spreadsheetId = sid();
  if (!spreadsheetId) return { ok: false, message: 'master Sheet not configured' };

  const event = await getEventDrive(eventId);
  if (!event) return { ok: false, message: `Event "${eventId}" not found or has no Drive folder` };

  const driveToken = await getDriveToken(DRIVE_SCOPE_READWRITE);
  await ensureSpecialFoldersTab(spreadsheetId);

  const root = await getFolderById(event.driveFolderId, { token: driveToken });
  if (!root) return { ok: false, message: `Cannot open event Drive folder "${event.driveFolderId}"` };

  const photos = await walkMediaFiles(event.driveFolderId, isPhotoFile, {
    token: driveToken,
    skipChildFolder: isManagedFolderName,
  });
  photos.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const warnings: string[] = [];
  if (photos.length === 0) {
    return { ok: true, message: 'No photos found; nothing to rebuild.', data: EMPTY_RESULT() };
  }

  const convertReady = isImageConvertConfigured();
  if (!convertReady) {
    warnings.push('Image-convert service is not configured; non-JPEG photos will fall back to shortcuts.');
  }

  const totalBuckets = bucketCountForFiles(photos.length);
  const now = new Date().toISOString();

  let conversionsCreated = 0;
  let shortcutsCreated = 0;
  let entriesExisting = 0;
  let foldersTouched = 0;

  // Pass 1: ensure buckets, collect what's already represented across ALL buckets.
  const buckets: Array<PhotoBucketCtx | null> = [];
  const representedSourceIds = new Set<string>();

  for (let b = 1; b <= totalBuckets; b++) {
    const folderName = photosFolderName(b);
    let folder;
    try {
      folder = await getOrHealManagedSubfolder(event.driveFolderId, folderName, spreadsheetId, driveToken, warnings);
    } catch (err) {
      warnings.push(`Failed to create or open ${folderName}: ${String(err)}`);
      buckets.push(null);
      continue;
    }
    foldersTouched++;
    await tryGrantAnyoneRead(folder.id, { token: driveToken });

    const rawShortcuts = await listShortcutsInFolder(folder.id, { token: driveToken });
    const { survivors: shortcuts } = await dedupeFolderShortcuts(rawShortcuts, folderName, warnings, driveToken);
    const copies = await listManagedCopiesInFolder(folder.id, { token: driveToken });

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
    buckets.push({ index: b, folderName, folderId: folder.id, usedNames, placed });
  }

  // Pass 2: materialise every not-yet-represented photo into its position bucket.
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    if (!photo) continue;
    if (representedSourceIds.has(photo.id)) {
      entriesExisting++;
      continue;
    }
    const ctx = buckets[bucketIndexForPosition(i) - 1];
    if (!ctx) continue;
    const outcome = await materializePhotoIntoBucket(photo, ctx, convertReady, warnings, true, driveToken);
    if (outcome === 'failed' || outcome === 'skipped') continue;
    if (outcome === 'converted') conversionsCreated++;
    else shortcutsCreated++;
    representedSourceIds.add(photo.id);
    ctx.placed++;
  }

  // Upsert one Special_Folders row per bucket. Load the tab ONCE and reuse the
  // snapshot across all buckets so an N-bucket rebuild does a single Sheets read
  // (each bucket folderId is distinct, so a stale snapshot never double-appends).
  const sfRows = await loadSpecialFolderRows(spreadsheetId);
  for (const ctx of buckets) {
    if (!ctx) continue;
    await upsertSpecialFolderRow(
      spreadsheetId,
      {
        folderId: ctx.folderId,
        eventId,
        scope: 'photos',
        clubName: '',
        tag: '',
        folderName: ctx.folderName,
        folderIndex: ctx.index,
        folderUrl: driveFolderUrl(ctx.folderId),
        fileCount: ctx.placed,
        lastRefreshedAt: now,
      },
      { preloadedRows: sfRows },
    );
  }

  const created = conversionsCreated + shortcutsCreated;
  logger.info(
    { eventId, photos: photos.length, buckets: totalBuckets, conversionsCreated, shortcutsCreated, entriesExisting, warnings: warnings.length },
    'rebuildEventPhotoFolders done',
  );
  return {
    ok: true,
    message: `Rebuilt ${foldersTouched} Photos_NNN folder(s): ${created} new (${conversionsCreated} converted, ${shortcutsCreated} shortcut), ${entriesExisting} existing`,
    data: {
      shortcutsCreated: created,
      shortcutsExisting: entriesExisting,
      targetFilesScanned: photos.length,
      foldersTouched,
      warnings,
      conversionsCreated,
      shortcutFallbacks: shortcutsCreated,
    },
  };
}

// ─── Per-(event,club,tag) Videos / Album rebuild ─────────────────────────────

interface ClubScopedFolderSpec {
  scope: SpecialFolderScope;
  folderName: string;
  accept: (mimeType: string) => boolean;
  noun: string;
}

const VIDEOS_SPEC: ClubScopedFolderSpec = { scope: 'videos', folderName: VIDEOS_FOLDER_NAME, accept: isVideoFile, noun: 'videos' };
const ALBUM_SPEC: ClubScopedFolderSpec = { scope: 'albums', folderName: ALBUM_FOLDER_NAME, accept: isMediaFile, noun: 'files' };

/** Resolve the (event, club, tag) folder. Returns null when not yet on Drive. */
async function resolveClubTagFolder(
  eventFolderId: string,
  clubName: string,
  tag: string,
  driveToken: string,
): Promise<string | null> {
  const club = await findSubfolder(eventFolderId, clubName, { token: driveToken });
  if (!club) return null;
  if (!tag.trim()) return club.id;
  const tagFolder = await findSubfolder(club.id, tag, { token: driveToken });
  return tagFolder?.id ?? null;
}

/**
 * Link every target into a shortcut folder, creating a shortcut only for targets
 * that don't already have one. Grants anyone/reader on each NEWLY-linked target
 * (a shortcut inherits the target's sharing); never re-grants existing ones.
 */
export async function linkTargetsIntoShortcutFolder(
  shortcutFolderId: string,
  folderLabel: string,
  targets: ReadonlyArray<DriveMediaFile>,
  existingTargetIds: ReadonlySet<string>,
  driveToken: string,
): Promise<{ shortcutsCreated: number; shortcutsExisting: number; warnings: string[] }> {
  const warnings: string[] = [];
  let shortcutsCreated = 0;
  let shortcutsExisting = 0;
  const linked = new Set(existingTargetIds);
  for (const f of targets) {
    if (linked.has(f.id)) {
      shortcutsExisting++;
      continue;
    }
    const created = await createDriveShortcut(shortcutFolderId, f.id, f.name, { token: driveToken });
    if (!created.ok) {
      warnings.push(`Failed to link ${f.name} (${f.id}) into ${folderLabel}: ${created.error}`);
      continue;
    }
    await tryGrantAnyoneRead(f.id, { token: driveToken });
    shortcutsCreated++;
    linked.add(f.id);
  }
  return { shortcutsCreated, shortcutsExisting, warnings };
}

async function rebuildClubScopedFolder(
  eventId: string,
  clubName: string,
  tag: string,
  spec: ClubScopedFolderSpec,
): Promise<ServiceResult<RebuildResult>> {
  const spreadsheetId = sid();
  if (!spreadsheetId) return { ok: false, message: 'master Sheet not configured' };

  const event = await getEventDrive(eventId);
  if (!event) return { ok: false, message: `Event "${eventId}" not found or has no Drive folder` };

  const driveToken = await getDriveToken(DRIVE_SCOPE_READWRITE);
  await ensureSpecialFoldersTab(spreadsheetId);

  const scopeFolderId = await resolveClubTagFolder(event.driveFolderId, clubName, tag, driveToken);
  if (!scopeFolderId) {
    return { ok: true, message: 'Scope folder not present on Drive; nothing to do.', data: EMPTY_RESULT() };
  }

  const targets = await walkMediaFiles(scopeFolderId, spec.accept, { token: driveToken, skipChildFolder: isManagedFolderName });
  targets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const warnings: string[] = [];
  if (targets.length === 0) {
    return { ok: true, message: `No ${spec.noun} found; nothing to rebuild.`, data: EMPTY_RESULT() };
  }

  let shortcutFolder;
  try {
    shortcutFolder = await getOrHealManagedSubfolder(scopeFolderId, spec.folderName, spreadsheetId, driveToken, warnings);
  } catch (err) {
    return { ok: false, message: `Failed to create or open ${spec.folderName}: ${String(err)}` };
  }
  await tryGrantAnyoneRead(shortcutFolder.id, { token: driveToken });

  const rawExisting = await listShortcutsInFolder(shortcutFolder.id, { token: driveToken });
  const { survivors: existing } = await dedupeFolderShortcuts(rawExisting, spec.folderName, warnings, driveToken);
  const linkedTargetIds = new Set(existing.map((s) => s.targetId));

  const link = await linkTargetsIntoShortcutFolder(shortcutFolder.id, spec.folderName, targets, linkedTargetIds, driveToken);
  for (const w of link.warnings) warnings.push(w);

  await upsertSpecialFolderRow(spreadsheetId, {
    folderId: shortcutFolder.id,
    eventId,
    scope: spec.scope,
    clubName,
    tag,
    folderName: spec.folderName,
    folderIndex: 1,
    folderUrl: driveFolderUrl(shortcutFolder.id),
    fileCount: targets.length,
    lastRefreshedAt: new Date().toISOString(),
  });

  return {
    ok: true,
    message: `Rebuilt ${spec.folderName} for ${clubName}/${tag || '(no tag)'}: ${link.shortcutsCreated} new, ${link.shortcutsExisting} existing`,
    data: {
      shortcutsCreated: link.shortcutsCreated,
      shortcutsExisting: link.shortcutsExisting,
      targetFilesScanned: targets.length,
      foldersTouched: 1,
      warnings,
    },
  };
}

export function rebuildClubVideoFolder(eventId: string, clubName: string, tag: string): Promise<ServiceResult<RebuildResult>> {
  return rebuildClubScopedFolder(eventId, clubName, tag, VIDEOS_SPEC);
}

export function rebuildClubAlbumFolder(eventId: string, clubName: string, tag: string): Promise<ServiceResult<RebuildResult>> {
  return rebuildClubScopedFolder(eventId, clubName, tag, ALBUM_SPEC);
}

// ─── Per-event Videos / Album rebuild (aggregated over scopes) ────────────────

/** A (club, tag) pair under an event that owns its own Videos / Album folder. */
export interface EventScope {
  clubName: string;
  tag: string;
}

/** Aggregated result of rebuilding one folder kind across every scope. */
export interface ScopeAggregateResult {
  ok: boolean;
  scopesProcessed: number;
  foldersTouched: number;
  shortcutsCreated: number;
  shortcutsExisting: number;
  filesScanned: number;
  warnings: string[];
}

const EMPTY_AGG = (): ScopeAggregateResult => ({
  ok: true,
  scopesProcessed: 0,
  foldersTouched: 0,
  shortcutsCreated: 0,
  shortcutsExisting: 0,
  filesScanned: 0,
  warnings: [],
});

/**
 * Enumerate every (club, tag) scope under an event: each club folder yields a
 * (club, '') scope plus one (club, tag) scope per tag subfolder. Managed system
 * folders (Photos_NNN / Videos / Album) are skipped. Drive-listing errors are
 * logged and yield an empty / partial list rather than throwing — callers treat
 * "no scopes" as "nothing to rebuild".
 */
export async function listEventScopes(eventId: string): Promise<EventScope[]> {
  const event = await getEventDrive(eventId);
  if (!event) return [];
  const driveToken = await getDriveToken(DRIVE_SCOPE_READWRITE);
  let clubs;
  try {
    clubs = await listChildFolders(event.driveFolderId, { token: driveToken });
  } catch (err) {
    logger.warn({ err, eventId }, 'listEventScopes: listing club folders failed');
    return [];
  }
  const scopes: EventScope[] = [];
  for (const club of clubs) {
    if (isManagedFolderName(club.name)) continue;
    scopes.push({ clubName: club.name, tag: '' });
    let tags;
    try {
      tags = await listChildFolders(club.id, { token: driveToken });
    } catch (err) {
      logger.warn({ err, eventId, club: club.name }, 'listEventScopes: listing tag folders failed');
      continue;
    }
    for (const tag of tags) {
      if (isManagedFolderName(tag.name)) continue;
      scopes.push({ clubName: club.name, tag: tag.name });
    }
  }
  return scopes;
}

/** Fold a single per-scope rebuild kind across every scope into one summary. */
async function aggregateScopeRebuild(
  eventId: string,
  rebuildScope: (clubName: string, tag: string) => Promise<ServiceResult<RebuildResult>>,
): Promise<ScopeAggregateResult> {
  const agg = EMPTY_AGG();
  for (const { clubName, tag } of await listEventScopes(eventId)) {
    agg.scopesProcessed++;
    const r = await rebuildScope(clubName, tag).catch(
      (err): ServiceResult<RebuildResult> => ({ ok: false, message: String(err) }),
    );
    if (!r.ok) {
      agg.ok = false;
      agg.warnings.push(`${clubName}/${tag || '(no tag)'}: ${r.message}`);
      continue;
    }
    if (r.data) {
      agg.foldersTouched += r.data.foldersTouched;
      agg.shortcutsCreated += r.data.shortcutsCreated;
      agg.shortcutsExisting += r.data.shortcutsExisting;
      agg.filesScanned += r.data.targetFilesScanned;
      for (const w of r.data.warnings) agg.warnings.push(w);
    }
  }
  return agg;
}

/** Rebuild every Videos folder for an event (one per scope). Used as a step. */
export function rebuildEventVideoFolders(eventId: string): Promise<ScopeAggregateResult> {
  return aggregateScopeRebuild(eventId, (clubName, tag) => rebuildClubVideoFolder(eventId, clubName, tag));
}

/** Rebuild every Album folder for an event (one per scope). Used as a step. */
export function rebuildEventAlbumFolders(eventId: string): Promise<ScopeAggregateResult> {
  return aggregateScopeRebuild(eventId, (clubName, tag) => rebuildClubAlbumFolder(eventId, clubName, tag));
}

/** Photo / video / total-media counts for an event's source tree. */
export interface EventMediaCounts {
  photos: number;
  videos: number;
  media: number;
}

/**
 * Count the media in an event's source tree (excluding the managed Photos_NNN /
 * Videos / Album folders). A quick read-only pre-pass so the UI can show how
 * many photos a rebuild will touch before any folder work begins. Walks the
 * tree once and classifies by MIME — the SAME filter the Photos_NNN rebuild
 * uses, so the photo count matches what that step will materialise.
 */
export async function countEventMedia(eventId: string): Promise<EventMediaCounts> {
  const event = await getEventDrive(eventId);
  if (!event) return { photos: 0, videos: 0, media: 0 };
  const driveToken = await getDriveToken(DRIVE_SCOPE_READWRITE);
  const all = await walkMediaFiles(event.driveFolderId, isMediaFile, {
    token: driveToken,
    skipChildFolder: isManagedFolderName,
  });
  let photos = 0;
  let videos = 0;
  for (const f of all) {
    if (isPhotoFile(f.mimeType)) photos++;
    else if (isVideoFile(f.mimeType)) videos++;
  }
  return { photos, videos, media: all.length };
}

// ─── Full-event rebuild ───────────────────────────────────────────────────────

export interface RebuildAllResult {
  photos: ServiceResult<RebuildResult>;
  scopes: Array<{ clubName: string; tag: string; videos: ServiceResult<RebuildResult>; albums: ServiceResult<RebuildResult> }>;
}

/**
 * Rebuild Photos_NNN AND all Videos/Album folders for one event. Enumerates each
 * club subfolder, then each tag subfolder, and rebuilds the (club,'') and
 * (club,tag) scopes. Per-scope errors are captured, not thrown.
 */
export async function rebuildAllSpecialFoldersForEvent(eventId: string): Promise<RebuildAllResult> {
  const photos = await rebuildEventPhotoFolders(eventId);
  const scopes: RebuildAllResult['scopes'] = [];

  for (const { clubName, tag } of await listEventScopes(eventId)) {
    const videos = await rebuildClubVideoFolder(eventId, clubName, tag).catch((err) => ({ ok: false, message: String(err) }));
    const albums = await rebuildClubAlbumFolder(eventId, clubName, tag).catch((err) => ({ ok: false, message: String(err) }));
    scopes.push({ clubName, tag, videos, albums });
  }
  return { photos, scopes };
}

// ─── Duplicate managed-folder cleanup ─────────────────────────────────────────

export interface DedupeResult {
  ok: boolean;
  message: string;
  trashedFolders: number;
  rowsRemoved: number;
  warnings: string[];
}

/**
 * Find and remove duplicate managed folders for one event WITHOUT a full relink:
 * for each Photos_NNN bucket name (under the event root) and each Videos / Album
 * folder (under every club/tag scope), keep the oldest folder and trash the
 * rest, then drop the stale Special_Folders rows. Never CREATES a folder (only
 * consolidates names that already have ≥2 copies), so it is a safe, fast cleanup
 * an admin can run on its own; a subsequent rebuild repopulates the survivors.
 */
export async function dedupeEventManagedFolders(eventId: string): Promise<DedupeResult> {
  const spreadsheetId = sid();
  if (!spreadsheetId) return { ok: false, message: 'master Sheet not configured', trashedFolders: 0, rowsRemoved: 0, warnings: [] };
  const event = await getEventDrive(eventId);
  if (!event) return { ok: false, message: `Event "${eventId}" not found or has no Drive folder`, trashedFolders: 0, rowsRemoved: 0, warnings: [] };

  const driveToken = await getDriveToken(DRIVE_SCOPE_READWRITE);
  const warnings: string[] = [];
  const trashed: string[] = [];

  const consolidateIfDuplicated = async (parentId: string, name: string): Promise<void> => {
    const matches = await findSubfoldersByName(parentId, name, { token: driveToken });
    if (matches.length <= 1) return;
    const r = await consolidateManagedSubfolder(parentId, name, driveToken, warnings);
    trashed.push(...r.trashedFolderIds);
  };

  // Photos_NNN buckets live directly under the event root.
  try {
    const rootChildren = await listChildFolders(event.driveFolderId, { token: driveToken });
    const bucketNames = new Set(rootChildren.filter((f) => /^Photos_\d{3}$/.test(f.name)).map((f) => f.name));
    for (const name of bucketNames) await consolidateIfDuplicated(event.driveFolderId, name);
  } catch (err) {
    warnings.push(`Listing Photos_NNN buckets failed: ${String(err)}`);
  }

  // Videos / Album folders live under each (club, tag) scope.
  for (const { clubName, tag } of await listEventScopes(eventId)) {
    const scopeFolderId = await resolveClubTagFolder(event.driveFolderId, clubName, tag, driveToken);
    if (!scopeFolderId) continue;
    await consolidateIfDuplicated(scopeFolderId, VIDEOS_FOLDER_NAME);
    await consolidateIfDuplicated(scopeFolderId, ALBUM_FOLDER_NAME);
  }

  let rowsRemoved = 0;
  if (trashed.length) {
    try {
      rowsRemoved = await deleteSpecialFolderRowsByFolderId(spreadsheetId, new Set(trashed));
    } catch (err) {
      warnings.push(`Stale-row cleanup failed: ${String(err)}`);
    }
  }
  logger.info({ eventId, trashed: trashed.length, rowsRemoved, warnings: warnings.length }, 'dedupeEventManagedFolders done');
  return {
    ok: true,
    message: `Trashed ${trashed.length} duplicate folder(s); removed ${rowsRemoved} stale row(s).`,
    trashedFolders: trashed.length,
    rowsRemoved,
    warnings,
  };
}

/**
 * Best-effort post-batch hook: refresh the event's Photos_NNN buckets and the
 * specific (event, club, tag) Videos + Album folders. Swallows every error —
 * special folders are a downstream convenience, never allowed to fail an upload.
 */
export async function tryRebuildSpecialFoldersForBatch(eventId: string, clubName: string, tag: string): Promise<void> {
  for (const [label, fn] of [
    ['photos', () => rebuildEventPhotoFolders(eventId)],
    ['videos', () => rebuildClubVideoFolder(eventId, clubName, tag)],
    ['albums', () => rebuildClubAlbumFolder(eventId, clubName, tag)],
  ] as const) {
    try {
      const r = await fn();
      if (!r.ok) logger.warn({ eventId, clubName, tag, label, message: r.message }, 'special-folders rebuild non-fatal failure');
    } catch (err) {
      logger.warn({ err, eventId, clubName, tag, label }, 'special-folders rebuild threw (non-fatal)');
    }
  }
}

// ─── Orphan sweep (called after soft-delete) ─────────────────────────────────

export interface ShortcutSweepResult {
  shortcutsRemoved: number;
  foldersTouched: number;
  errors: string[];
}

/**
 * Remove every managed entry (shortcut or materialised copy) pointing at the
 * given deleted target file IDs, across every managed folder in Special_Folders.
 * Entries are TRASHED (recoverable). Each touched row's fileCount is decremented.
 */
export async function removeShortcutsForTargets(targetFileIds: ReadonlyArray<string>): Promise<ShortcutSweepResult> {
  const result: ShortcutSweepResult = { shortcutsRemoved: 0, foldersTouched: 0, errors: [] };
  const targets = new Set(targetFileIds.filter((id) => id && id.trim()));
  if (targets.size === 0) return result;

  const spreadsheetId = sid();
  if (!spreadsheetId) {
    result.errors.push('master Sheet not configured');
    return result;
  }
  const driveToken = await getDriveToken(DRIVE_SCOPE_READWRITE);

  let records: SpecialFolderRecord[];
  try {
    records = await listAllSpecialFolders(spreadsheetId);
  } catch (err) {
    result.errors.push(`Could not load Special_Folders: ${String(err)}`);
    return result;
  }

  const now = new Date().toISOString();
  for (const record of records) {
    if (!record.folderId) continue;
    let removedHere = 0;

    for (const shortcut of await listShortcutsInFolder(record.folderId, { token: driveToken })) {
      if (!targets.has(shortcut.targetId)) continue;
      const trashed = await trashDriveFile(shortcut.id, { token: driveToken });
      if (trashed.ok) removedHere++;
      else result.errors.push(`Failed to trash shortcut ${shortcut.id} in ${record.folderName}: ${trashed.error}`);
    }
    for (const copy of await listManagedCopiesInFolder(record.folderId, { token: driveToken })) {
      if (!targets.has(copy.sourcePhotoId)) continue;
      const trashed = await trashDriveFile(copy.id, { token: driveToken });
      if (trashed.ok) removedHere++;
      else result.errors.push(`Failed to trash copy ${copy.id} in ${record.folderName}: ${trashed.error}`);
    }

    if (removedHere > 0) {
      result.shortcutsRemoved += removedHere;
      result.foldersTouched++;
      await upsertSpecialFolderRow(spreadsheetId, {
        ...record,
        fileCount: Math.max(0, record.fileCount - removedHere),
        lastRefreshedAt: now,
      });
    }
  }
  logger.info({ targets: targets.size, removed: result.shortcutsRemoved, folders: result.foldersTouched }, 'removeShortcutsForTargets done');
  return result;
}

// ─── Backfill sharing on every managed folder (one-off admin utility) ────────

export async function backfillSpecialFoldersSharing(): Promise<BatchGrantSummary> {
  const spreadsheetId = sid();
  if (!spreadsheetId) return EMPTY_BATCH_GRANT_SUMMARY;
  const driveToken = await getDriveToken(DRIVE_SCOPE_READWRITE);

  let records: SpecialFolderRecord[];
  try {
    records = await listAllSpecialFolders(spreadsheetId);
  } catch (err) {
    logger.warn({ err }, 'backfillSpecialFoldersSharing: could not load Special_Folders');
    return EMPTY_BATCH_GRANT_SUMMARY;
  }

  let summary = EMPTY_BATCH_GRANT_SUMMARY;
  for (const r of records) {
    if (!r.folderId) continue;
    const grant = await grantAnyoneRead(r.folderId, { token: driveToken });
    summary = foldBatchGrantSummary(summary, grant, `${r.scope}/${r.folderName}(${r.folderId})`);
  }
  logger.info({ created: summary.created, alreadyShared: summary.alreadyShared, errors: summary.errors }, 'backfillSpecialFoldersSharing done');
  return summary;
}

// ─── One-off migration: convert non-JPEG Photos_NNN shortcuts to real JPGs ────

export interface PhotoMigrationResult {
  shortcutsScanned: number;
  conversionsCreated: number;
  shortcutsTrashed: number;
  danglingTrashed: number;
  skippedJpeg: number;
  skippedNoConvert: number;
  foldersTouched: number;
  warnings: string[];
}

/**
 * Upgrade historical NON-JPEG shortcuts in an event's Photos_NNN buckets to real
 * converted JPGs (then trash the shortcut). JPEG shortcuts are intentionally
 * LEFT in place — under the storage-minimizing policy a JPEG belongs as a
 * shortcut. Idempotent & resumable: a shortcut is trashed only once its real
 * file exists. Requires the convert service; non-JPEG shortcuts are skipped when
 * it's unconfigured.
 */
export async function migrateEventPhotoShortcutsToFiles(eventId: string): Promise<ServiceResult<PhotoMigrationResult>> {
  const spreadsheetId = sid();
  if (!spreadsheetId) return { ok: false, message: 'master Sheet not configured' };
  const event = await getEventDrive(eventId);
  if (!event) return { ok: false, message: `Event "${eventId}" not found or has no Drive folder` };

  const driveToken = await getDriveToken(DRIVE_SCOPE_READWRITE);
  const convertReady = isImageConvertConfigured();
  const result: PhotoMigrationResult = {
    shortcutsScanned: 0,
    conversionsCreated: 0,
    shortcutsTrashed: 0,
    danglingTrashed: 0,
    skippedJpeg: 0,
    skippedNoConvert: 0,
    foldersTouched: 0,
    warnings: [],
  };
  if (!convertReady) result.warnings.push('Image-convert not configured; non-JPEG shortcuts left in place.');

  const children = await listChildFolders(event.driveFolderId, { token: driveToken });
  for (const folder of children) {
    if (!/^Photos_\d{3}$/.test(folder.name)) continue;
    result.foldersTouched++;
    const rawShortcuts = await listShortcutsInFolder(folder.id, { token: driveToken });
    const { survivors: shortcuts } = await dedupeFolderShortcuts(rawShortcuts, folder.name, result.warnings, driveToken);
    const copies = await listManagedCopiesInFolder(folder.id, { token: driveToken });
    const copiesBySource = new Set(copies.map((c) => c.sourcePhotoId));
    const ctx: PhotoBucketCtx = {
      index: 0,
      folderName: folder.name,
      folderId: folder.id,
      usedNames: new Set<string>([...copies.map((c) => c.name), ...shortcuts.map((s) => s.name)].filter(Boolean)),
      placed: 0,
    };

    for (const shortcut of shortcuts) {
      result.shortcutsScanned++;
      const sourceId = shortcut.targetId;
      if (copiesBySource.has(sourceId)) {
        const t = await trashDriveFile(shortcut.id, { token: driveToken });
        if (t.ok) result.shortcutsTrashed++;
        continue;
      }
      let mime = shortcut.targetMimeType ?? '';
      let name = shortcut.name;
      if (!mime) {
        const lookup = await getDriveFileBasics(sourceId, { token: driveToken });
        if (lookup.found) {
          mime = lookup.file.mimeType;
          name = lookup.file.name || shortcut.name;
        } else if (lookup.gone) {
          const t = await trashDriveFile(shortcut.id, { token: driveToken });
          if (t.ok) result.danglingTrashed++;
          continue;
        } else {
          result.warnings.push(`Could not resolve target ${sourceId} for shortcut ${shortcut.id}; leaving for retry.`);
          continue;
        }
      }
      if (mime === JPEG_MIME) {
        result.skippedJpeg++; // JPEG belongs as a shortcut — leave it
        continue;
      }
      if (!convertReady) {
        result.skippedNoConvert++;
        continue;
      }
      const outcome = await materializePhotoIntoBucket({ id: sourceId, name, mimeType: mime }, ctx, true, result.warnings, false, driveToken);
      if (outcome === 'converted') {
        result.conversionsCreated++;
        copiesBySource.add(sourceId);
        const t = await trashDriveFile(shortcut.id, { token: driveToken });
        if (t.ok) result.shortcutsTrashed++;
      }
    }
  }

  await rebuildEventPhotoFolders(eventId);
  logger.info({ eventId, ...result, warnings: result.warnings.length }, 'migrateEventPhotoShortcutsToFiles done');
  return { ok: true, message: `Migrated Photos_NNN for "${event.name}": ${result.conversionsCreated} converted, ${result.shortcutsTrashed} shortcut(s) removed`, data: result };
}
