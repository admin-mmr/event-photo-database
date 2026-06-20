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
 * Hand a finished batch of staged objects off to the Drive-copy + index step.
 *
 * TODO(UPLOAD_RESUMABLE_NOTES): wire to the real pipeline. The intended design:
 *   1. Verify each staged object exists and its size is non-zero (guards against
 *      a client that called /complete without finishing the PUTs).
 *   2. Copy/move originals from the staging bucket into the event's Drive
 *      folder (needs a `drive` write scope on the DWD client — driveService
 *      currently requests `drive.readonly`), preserving the credited filename.
 *   3. Trigger the photo-indexer job for the event (services/indexerJob.ts).
 *   4. Record a receipt + audit row (mirror gas-app completeUpload).
 * For now we just log and report the count so the front end can show a receipt.
 */
export async function enqueueStagedBatch(
  link: ValidatedLink,
  batchId: string,
  objectNames: string[],
): Promise<number> {
  logger.info(
    { eventId: link.eventId, batchId, count: objectNames.length },
    'volunteer upload batch staged (Drive copy + index not yet wired)',
  );
  return objectNames.length;
}
