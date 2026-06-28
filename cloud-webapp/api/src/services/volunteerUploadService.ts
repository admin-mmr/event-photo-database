/**
 * volunteerUploadService.ts — GCS-first resumable uploads for volunteers.
 *
 * Why GCS-first (UPLOAD_RESUMABLE_NOTES): the legacy gas-app flow uploads
 * straight to Drive with `uploadType=multipart`, which is NOT resumable — a
 * dropped phone connection or a closed tab loses the whole batch (hence the
 * scary "DO NOT close this window" banner). GCS resumable uploads let the
 * browser resume from the last committed byte, and the bytes land in a staging
 * bucket WITHOUT handing a broad Drive OAuth token to the browser. A later
 * server-side step copies the staged originals into Drive and triggers the
 * indexer (see `enqueueStagedBatch`, wired into the `/complete` and worker
 * paths in `routes/volunteerUpload.ts`).
 *
 * The browser never sees a credential here: we call `createResumableUpload()`
 * with ADC (the api-runtime@ SA) and return only the opaque, single-object
 * session URI.
 */

import { randomUUID } from 'node:crypto';

import { Storage, type CreateResumableUploadOptions } from '@google-cloud/storage';

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { getSheetValues } from './sheetsService.js';
import { firestore } from '../lib/firestore.js';
import {
  getDriveToken,
  uploadFileToDrive,
  listEventImages,
  getOrCreateSubfolder,
  DRIVE_SCOPE_READWRITE,
} from './driveService.js';
import { triggerIndexJob } from './indexerJob.js';
import { appendUploadLog } from './uploadLogService.js';
import { initUploadBatch, updateUploadBatch } from './uploadBatchService.js';
import { buildCreditedFileName } from '../lib/creditedFileName.js';

/**
 * Tag substituted when an upload link carries no tag, so the Drive hierarchy
 * stays uniform (Event/Club/tag/batch). Mirrors the gas-app `DEFAULT_TAG`.
 */
const DEFAULT_TAG = 'ALL';

/** Compact UTC batch timestamp `YYYYMMDD-HHMMSS` — mirrors gas-app toBatchTimestamp. */
export function batchTimestamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  );
}

/**
 * Layer-3 batch folder name `YYYYMMDD-HHMMSS_<username>`. The volunteer flow is
 * unauthenticated, so the username segment derives from the typed photographer
 * name (lowercased, reduced to the safe `[a-z0-9._-]` class like gas-app
 * buildLayer3FolderName), falling back to `volunteer` when blank or fully
 * stripped. Always starts with a letter so it satisfies the Layer-3 convention.
 */
export function buildBatchFolderName(photographerName: string, now: Date = new Date()): string {
  const safe = (photographerName || '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const username = /^[a-z]/.test(safe) ? safe : `volunteer${safe ? `_${safe}` : ''}`;
  return `${batchTimestamp(now)}_${username}`;
}

// Upload_Links column indices — mirror gas-app constants.ts SheetColumns.UPLOAD_LINKS.
const LINKS_COL = {
  LINK_ID: 0,
  EVENT_ID: 1,
  CLUB_NAME: 2,
  TOKEN: 3,
  REVOKED_AT: 7,
  TAG: 10,
} as const;

// MIME → staging extension. Superset of the indexer's ORIG_EXT_BY_MIME so video
// is covered too; unknown types fall back to `bin`.
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
  'image/tiff': 'tif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

export function stagingExtForMime(mimeType: string | undefined): string {
  return (mimeType && EXT_BY_MIME[mimeType.toLowerCase()]) || 'bin';
}

let storage: Storage | null = null;
function getStorage(): Storage {
  if (storage === null) {
    storage = new Storage(env.GCP_PROJECT_ID ? { projectId: env.GCP_PROJECT_ID } : {});
  }
  return storage;
}

export interface ValidatedLink {
  linkId: string;
  eventId: string;
  clubName: string;
  tag: string;
  eventName: string;
}

const cell = (row: string[], i: number): string => (row[i] ?? '').trim();

/**
 * Validate a public upload-link token against the master Sheet's Upload_Links
 * tab (the same source the gas-app admin UI generates links into). A link is
 * valid when its TOKEN matches and REVOKED_AT is empty. Resolves the event name
 * from the `events` Firestore collection (populated by the reconciler) for the
 * upload page header.
 *
 * Throws `UploadLinkError` with a stable `code` so the route can map it to the
 * right HTTP status without leaking which part failed.
 */
export class UploadLinkError extends Error {
  constructor(
    public readonly code: 'not_configured' | 'invalid_token' | 'revoked',
    message: string,
  ) {
    super(message);
  }
}

// ── Upload_Links read cache ──────────────────────────────────────────────────
// validateUploadLink runs once PER FILE (one /session call is minted per
// upload), so a volunteer uploading a large batch — or several volunteers at
// once during an event — would otherwise read the WHOLE Upload_Links tab on
// every single file. Every Sheets read in the app is impersonated as the same
// DWD subject (env.DWD_SUBJECT), so they all share that one user's
// `ReadRequestsPerMinutePerUser` quota (60/min). A burst trips
// 429 RESOURCE_EXHAUSTED and uploads fail mid-batch.
//
// A short in-memory TTL cache of the tab collapses a whole batch into ~one read
// per minute — the same pattern userStore uses for the RBAC hot path. Links
// change rarely (an admin generates/revokes them), so a 60s staleness window is
// the accepted trade-off: a freshly minted link becomes usable within a minute,
// and a revoked link keeps working for at most a minute. Raising the API quota
// alone would only delay the failure; this removes the per-file read entirely.
const LINKS_CACHE_TTL_MS = 60_000;
let linksCache: { at: number; rows: string[][] } | null = null;

async function loadUploadLinks(spreadsheetId: string): Promise<string[][]> {
  if (linksCache && Date.now() - linksCache.at < LINKS_CACHE_TTL_MS) return linksCache.rows;
  const rows = await getSheetValues(spreadsheetId, `${env.UPLOAD_LINKS_SHEET_NAME}!A1:K`);
  linksCache = { at: Date.now(), rows };
  return rows;
}

/** Test-only: clear the in-memory Upload_Links cache between cases. */
export function __clearUploadLinksCache(): void {
  linksCache = null;
}

export async function validateUploadLink(token: string): Promise<ValidatedLink> {
  const spreadsheetId = env.MASTER_SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new UploadLinkError('not_configured', 'Upload links are not configured (no master Sheet).');
  }

  const values = await loadUploadLinks(spreadsheetId);
  const match = values.find((row) => cell(row, LINKS_COL.TOKEN) === token);
  if (!match) throw new UploadLinkError('invalid_token', 'This upload link is not valid.');
  if (cell(match, LINKS_COL.REVOKED_AT)) {
    throw new UploadLinkError('revoked', 'This upload link has been revoked.');
  }

  const eventId = cell(match, LINKS_COL.EVENT_ID);
  let eventName = '';
  try {
    const snap = await firestore().collection('events').doc(eventId).get();
    eventName = String(snap.data()?.name ?? '');
  } catch (err) {
    logger.warn({ err, eventId }, 'volunteer upload: event name lookup failed (non-fatal)');
  }

  return {
    linkId: cell(match, LINKS_COL.LINK_ID),
    eventId,
    clubName: cell(match, LINKS_COL.CLUB_NAME),
    tag: cell(match, LINKS_COL.TAG),
    eventName,
  };
}

/** Staging object key: `<prefix>/<eventId>/<batchId>/<uploadId>.<ext>`. */
export function stagingObjectName(
  eventId: string,
  batchId: string,
  uploadId: string,
  mimeType: string | undefined,
): string {
  return `${env.VOLUNTEER_STAGING_PREFIX}/${eventId}/${batchId}/${uploadId}.${stagingExtForMime(mimeType)}`;
}

export interface CreatedSession {
  uploadId: string;
  objectName: string;
  sessionUri: string;
}

/**
 * Initiate a GCS resumable upload session for one file and return its session
 * URI. `origin` MUST match the bucket CORS config or the browser's PUTs are
 * blocked. We stamp the original filename + link metadata onto the object so
 * the later Drive-copy step can reconstruct the credited name without a side
 * channel.
 */
export async function createResumableSession(
  link: ValidatedLink,
  batchId: string,
  fileName: string,
  mimeType: string,
  photographerName = '',
): Promise<CreatedSession> {
  const uploadId = randomUUID();
  const objectName = stagingObjectName(link.eventId, batchId, uploadId, mimeType);

  // Only set `origin` when configured — under exactOptionalPropertyTypes an
  // explicit `undefined` is rejected by the storage client's options type.
  const options: CreateResumableUploadOptions = {
    metadata: {
      contentType: mimeType || 'application/octet-stream',
      metadata: {
        eventId: link.eventId,
        linkId: link.linkId,
        clubName: link.clubName,
        tag: link.tag,
        originalName: fileName,
        // Stamped so the later Drive-copy step can reconstruct the credited
        // filename without a side channel. Trimmed to keep object metadata tidy.
        photographerName: photographerName.trim(),
        batchId,
      },
    },
  };
  if (env.VOLUNTEER_UPLOAD_ORIGIN) options.origin = env.VOLUNTEER_UPLOAD_ORIGIN;

  const [sessionUri] = await getStorage()
    .bucket(env.VOLUNTEER_STAGING_BUCKET)
    .file(objectName)
    .createResumableUpload(options);

  return { uploadId, objectName, sessionUri };
}

/**
 * Resolve the event's destination Drive folder id from the `events` Firestore
 * doc (kept in sync by the reconciler from the master Sheet). Throws a
 * `not_configured` UploadLinkError (→ 503) if the event has no folder, so a
 * misconfigured event surfaces as a server error rather than silently dropping
 * a volunteer's photos.
 */
async function resolveEventFolderId(eventId: string): Promise<string> {
  const snap = await firestore().collection('events').doc(eventId).get();
  const folderId = String(snap.data()?.driveFolderId ?? '').trim();
  if (!folderId) {
    throw new UploadLinkError(
      'not_configured',
      `Event ${eventId} has no Drive folder configured; cannot accept uploads.`,
    );
  }
  return folderId;
}

/** Outcome of a handoff: how many staged files were copied into Drive (new)
 *  vs. skipped because an identical file is already in the event's folder. */
export interface BatchResult {
  copied: number;
  skippedDuplicates: number;
  /** Credited filenames skipped as duplicates (same length as skippedDuplicates). */
  skippedDuplicateNames: string[];
}

/**
 * Dedup key for a candidate file: credited name (case-insensitive) + byte size.
 * Mirrors the gas-app DuplicateCheckService strategy — filename alone collides
 * across camera rolls and size alone collides across different photos, but the
 * pair is very unlikely to match by chance. We key on the CREDITED name (what we
 * actually write to Drive) so a re-upload through the same link — which produces
 * the same `<Club>_<Photographer>_<original>` name — is recognised as a dup.
 */
function dedupKey(name: string, size: number): string {
  return `${name.toLowerCase()}|${size}`;
}

/**
 * Hand a finished batch of staged objects off to Drive + the indexer:
 *   1. List the event's existing Drive images once so we can skip re-uploads
 *      (duplicate-check by credited name + byte size).
 *   2. Verify each staged object exists and is non-zero (guards against a client
 *      that called /complete before its PUTs finished).
 *   3. Rename the original to its photographer-credit name
 *      (`<Club>_<Photographer>_<original>`, from the link + stamped metadata),
 *      skip it if a file with that name + size is already present (or appeared
 *      earlier in this same batch), otherwise copy it into the event's Drive
 *      folder and delete the staged copy.
 *   4. Trigger the photo-indexer job once for the event — only if ≥1 file landed.
 *
 * Files land in the gas-app folder hierarchy
 *   Event(driveFolderId) / Club_Name / tag (DEFAULT_TAG when blank) /
 *   YYYYMMDD-HHMMSS_<photographer|volunteer>
 * so the drive-tree view, special-folders rebuild, and public-sheet index see
 * the same layout the legacy Apps Script upload produced. The Club/tag/batch
 * folders are created lazily on the first non-duplicate file, so an all-duplicate
 * batch never leaves an empty folder behind.
 *
 * Returns `{ copied, skippedDuplicates }` so the receipt can report both. A
 * failed Drive copy for one file is logged and skipped rather than failing the
 * whole batch.
 *
 * NOTE: each object is buffered in memory for the copy (`file.download()`).
 * Fine for photos; revisit with a streamed copy if large videos become common.
 */
export async function enqueueStagedBatch(
  link: ValidatedLink,
  batchId: string,
  objectNames: string[],
): Promise<BatchResult> {
  if (objectNames.length === 0) return { copied: 0, skippedDuplicates: 0, skippedDuplicateNames: [] };

  // Make the batch observable (UPLOAD_ASYNC_QUEUE_DESIGN.md step 1). Best-effort:
  // status writes must never fail an upload whose bytes are already staged.
  await initUploadBatch(batchId, link.eventId, link.linkId, objectNames.length);

  const folderId = await resolveEventFolderId(link.eventId);
  const bucket = getStorage().bucket(env.VOLUNTEER_STAGING_BUCKET);
  const driveToken = await getDriveToken(DRIVE_SCOPE_READWRITE);

  // Snapshot existing Drive files for the duplicate check. Best-effort: if the
  // listing fails we proceed WITHOUT dedup rather than blocking the upload (the
  // indexer dedups by content hash downstream, so a stray dup is not fatal).
  const seen = new Set<string>();
  try {
    const existing = await listEventImages(folderId, { token: driveToken });
    for (const f of existing) seen.add(dedupKey(f.name, Number(f.size ?? 0)));
  } catch (err) {
    logger.warn({ err, eventId: link.eventId, folderId }, 'duplicate-check listing failed (proceeding without dedup)');
  }

  // Lazily build Event/Club/tag/batch and memoize the batch folder id, so the
  // path is only created when at least one real (non-duplicate) file needs it.
  // `photographerName` names the batch folder; the whole session shares one name.
  let batchFolderId: string | null = null;
  let batchFolderName = '';
  const ensureBatchFolder = async (photographerName: string): Promise<string> => {
    if (batchFolderId) return batchFolderId;
    let parent = folderId;
    if (link.clubName) parent = (await getOrCreateSubfolder(parent, link.clubName, { token: driveToken })).id;
    const tag = (link.tag || '').trim() || DEFAULT_TAG;
    parent = (await getOrCreateSubfolder(parent, tag, { token: driveToken })).id;
    const batchName = buildBatchFolderName(photographerName);
    batchFolderId = (await getOrCreateSubfolder(parent, batchName, { token: driveToken })).id;
    batchFolderName = batchName;
    logger.info({ eventId: link.eventId, batchId, batchFolderId, batchName, tag }, 'volunteer batch folder ready');
    return batchFolderId;
  };

  let copied = 0;
  let copiedBytes = 0;
  let skippedDuplicates = 0;
  let failed = 0;
  const skippedDuplicateNames: string[] = [];
  for (const objectName of objectNames) {
    try {
      const file = bucket.file(objectName);
      const [exists] = await file.exists();
      if (!exists) {
        logger.warn({ eventId: link.eventId, batchId, objectName }, 'staged object missing, skipping');
        continue;
      }
      const [meta] = await file.getMetadata();
      const size = Number(meta.size ?? 0);
      if (!size) {
        logger.warn({ eventId: link.eventId, batchId, objectName }, 'staged object is empty, skipping');
        continue;
      }
      const custom = (meta.metadata ?? {}) as Record<string, string>;
      const originalName = (custom.originalName || objectName.split('/').pop() || objectName).trim();
      const contentType = meta.contentType || 'application/octet-stream';

      // Photographer-credit rename (defence-in-depth: re-derived server-side, the
      // browser is never the only place this happens). Club comes from the link;
      // photographer name was stamped at session-create time.
      const name = buildCreditedFileName({
        clubShortName: link.clubName,
        photographerName: custom.photographerName ?? '',
        originalFileName: originalName,
      });

      // Duplicate-check against existing Drive files AND earlier files in this
      // same batch. Skip + clean up rather than writing a second copy.
      const key = dedupKey(name, size);
      if (seen.has(key)) {
        skippedDuplicates += 1;
        skippedDuplicateNames.push(name);
        logger.info({ eventId: link.eventId, batchId, objectName, name }, 'duplicate skipped');
        await file
          .delete({ ignoreNotFound: true })
          .catch((err) => logger.warn({ err, objectName }, 'duplicate cleanup failed (non-fatal)'));
        continue;
      }

      const destFolderId = await ensureBatchFolder(custom.photographerName ?? '');
      const [bytes] = await file.download();
      await uploadFileToDrive(destFolderId, name, contentType, bytes, { token: driveToken });
      seen.add(key);
      copied += 1;
      copiedBytes += size;

      // Best-effort cleanup; the bucket lifecycle rule is the backstop.
      await file
        .delete({ ignoreNotFound: true })
        .catch((err) => logger.warn({ err, objectName }, 'staged object cleanup failed (non-fatal)'));
    } catch (err) {
      failed += 1;
      logger.error({ err, eventId: link.eventId, batchId, objectName }, 'staged object copy to Drive failed');
    }
  }

  if (copied > 0) {
    try {
      const { execution } = await triggerIndexJob(link.eventId);
      logger.info(
        { eventId: link.eventId, batchId, copied, skippedDuplicates, execution },
        'volunteer batch copied to Drive; indexer triggered',
      );
    } catch (err) {
      // Files are safely in Drive; the next scheduled/manual scan will index them.
      logger.error({ err, eventId: link.eventId, batchId, copied }, 'index trigger failed after Drive copy');
    }
  } else {
    logger.warn(
      { eventId: link.eventId, batchId, requested: objectNames.length, skippedDuplicates },
      'volunteer batch: no files copied',
    );
  }

  // Record the completed session in the master Sheet's Upload_Log tab so the
  // cloud webapp populates the same analytics surface as the legacy gas-app.
  // Best-effort: the files are already in Drive, so a failed log row must not
  // fail the upload. Logged for an all-duplicate batch too (copied === 0), with
  // empty batch-folder fields since no folder was created in that case.
  await appendUploadLog({
    eventId: link.eventId,
    clubName: link.clubName,
    batchFolderName,
    batchFolderId: batchFolderId ?? '',
    fileCount: copied,
    totalSizeMb: copiedBytes / (1024 * 1024),
    skippedDuplicates,
    source: 'link',
    linkId: link.linkId,
  });

  // Mark the batch observable-terminal for step 1: `indexing` once the copy
  // succeeded and the indexer was triggered, else `done` (nothing to index).
  // When the copy moves to a background worker (step 3), the worker owns these
  // transitions and can additionally flip to `ready` when the index run finishes.
  await updateUploadBatch(batchId, {
    phase: copied > 0 ? 'indexing' : 'done',
    copied,
    skippedDuplicates,
    skippedDuplicateNames,
    failed,
    batchFolderName,
  });

  return { copied, skippedDuplicates, skippedDuplicateNames };
}
