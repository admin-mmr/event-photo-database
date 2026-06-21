/**
 * uploadLogService.ts — append a completed-batch summary row to the master
 * Sheet's Upload_Log tab from the cloud webapp.
 *
 * The legacy gas-app writes one Upload_Log row per completed upload session
 * (see gas-app uploadLogService.appendUploadLog). The cloud webapp uploads to a
 * GCS staging bucket and then copies the originals into Drive
 * (volunteerUploadService.enqueueStagedBatch); this module mirrors the gas-app
 * record so both upload paths populate the same analytics tab.
 *
 * Column order MUST match gas-app sheetMapper.fromUploadLogRecord exactly:
 *   logId, eventId, clubName, uploadedBy, batchFolderName, batchFolderId,
 *   fileCount, totalSizeMb, skippedDuplicates, skippedNonPhoto,
 *   uploadTimestamp, source, linkId, durationMs
 *
 * Writing is best-effort at the call site: a failed log row must never fail an
 * upload whose bytes are already safely in Drive.
 */

import { randomUUID } from 'node:crypto';

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { appendSheetValues } from './sheetsService.js';

/**
 * UploadSource as stored in the Sheet. Cloud-webapp volunteer uploads arrive via
 * a shared per-(event, club) link, so the source is `link` — matching gas-app
 * enums.UploadSource.LINK. (`web_app` is reserved for signed-in admin uploads.)
 */
export type UploadSource = 'web_app' | 'link';

export interface AppendUploadLogInput {
  readonly eventId: string;
  readonly clubName: string;
  /** Uploader's Google email. Empty for unauthenticated link uploads. */
  readonly uploadedBy?: string;
  readonly batchFolderName: string;
  readonly batchFolderId: string;
  readonly fileCount: number;
  readonly totalSizeMb: number;
  readonly skippedDuplicates: number;
  /** Files rejected for wrong MIME type. The cloud flow rejects these at the
   *  /session step (HTTP 415) before staging, so this is normally 0 here. */
  readonly skippedNonPhoto?: number;
  readonly source?: UploadSource;
  readonly linkId?: string;
  /** Wall-clock upload duration (ms); 0 when not measured server-side. */
  readonly durationMs?: number;
}

/**
 * Append one Upload_Log row. Returns true when a row was written, false when
 * logging is not configured or the append failed (both non-fatal — the caller
 * has already persisted the files).
 *
 * No-ops (returns false) when MASTER_SPREADSHEET_ID is unset, matching the rest
 * of the cloud webapp's "Sheet optional until configured" behaviour.
 */
export async function appendUploadLog(input: AppendUploadLogInput): Promise<boolean> {
  const spreadsheetId = env.MASTER_SPREADSHEET_ID;
  if (!spreadsheetId) {
    logger.warn({ eventId: input.eventId }, 'Upload_Log skipped: no master spreadsheet configured');
    return false;
  }

  const rawDuration = Number(input.durationMs);
  const durationMs = Number.isFinite(rawDuration) && rawDuration > 0 ? Math.round(rawDuration) : 0;

  const row: unknown[] = [
    randomUUID(),                                   // logId
    input.eventId,                                  // eventId
    input.clubName,                                 // clubName
    (input.uploadedBy ?? '').trim().toLowerCase(),  // uploadedBy
    input.batchFolderName,                          // batchFolderName
    input.batchFolderId,                            // batchFolderId
    input.fileCount,                                // fileCount
    Math.round(input.totalSizeMb * 100) / 100,      // totalSizeMb (2 dp)
    input.skippedDuplicates,                        // skippedDuplicates
    input.skippedNonPhoto ?? 0,                     // skippedNonPhoto
    new Date().toISOString(),                       // uploadTimestamp (ISO 8601)
    input.source ?? 'link',                         // source
    input.linkId ?? '',                             // linkId
    durationMs,                                     // durationMs
  ];

  try {
    await appendSheetValues(spreadsheetId, `${env.UPLOAD_LOG_SHEET_NAME}!A1`, [row]);
    logger.info(
      { eventId: input.eventId, linkId: input.linkId, fileCount: input.fileCount },
      'Upload_Log row appended',
    );
    return true;
  } catch (err) {
    logger.error({ err, eventId: input.eventId }, 'Upload_Log append failed (non-fatal)');
    return false;
  }
}
