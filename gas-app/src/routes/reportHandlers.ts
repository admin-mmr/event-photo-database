/**
 * reportHandlers.ts — google.script.run handlers for summaries, audit log,
 * email preferences, and email time-driven triggers.
 *
 * Covers: serverGetSummary, serverExportSummaryCsv, serverSendExceptionEmail,
 *         serverGetAuditLog, serverGetMyEmailPrefs, serverUpdateMyEmailPrefs,
 *         installEmailTriggers, removeEmailTriggers,
 *         dailyReportTrigger, weeklyReportTrigger, retryFailedEmailsTrigger.
 */

import { ResultStatus } from '../types/enums';
import { ServerResponse, WithSession } from '../types/responses';
import { requireAdminOrFail } from '../middleware/authMiddleware';
import { generateSummary, summaryToCsv, buildExceptionEmailBody } from '../services/summaryService';
import { getAuditLogs, appendAuditLog } from '../services/auditLogService';
import { getPreferencesFor, savePreferences } from '../services/emailPreferenceService';
import {
  sendDailyReport as runDailyReport,
  sendWeeklyReport as runWeeklyReport,
  installEmailReportTriggers,
  uninstallEmailReportTriggers,
  installEmailRetryTrigger,
  uninstallEmailRetryTrigger,
  drainEmailRetryQueue,
} from '../services/emailService';
import { AuditAction } from '../types/enums';

/* global Logger, MailApp */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverGetSummary(payload: WithSession<{ dateFrom?: string; dateTo?: string }>): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const result = generateSummary(payload.dateFrom, payload.dateTo);
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverGetSummary error: ${String(err)}`);
    return { status: 'error', message: 'Internal error generating summary' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverExportSummaryCsv(payload: WithSession<{ dateFrom?: string; dateTo?: string }>): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const result = generateSummary(payload.dateFrom, payload.dateTo);
    if (!result.data) return { status: 'error', message: result.message };
    const csv = summaryToCsv(result.data);
    appendAuditLog({
      actorEmail: auth.adminEmail, action: AuditAction.EXPORT_CSV,
      resourceType: 'report', resourceId: '',
      details: { dateFrom: payload.dateFrom ?? null, dateTo: payload.dateTo ?? null },
    });
    return { status: 'success', message: 'CSV generated', data: { csv } };
  } catch (err) {
    Logger.log(`serverExportSummaryCsv error: ${String(err)}`);
    return { status: 'error', message: 'Internal error exporting CSV' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverSendExceptionEmail(payload: WithSession<{ additionalRecipients?: string[] }>): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const result = generateSummary();
    if (!result.data) return { status: 'error', message: result.message };
    const summary = result.data;
    const hasExceptions = summary.violations.length > 0 || summary.eventsWithoutUploads.length > 0;
    if (!hasExceptions) {
      return { status: 'success', message: 'No exceptions found — email not sent', data: { recipientCount: 0 } };
    }
    const body    = buildExceptionEmailBody(summary);
    const subject = `湘舍动公益文件系统 — Exception Alert (${new Date().toISOString().slice(0, 10)})`;
    const recipients      = [auth.adminEmail, ...(payload.additionalRecipients ?? [])];
    const uniqueRecipients = [...new Set(recipients.map((r) => r.toLowerCase().trim()))];
    for (const recipient of uniqueRecipients) MailApp.sendEmail(recipient, subject, body);
    Logger.log(`[serverSendExceptionEmail] Sent to ${uniqueRecipients.join(', ')}`);
    appendAuditLog({
      actorEmail: auth.adminEmail, action: AuditAction.EXCEPTION_EMAIL_SENT,
      resourceType: 'report', resourceId: '',
      details: { recipients: uniqueRecipients, violationCount: summary.violations.length },
    });
    return {
      status: 'success',
      message: `Exception email sent to ${uniqueRecipients.length} recipient(s)`,
      data: { recipientCount: uniqueRecipients.length },
    };
  } catch (err) {
    Logger.log(`serverSendExceptionEmail error: ${String(err)}`);
    return { status: 'error', message: `Failed to send exception email: ${String(err)}` };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverGetAuditLog(payload: WithSession<{
  page?:       number;
  pageSize?:   number;
  actorEmail?: string;
  dateFrom?:   string;
  dateTo?:     string;
}>): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const result = getAuditLogs({
      page:       payload.page    ?? 1,
      pageSize:   Math.min(payload.pageSize ?? 50, 200),
      actorEmail: payload.actorEmail,
      dateFrom:   payload.dateFrom,
      dateTo:     payload.dateTo,
    });
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverGetAuditLog error: ${String(err)}`);
    return { status: 'error', message: 'Internal error fetching audit log' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverGetMyEmailPrefs(payload: WithSession): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const prefs = getPreferencesFor(auth.adminEmail);
    return { status: 'success', message: 'OK', data: prefs };
  } catch (err) {
    Logger.log(`serverGetMyEmailPrefs error: ${String(err)}`);
    return { status: 'error', message: 'Internal error fetching email preferences' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverUpdateMyEmailPrefs(payload: WithSession<{
  userCreated?:     boolean;
  userRoleChanged?: boolean;
  userDeactivated?: boolean;
  securityEvent?:   boolean;
  eventCreated?:    boolean;
  dailyReport?:     boolean;
  weeklyReport?:    boolean;
}>): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const result = savePreferences({
      email:           auth.adminEmail,
      userCreated:     !!payload.userCreated,
      userRoleChanged: !!payload.userRoleChanged,
      userDeactivated: !!payload.userDeactivated,
      securityEvent:   !!payload.securityEvent,
      eventCreated:    !!payload.eventCreated,
      dailyReport:     !!payload.dailyReport,
      weeklyReport:    !!payload.weeklyReport,
    });
    if (result.status === ResultStatus.SUCCESS) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.EMAIL_PREFS_UPDATED,
        resourceType: 'email_preferences', resourceId: auth.adminEmail,
        details: {
          userCreated:     !!payload.userCreated,
          userRoleChanged: !!payload.userRoleChanged,
          userDeactivated: !!payload.userDeactivated,
          securityEvent:   !!payload.securityEvent,
          eventCreated:    !!payload.eventCreated,
          dailyReport:     !!payload.dailyReport,
          weeklyReport:    !!payload.weeklyReport,
        },
      });
    }
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverUpdateMyEmailPrefs error: ${String(err)}`);
    return { status: 'error', message: 'Internal error saving email preferences' };
  }
}

// ─── Email time-driven triggers ───────────────────────────────────────────────

/** Daily report time-driven trigger — invoked by GAS scheduler. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function dailyReportTrigger(): void {
  try {
    const result = runDailyReport();
    Logger.log(`[dailyReportTrigger] ${result.status}: ${result.message}`);
  } catch (err) {
    Logger.log(`[dailyReportTrigger] error: ${String(err)}`);
  }
}

/** Weekly digest time-driven trigger — invoked every Monday by GAS scheduler. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function weeklyReportTrigger(): void {
  try {
    const result = runWeeklyReport();
    Logger.log(`[weeklyReportTrigger] ${result.status}: ${result.message}`);
  } catch (err) {
    Logger.log(`[weeklyReportTrigger] error: ${String(err)}`);
  }
}

/** Hourly email retry drain — retries quota-failed notification sends. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function retryFailedEmailsTrigger(): void {
  try {
    drainEmailRetryQueue();
  } catch (err) {
    Logger.log(`[retryFailedEmailsTrigger] error: ${String(err)}`);
  }
}

/** Editor helper — installs daily, weekly, and retry email triggers. Idempotent. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function installEmailTriggers(): void {
  installEmailReportTriggers();
  installEmailRetryTrigger();
  Logger.log('[installEmailTriggers] report + retry triggers installed');
}

/** Editor helper — removes the scheduled report and retry triggers. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function removeEmailTriggers(): void {
  uninstallEmailReportTriggers();
  uninstallEmailRetryTrigger();
  Logger.log('[removeEmailTriggers] report + retry triggers removed');
}
