import { ResultStatus, UploadSource } from '../types/enums';
import { UploadLogRecord } from '../types/models';
import { ServiceResult } from '../types/responses';
import { getConfig } from '../config/constants';
import { getAllRows, appendRow } from './sheetService';
import { toUploadLogRecord, fromUploadLogRecord } from '../utils/sheetMapper';
import { generateUuid } from '../utils/uuid';
import { nowIsoTimestamp } from '../utils/dateFormatter';

/**
 * UploadLogService — read/write operations for the Upload_Log sheet.
 *
 * Writes one record per completed upload session. Each record captures:
 *   - Who uploaded (email + club)
 *   - Which event and batch folder
 *   - File counts and sizes
 *   - How many were skipped (duplicates / non-photos)
 *   - Upload source (web_app vs api)
 *
 * This service is only ever written to — records are never updated or deleted.
 * All log IDs are UUID v4 to support future cross-system reconciliation.
 */

// ─── Input type ───────────────────────────────────────────────────────────────

/**
 * Input to create an Upload_Log entry.
 * Differs from UploadLogRecord in that logId and uploadTimestamp
 * are generated here, not passed by the caller.
 */
export interface CreateUploadLogInput {
  readonly eventId: string;
  readonly clubName: string;
  readonly uploadedBy: string;
  readonly batchFolderName: string;
  readonly batchFolderId: string;
  readonly fileCount: number;
  readonly totalSizeMb: number;
  readonly skippedDuplicates: number;
  readonly skippedNonPhoto: number;
  readonly source: UploadSource;
  /** Upload link ID associated with this upload session (empty for admin uploads). */
  readonly linkId?: string;
  /**
   * Wall-clock upload duration in milliseconds.
   *
   * Volunteer / admin web uploads: measured client-side from the moment the
   * first byte leaves the browser to when all files have settled, then passed
   * through the finalize call. API uploads: measured server-side from handler
   * entry to just before appendUploadLog. Omit (or pass 0) if the duration
   * cannot be measured — the field is recorded as 0 in that case.
   */
  readonly durationMs?: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Appends a new row to the Upload_Log sheet for a completed upload session.
 *
 * Generates logId (UUID) and uploadTimestamp (ISO 8601) automatically.
 * Returns the fully-formed UploadLogRecord on success.
 *
 * @param input  Upload session summary from the upload service
 */
export function appendUploadLog(
  input: CreateUploadLogInput
): ServiceResult<UploadLogRecord> {
  try {
    // Clamp durationMs to a sane non-negative integer. A missing or invalid
    // value is recorded as 0 so downstream analytics can distinguish
    // "unknown" from "very fast".
    const rawDuration = Number(input.durationMs);
    const durationMs = isFinite(rawDuration) && rawDuration > 0
      ? Math.round(rawDuration)
      : 0;

    const record: UploadLogRecord = {
      logId:             generateUuid(),
      eventId:           input.eventId,
      clubName:          input.clubName,
      uploadedBy:        input.uploadedBy.trim().toLowerCase(),
      batchFolderName:   input.batchFolderName,
      batchFolderId:     input.batchFolderId,
      fileCount:         input.fileCount,
      totalSizeMb:       Math.round(input.totalSizeMb * 100) / 100, // 2 dp
      skippedDuplicates: input.skippedDuplicates,
      skippedNonPhoto:   input.skippedNonPhoto,
      uploadTimestamp:   nowIsoTimestamp(),
      source:            input.source,
      linkId:            input.linkId ?? '',
      durationMs,
    };

    const config = getConfig();
    appendRow(config.SHEET_NAMES.UPLOAD_LOG, fromUploadLogRecord(record));

    return {
      status: ResultStatus.SUCCESS,
      message: `Upload log written (logId: ${record.logId})`,
      data: record,
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to write upload log: ${String(err)}`,
    };
  }
}

/**
 * Returns all upload log records for a specific event.
 * Useful for the Phase 4 reconciliation summary.
 *
 * @param eventId  UUID from the Events sheet
 */
export function getLogsForEvent(eventId: string): ServiceResult<UploadLogRecord[]> {
  try {
    const config = getConfig();
    const rows = getAllRows(config.SHEET_NAMES.UPLOAD_LOG);
    const records = rows
      .map(toUploadLogRecord)
      .filter((r): r is UploadLogRecord => r !== null && r.eventId === eventId);

    return {
      status: ResultStatus.SUCCESS,
      message: `Found ${records.length} log(s) for event ${eventId}`,
      data: records,
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to read upload logs: ${String(err)}`,
    };
  }
}

/**
 * Returns the ISO 8601 timestamp of the most recent completed upload across
 * all events, or null when the Upload_Log sheet is empty.
 *
 * Used by the lazy public-sheet refresh trigger to decide whether any new
 * uploads have arrived since the Special_Folders shortcuts were last built.
 * Reading only the timestamp column (via getAllRows, which fetches all columns)
 * is slightly over-fetching, but Upload_Log rows are narrow and the total
 * sheet is small — the simplicity outweighs a bespoke column-range read.
 */
export function getLatestUploadTimestamp(): string | null {
  try {
    const config = getConfig();
    const rows = getAllRows(config.SHEET_NAMES.UPLOAD_LOG);
    let latest: string | null = null;
    for (const row of rows) {
      const r = toUploadLogRecord(row);
      if (!r || !r.uploadTimestamp) continue;
      if (latest === null || r.uploadTimestamp > latest) {
        latest = r.uploadTimestamp;
      }
    }
    return latest;
  } catch {
    return null;
  }
}

/**
 * Returns all upload log records across all events.
 * Used by the Phase 4 system-wide summary dashboard.
 */
export function getAllUploadLogs(): ServiceResult<UploadLogRecord[]> {
  try {
    const config = getConfig();
    const rows = getAllRows(config.SHEET_NAMES.UPLOAD_LOG);
    const records = rows
      .map(toUploadLogRecord)
      .filter((r): r is UploadLogRecord => r !== null);

    // Sort newest first
    records.sort((a, b) => b.uploadTimestamp.localeCompare(a.uploadTimestamp));

    return {
      status: ResultStatus.SUCCESS,
      message: `Found ${records.length} total upload log(s)`,
      data: records,
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to read all upload logs: ${String(err)}`,
    };
  }
}
