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
 * indexer (see `enqueueStagedBatch` — currently a stub).
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
import { getDriveToken, uploadFileToDrive, DRIVE_SCOPE_READWRITE } from './driveService.js';
import { triggerIndexJob } from './indexerJob.js';

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

export async function validateUploadLink(token: string): Promise<ValidatedLink> {
  const spreadsheetId = env.MASTER_SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new UploadLinkError('not_configured', 'Upload links are not configured (no master Sheet).');
  }

  const values = await getSheetValues(spreadsheetId, `${env.UPLOAD_LINKS_SHEET_NAME}!A1:K`);
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

/**
 * Hand a finished batch of staged objects off to Drive + the indexer:
 *   1. Verify each staged object exists and is non-zero (guards against a client
 *      that called /complete before its PUTs finished).
 *   2. Copy the original from the staging bucket into the event's Drive folder,
 *      preserving the uploaded filename (stamped as `originalName` metadata when
 *      the session was minted), then delete the staged copy.
 *   3. Trigger the photo-indexer job once for the event (it diffs the folder and
 *      embeds the new photos).
 *
 * Returns the number of files actually copied so the front end can show an
 * accurate receipt. A failed Drive copy for one file is logged and skipped
 * rather than failing the whole batch; the index trigger fires only if at least
 * one file landed.
 *
 * NOTE: each object is buffered in memory for the copy (`file.download()`).
 * Fine for photos; revisit with a streamed copy if large videos become common.
 */
export async function enqueueStagedBatch(
  link: ValidatedLink,
  batchId: string,
  objectNames: string[],
): Promise<number> {
  if (objectNames.length === 0) return 0;

  const folderId = await resolveEventFolderId(link.eventId);
  const bucket = getStorage().bucket(env.VOLUNTEER_STAGING_BUCKET);
  const driveToken = await getDriveToken(DRIVE_SCOPE_READWRITE);

  let copied = 0;
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
      const name = (custom.originalName || objectName.split('/').pop() || objectName).trim();
      const contentType = meta.contentType || 'application/octet-stream';

      const [bytes] = await file.download();
      await uploadFileToDrive(folderId, name, contentType, bytes, { token: driveToken });
      copied += 1;

      // Best-effort cleanup; the bucket lifecycle rule is the backstop.
      await file
        .delete({ ignoreNotFound: true })
        .catch((err) => logger.warn({ err, objectName }, 'staged object cleanup failed (non-fatal)'));
    } catch (err) {
      logger.error({ err, eventId: link.eventId, batchId, objectName }, 'staged object copy to Drive failed');
    }
  }

  if (copied > 0) {
    try {
      const { execution } = await triggerIndexJob(link.eventId);
      logger.info({ eventId: link.eventId, batchId, copied, execution }, 'volunteer batch copied to Drive; indexer triggered');
    } catch (err) {
      // Files are safely in Drive; the next scheduled/manual scan will index them.
      logger.error({ err, eventId: link.eventId, batchId, copied }, 'index trigger failed after Drive copy');
    }
  } else {
    logger.warn({ eventId: link.eventId, batchId, requested: objectNames.length }, 'volunteer batch: no files copied');
  }

  return copied;
}
