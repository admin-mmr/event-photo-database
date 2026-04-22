import { AuditAction, ResultStatus } from '../types/enums';
import { AuditLogRecord } from '../types/models';
import { ServiceResult } from '../types/responses';
import { getConfig } from '../config/constants';
import { getAllRows, appendRow } from './sheetService';
import { toAuditLogRecord, fromAuditLogRecord } from '../utils/sheetMapper';
import { generateUuid } from '../utils/uuid';
import { nowIsoTimestamp } from '../utils/dateFormatter';

/**
 * AuditLogService — append-only write/read operations for the Audit_Log sheet.
 *
 * Records one entry per successful state-changing admin action. The log is
 * intended to be read by admins from the ?action=admin_audit page, and is
 * never modified after writing.
 *
 * Column layout (matches COLUMNS.AUDIT_LOG):
 *   0  AUDIT_ID      UUID v4
 *   1  TIMESTAMP     ISO 8601 timestamp (UTC)
 *   2  ACTOR_EMAIL   Admin who performed the action (lowercase)
 *   3  ACTION        AuditAction enum value (e.g. "USER_CREATED")
 *   4  RESOURCE_TYPE "user" | "event" | "club" | "report"
 *   5  RESOURCE_ID   Email / eventId / normalizedName / "" for reports
 *   6  DETAILS       JSON string of relevant payload fields
 */

// ─── Input type ───────────────────────────────────────────────────────────────

export interface CreateAuditLogInput {
  readonly actorEmail:   string;
  readonly action:       AuditAction;
  readonly resourceType: string;
  readonly resourceId:   string;
  readonly details:      Record<string, unknown>;
  /** Upload link ID used for this action (upload events only). */
  readonly linkId?:      string;
  /** IP address of the actor (when available). */
  readonly ipAddress?:   string;
  /** Optional free-text reason (especially for deletes and revocations). */
  readonly reason?:      string;
}

// ─── Query type ───────────────────────────────────────────────────────────────

export interface AuditLogQuery {
  readonly page:        number;
  readonly pageSize:    number;
  readonly actorEmail?: string;   // filter by actor (substring, case-insensitive)
  readonly dateFrom?:   string;   // ISO 8601 date "YYYY-MM-DD"
  readonly dateTo?:     string;   // ISO 8601 date "YYYY-MM-DD"
}

export interface AuditLogPage {
  readonly items:    AuditLogRecord[];
  readonly total:    number;
  readonly page:     number;
  readonly pageSize: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Appends a new row to Audit_Log for a completed admin action.
 *
 * Generates auditId (UUID) and timestamp automatically.
 * Silently catches write errors — audit failures must never break the
 * primary operation that triggered them.
 *
 * @param input  Action summary from the server function
 */
export function appendAuditLog(input: CreateAuditLogInput): void {
  try {
    const record: AuditLogRecord = {
      auditId:      generateUuid(),
      timestamp:    nowIsoTimestamp(),
      actorEmail:   input.actorEmail.trim().toLowerCase(),
      action:       input.action,
      resourceType: input.resourceType,
      resourceId:   input.resourceId,
      details:      JSON.stringify(input.details),
      linkId:       input.linkId    ?? '',
      ipAddress:    input.ipAddress ?? '',
      reason:       input.reason    ?? '',
    };

    const config = getConfig();
    appendRow(config.SHEET_NAMES.AUDIT_LOG, fromAuditLogRecord(record));
  } catch (err) {
    // Intentionally swallowed — audit write failures are non-fatal.
    // The primary operation has already succeeded at this point.
    /* global Logger */
    Logger.log(`[AuditLog] appendAuditLog failed (non-fatal): ${String(err)}`);
  }
}

/**
 * Returns a filtered, paginated view of the Audit_Log sheet.
 * Results are sorted newest-first.
 *
 * @param query  Pagination + optional filters
 */
export function getAuditLogs(query: AuditLogQuery): ServiceResult<AuditLogPage> {
  try {
    const config = getConfig();
    const rows = getAllRows(config.SHEET_NAMES.AUDIT_LOG);

    let records = rows
      .map(toAuditLogRecord)
      .filter((r): r is AuditLogRecord => r !== null);

    // Sort newest first
    records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    // Filters
    if (query.actorEmail) {
      const needle = query.actorEmail.toLowerCase().trim();
      records = records.filter((r) => r.actorEmail.includes(needle));
    }
    if (query.dateFrom) {
      const from = `${query.dateFrom}T00:00:00.000Z`;
      records = records.filter((r) => r.timestamp >= from);
    }
    if (query.dateTo) {
      const to = `${query.dateTo}T23:59:59.999Z`;
      records = records.filter((r) => r.timestamp <= to);
    }

    const total = records.length;
    const start = (query.page - 1) * query.pageSize;
    const items = records.slice(start, start + query.pageSize);

    return {
      status: ResultStatus.SUCCESS,
      message: `Found ${total} audit log entry(s)`,
      data: { items, total, page: query.page, pageSize: query.pageSize },
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to read audit log: ${String(err)}`,
    };
  }
}
