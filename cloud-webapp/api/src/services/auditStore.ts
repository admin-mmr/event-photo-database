/**
 * auditStore.ts — append-only control-plane audit log, Google Sheet as SSOT
 * (dev plan D2/G1.1, §2 item 9). Every state-changing admin action appends a row
 * to the `Audit_Log` tab; a best-effort Firestore mirror (`auditLog`) + a
 * structured log line keep the trail queryable and survivable even if a write
 * fails. Mirrors gas-app COLUMNS.AUDIT_LOG and its resource-type vocabulary.
 *
 * Writing is best-effort and NEVER blocks the action it records — but the log
 * line always fires, so an admin action is never silent (matches adminAudit.ts).
 */

import { randomUUID } from 'node:crypto';

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';
import { appendSheetValues } from './sheetsService.js';
import { cell, readTab } from './sheetTable.js';

const TAB = 'Audit_Log';
const LAST_COL = 'J';
const COL = {
  AUDIT_ID: 0,
  TIMESTAMP: 1,
  ACTOR_EMAIL: 2,
  ACTION: 3,
  RESOURCE_TYPE: 4,
  RESOURCE_ID: 5,
  DETAILS: 6,
  LINK_ID: 7,
  IP_ADDRESS: 8,
  REASON: 9,
} as const;
const WIDTH = 10; // A..J

export type AuditResourceType = 'user' | 'club' | 'event' | 'link' | 'report' | 'other';

export interface AuditEntry {
  actorEmail: string;
  action: string;
  resourceType: AuditResourceType;
  resourceId?: string;
  details?: Record<string, unknown>;
  linkId?: string;
  ip?: string;
  reason?: string;
}

export interface AuditRecord {
  auditId: string;
  timestamp: string;
  actorEmail: string;
  action: string;
  resourceType: string;
  resourceId: string;
  details: string;
  linkId: string;
  ip: string;
  reason: string;
}

/**
 * Append one audit row. Best-effort: a Sheet/Firestore failure is logged and
 * swallowed so it never breaks the action being audited. The structured log line
 * always fires.
 */
export async function recordAudit(spreadsheetId: string, entry: AuditEntry): Promise<void> {
  const rec: AuditRecord = {
    auditId: randomUUID(),
    timestamp: new Date().toISOString(),
    actorEmail: entry.actorEmail,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? '',
    details: entry.details ? JSON.stringify(entry.details) : '',
    linkId: entry.linkId ?? '',
    ip: entry.ip ?? '',
    reason: entry.reason ?? '',
  };

  const row = new Array(WIDTH).fill('');
  row[COL.AUDIT_ID] = rec.auditId;
  row[COL.TIMESTAMP] = rec.timestamp;
  row[COL.ACTOR_EMAIL] = rec.actorEmail;
  row[COL.ACTION] = rec.action;
  row[COL.RESOURCE_TYPE] = rec.resourceType;
  row[COL.RESOURCE_ID] = rec.resourceId;
  row[COL.DETAILS] = rec.details;
  row[COL.LINK_ID] = rec.linkId;
  row[COL.IP_ADDRESS] = rec.ip;
  row[COL.REASON] = rec.reason;

  if (spreadsheetId) {
    try {
      await appendSheetValues(spreadsheetId, `${TAB}!A1`, [row]);
    } catch (err) {
      logger.warn({ err, action: rec.action }, 'audit sheet append failed (non-fatal)');
    }
  }
  try {
    await firestore().collection('auditLog').doc(rec.auditId).set(rec);
  } catch (err) {
    logger.warn({ err, action: rec.action }, 'audit cache mirror failed (non-fatal)');
  }
  logger.info({ audit: true, ...rec }, `audit: ${rec.action}`);
}

export interface AuditFilter {
  /** ISO inclusive lower bound on timestamp. */
  since?: string;
  /** ISO inclusive upper bound on timestamp. */
  until?: string;
  actorEmail?: string;
  resourceType?: AuditResourceType;
  /** Substring match on the action string (case-insensitive). */
  action?: string;
  limit?: number;
}

function rowToRecord(cells: string[]): AuditRecord {
  return {
    auditId: cell(cells, COL.AUDIT_ID),
    timestamp: cell(cells, COL.TIMESTAMP),
    actorEmail: cell(cells, COL.ACTOR_EMAIL),
    action: cell(cells, COL.ACTION),
    resourceType: cell(cells, COL.RESOURCE_TYPE),
    resourceId: cell(cells, COL.RESOURCE_ID),
    details: cell(cells, COL.DETAILS),
    linkId: cell(cells, COL.LINK_ID),
    ip: cell(cells, COL.IP_ADDRESS),
    reason: cell(cells, COL.REASON),
  };
}

/** Read + filter the Audit_Log tab, newest first. */
export async function listAudit(spreadsheetId: string, filter: AuditFilter = {}): Promise<AuditRecord[]> {
  const rows = await readTab(spreadsheetId, TAB, LAST_COL, COL.AUDIT_ID, 'auditid');
  let recs = rows.map((r) => rowToRecord(r.cells));
  if (filter.since) recs = recs.filter((r) => r.timestamp >= filter.since!);
  if (filter.until) recs = recs.filter((r) => r.timestamp <= filter.until!);
  if (filter.actorEmail) {
    const a = filter.actorEmail.toLowerCase();
    recs = recs.filter((r) => r.actorEmail.toLowerCase() === a);
  }
  if (filter.resourceType) recs = recs.filter((r) => r.resourceType === filter.resourceType);
  if (filter.action) {
    const sub = filter.action.toLowerCase();
    recs = recs.filter((r) => r.action.toLowerCase().includes(sub));
  }
  recs.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  if (filter.limit && filter.limit > 0) recs = recs.slice(0, filter.limit);
  return recs;
}
