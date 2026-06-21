/**
 * adminAudit.ts — tamper-evident audit trail for admin actions that touch other
 * users' Find Me data (selfie inspection + repro). Every privileged access is
 * recorded BOTH as a Firestore `admin_audit` doc (queryable history) and as a
 * structured log line (survives in Cloud Logging even if Firestore is wiped, and
 * can drive a monitoring alert).
 *
 * Writing the audit is best-effort and never blocks the action it describes —
 * but the log line always fires, so an access is never silent.
 */

import { firestore } from '../lib/firestore.js';
import { logger } from '../lib/logger.js';

export type AdminAuditAction =
  | 'findme_list'
  | 'findme_view_selfie'
  | 'findme_reproduce';

export interface AdminAuditEntry {
  adminUid: string;
  adminEmail: string | null;
  action: AdminAuditAction;
  /** The reference selfie acted on, when applicable. */
  uploadId?: string | null;
  /** The owning user of the data acted on, when applicable. */
  targetUid?: string | null;
  eventId?: string | null;
  /** Free-form extra context (filters used, outcome reproduced, counts…). */
  details?: Record<string, unknown>;
}

export async function recordAdminAudit(entry: AdminAuditEntry): Promise<void> {
  const createdAt = new Date().toISOString();
  const doc = {
    adminUid: entry.adminUid,
    adminEmail: entry.adminEmail,
    action: entry.action,
    uploadId: entry.uploadId ?? null,
    targetUid: entry.targetUid ?? null,
    eventId: entry.eventId ?? null,
    details: entry.details ?? {},
    createdAt,
  };
  try {
    await firestore().collection('admin_audit').add(doc);
  } catch (err) {
    logger.warn({ err, action: entry.action }, 'admin audit write failed (non-fatal)');
  }
  // Always emit the log line, even if the Firestore write failed.
  logger.info({ adminAudit: true, ...doc }, `admin action: ${entry.action}`);
}
