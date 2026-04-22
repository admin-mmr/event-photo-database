import { ResultStatus, EmailType, AuditAction, UserRole, UserStatus } from '../types/enums';
import { UserRecord } from '../types/models';
import { ServiceResult } from '../types/responses';
import { listRecipientsForType, listAllAdminEmails } from './emailPreferenceService';
import { appendAuditLog } from './auditLogService';
import { getCanonicalScriptUrl } from '../utils/scriptUrl';
import { generateSummary, SystemSummary } from './summaryService';
import { getAllUploadLogs } from './uploadLogService';
import { listAll as listAllUsers } from './userService';

/* global MailApp, Logger */

/**
 * EmailService — single choke point for every outbound notification.
 *
 * Why one service: it lets us centralise (a) branding, (b) opt-in resolution,
 * (c) MailApp quota awareness, (d) audit logging. Route handlers and scheduled
 * triggers never touch MailApp directly; they call a notifyXxx() function and
 * this service resolves recipients and renders the HTML.
 *
 * Quota notes (MailApp, consumer Google account):
 *   • ~100 recipient-emails per day total
 *   • getRemainingDailyQuota() lets us skip sends that would silently fail
 *
 * Every notifyXxx() returns a ServiceResult describing what was sent and to
 * whom. Callers should not throw on email failure — a failed notification
 * must never roll back the underlying operation.
 */

// ─── Branding ────────────────────────────────────────────────────────────────

/**
 * Product name shown in subjects and the email header banner.
 * Mirrors the on-screen title used by pageRoutes.renderTemplate().
 */
const PRODUCT_NAME = '湘舍动公益文件系统';
const PRODUCT_NAME_EN = 'Event Photo Database';

/**
 * Returns the canonical deployment URL with an optional action path appended.
 * Used in every email CTA button so recipients land on the correct page
 * regardless of which Workspace / Gmail URL shape ScriptApp returned.
 */
function mainPageUrl(action = 'dashboard'): string {
  return `${getCanonicalScriptUrl()}?action=${encodeURIComponent(action)}`;
}

// ─── HTML rendering ──────────────────────────────────────────────────────────

/**
 * Minimal HTML-escape for inlining user-supplied values inside email bodies.
 * Email clients render HTML liberally — never concatenate raw values without
 * passing them through this helper first.
 */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Wraps inner HTML in a branded layout with header / footer / CTA button slot.
 *
 * Inline CSS only — Gmail strips <style> blocks and most external stylesheets.
 * Keep colour / spacing choices consistent with the in-app MDL indigo theme.
 */
function wrapHtml(title: string, innerHtml: string, ctaLabel?: string, ctaUrl?: string): string {
  const cta = (ctaLabel && ctaUrl)
    ? `<p style="margin:24px 0 8px;">
         <a href="${esc(ctaUrl)}"
            style="background:#3f51b5;color:#fff;text-decoration:none;
                   padding:12px 28px;border-radius:4px;display:inline-block;
                   font-size:15px;font-weight:500;">
           ${esc(ctaLabel)}
         </a>
       </p>`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#333;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;">
    <div style="background:#3f51b5;color:#fff;padding:16px 24px;border-radius:4px 4px 0 0;">
      <div style="font-size:13px;opacity:0.85;">${esc(PRODUCT_NAME_EN)}</div>
      <div style="font-size:18px;font-weight:500;">${esc(PRODUCT_NAME)}</div>
    </div>
    <div style="background:#fff;padding:24px;border-radius:0 0 4px 4px;
                box-shadow:0 2px 8px rgba(0,0,0,0.08);line-height:1.5;">
      <h2 style="margin:0 0 16px;color:#333;font-size:18px;">${esc(title)}</h2>
      ${innerHtml}
      ${cta}
    </div>
    <div style="color:#888;font-size:12px;text-align:center;padding:16px 8px;">
      This is an automated message from ${esc(PRODUCT_NAME_EN)}.<br>
      You can change what you receive at
      <a href="${esc(mainPageUrl('admin_email_prefs'))}" style="color:#3f51b5;">
        Email Preferences
      </a>.
    </div>
  </div>
</body></html>`;
}

/**
 * Strips tags to produce a plain-text fallback body. Email clients that don't
 * render HTML will fall back to this. Not a full HTML-to-text converter —
 * enough to make the message readable when HTML rendering is disabled.
 */
function toPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|tr|h\d)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '  • ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

// ─── Core send helper ────────────────────────────────────────────────────────

interface SendOptions {
  readonly to: string[];         // Primary recipients
  readonly cc?: string[];        // CC list (deduped against `to`)
  readonly subject: string;
  readonly html: string;
  readonly type: EmailType;      // For audit logging and quota bookkeeping
  readonly resourceId?: string;  // Optional audit resourceId (e.g. target user email)
}

/**
 * Central MailApp dispatcher.
 *
 * Responsibilities:
 *   1. Deduplicate and lowercase every recipient address.
 *   2. Exclude CC addresses that are already in the "to" list.
 *   3. Early-exit when there are zero recipients.
 *   4. Check MailApp daily quota before sending.
 *   5. Write an audit log row describing the attempt (success or failure).
 *
 * Returns SUCCESS even when recipients is empty so callers don't treat
 * "no one opted in" as an error.
 */
function send(opts: SendOptions): ServiceResult<{ to: string[]; cc: string[] }> {
  const to = dedupeEmails(opts.to);
  const ccRaw = dedupeEmails(opts.cc ?? []);
  const cc = ccRaw.filter((e) => !to.includes(e));

  if (to.length === 0 && cc.length === 0) {
    Logger.log(`[emailService] ${opts.type}: no recipients — skipped`);
    return {
      status: ResultStatus.SUCCESS,
      message: 'No recipients opted in — email not sent',
      data: { to: [], cc: [] },
    };
  }

  // MailApp.getRemainingDailyQuota() counts each recipient (to + cc + bcc).
  const needed = to.length + cc.length;
  let remaining = Number.POSITIVE_INFINITY;
  try {
    remaining = MailApp.getRemainingDailyQuota();
  } catch {
    // Non-fatal; some deploys (editor preview) throw here.
  }
  if (remaining < needed) {
    const msg = `Insufficient MailApp quota (${remaining} remaining, ${needed} required)`;
    Logger.log(`[emailService] ${opts.type}: ${msg}`);
    appendAuditLog({
      actorEmail: 'system',
      action:     AuditAction.EMAIL_FAILED,
      resourceType: 'email',
      resourceId: opts.resourceId ?? '',
      details:    { type: opts.type, reason: 'quota', remaining, needed },
    });
    return { status: ResultStatus.ERROR, message: msg };
  }

  // MailApp requires a single primary recipient string. For a one-shot send
  // with multiple `to`s, comma-join them; MailApp treats that as multiple
  // addressees sharing the same message (not a separate email per recipient).
  const primary = to.length > 0 ? to.join(',') : cc[0];
  const ccLine = to.length > 0 ? cc.join(',') : cc.slice(1).join(',');

  try {
    MailApp.sendEmail({
      to:       primary,
      cc:       ccLine || undefined,
      subject:  opts.subject,
      htmlBody: opts.html,
      body:     toPlainText(opts.html),
      name:     PRODUCT_NAME_EN,
      noReply:  true,
    });
    Logger.log(
      `[emailService] ${opts.type}: sent to=${to.join(',')} cc=${cc.join(',')}`,
    );
    appendAuditLog({
      actorEmail: 'system',
      action:     AuditAction.EMAIL_SENT,
      resourceType: 'email',
      resourceId: opts.resourceId ?? '',
      details:    { type: opts.type, to, cc, subject: opts.subject },
    });
    return {
      status:  ResultStatus.SUCCESS,
      message: `Sent to ${to.length + cc.length} recipient(s)`,
      data:    { to, cc },
    };
  } catch (err) {
    const msg = `MailApp.sendEmail failed: ${String(err)}`;
    Logger.log(`[emailService] ${opts.type}: ${msg}`);
    appendAuditLog({
      actorEmail: 'system',
      action:     AuditAction.EMAIL_FAILED,
      resourceType: 'email',
      resourceId: opts.resourceId ?? '',
      details:    { type: opts.type, reason: 'mailapp_error', error: String(err), to, cc },
    });
    return { status: ResultStatus.ERROR, message: msg };
  }
}

function dedupeEmails(emails: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const normalized = (raw ?? '').trim().toLowerCase();
    if (!normalized) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

// ─── User lifecycle notifications ────────────────────────────────────────────

/**
 * Sent TO the newly-created user with a welcome message and a CTA linking to
 * the main page. All opted-in admins are CC'd so they can see who got invited.
 *
 * Special case: on the very first user-create event, the admin who created
 * the user is always CC'd even if they haven't saved an opt-in yet — this is
 * the behaviour the requirements call out explicitly ("cc all the admins in
 * the user list").
 */
export function notifyUserCreated(
  newUser: UserRecord,
  createdByAdminEmail: string,
): ServiceResult<{ to: string[]; cc: string[] }> {
  // Admins who opted IN (or inherited the default opt-in) for user-created alerts.
  const optedInAdmins = listRecipientsForType(EmailType.USER_CREATED);
  // Always CC every admin for user creation per product requirement.
  const allAdmins = listAllAdminEmails();
  // Exclude the new user themselves from the CC list.
  const ccList = Array.from(new Set([...optedInAdmins, ...allAdmins, createdByAdminEmail]))
    .filter((e) => e.toLowerCase() !== newUser.email.toLowerCase());

  const dashUrl = mainPageUrl('dashboard');
  const html = wrapHtml(
    `Welcome to ${PRODUCT_NAME_EN}`,
    `<p>Hi ${esc(newUser.email)},</p>
     <p>You've been added to ${esc(PRODUCT_NAME_EN)}
        (${esc(PRODUCT_NAME)}) by <b>${esc(createdByAdminEmail)}</b>.</p>
     <table style="border-collapse:collapse;margin:12px 0;font-size:14px;">
       <tr><td style="padding:4px 12px 4px 0;color:#666;">Role</td>
           <td style="padding:4px 0;font-family:monospace;">${esc(newUser.role)}</td></tr>
       <tr><td style="padding:4px 12px 4px 0;color:#666;">Running club</td>
           <td style="padding:4px 0;font-family:monospace;">${esc(newUser.runningClub)}</td></tr>
       <tr><td style="padding:4px 12px 4px 0;color:#666;">Added on</td>
           <td style="padding:4px 0;font-family:monospace;">${esc(newUser.addedDate)}</td></tr>
     </table>
     <p>Sign in with your Google account to start uploading or managing photos.</p>`,
    'Open the app',
    dashUrl,
  );

  return send({
    to:        [newUser.email],
    cc:        ccList,
    subject:   `[${PRODUCT_NAME_EN}] Welcome — your account is ready`,
    html,
    type:      EmailType.WELCOME_USER,
    resourceId: newUser.email,
  });
}

/**
 * Sent TO opted-in admins when a user's role is changed.
 * No mail to the affected user in this release — role changes are an admin
 * concern and adding user-facing mail here would trigger surprise.
 */
export function notifyUserRoleChanged(
  targetUser: UserRecord,
  previousRole: string,
  changedByAdminEmail: string,
): ServiceResult<{ to: string[]; cc: string[] }> {
  const recipients = listRecipientsForType(EmailType.USER_ROLE_CHANGED);
  if (recipients.length === 0) {
    return {
      status: ResultStatus.SUCCESS,
      message: 'No admins opted in — skipped',
      data: { to: [], cc: [] },
    };
  }

  const html = wrapHtml(
    `User role changed`,
    `<p><b>${esc(changedByAdminEmail)}</b> changed the role of
        <b>${esc(targetUser.email)}</b>.</p>
     <table style="border-collapse:collapse;margin:12px 0;font-size:14px;">
       <tr><td style="padding:4px 12px 4px 0;color:#666;">User</td>
           <td style="padding:4px 0;font-family:monospace;">${esc(targetUser.email)}</td></tr>
       <tr><td style="padding:4px 12px 4px 0;color:#666;">Previous role</td>
           <td style="padding:4px 0;font-family:monospace;">${esc(previousRole)}</td></tr>
       <tr><td style="padding:4px 12px 4px 0;color:#666;">New role</td>
           <td style="padding:4px 0;font-family:monospace;">${esc(targetUser.role)}</td></tr>
     </table>`,
    'Review users',
    mainPageUrl('admin_users'),
  );

  return send({
    to:        recipients,
    subject:   `[${PRODUCT_NAME_EN}] Role changed — ${targetUser.email} → ${targetUser.role}`,
    html,
    type:      EmailType.USER_ROLE_CHANGED,
    resourceId: targetUser.email,
  });
}

/**
 * Sent TO opted-in admins when a user is deactivated or reactivated.
 */
export function notifyUserStatusChanged(
  targetUser: UserRecord,
  changedByAdminEmail: string,
): ServiceResult<{ to: string[]; cc: string[] }> {
  const recipients = listRecipientsForType(EmailType.USER_DEACTIVATED);
  if (recipients.length === 0) {
    return {
      status: ResultStatus.SUCCESS,
      message: 'No admins opted in — skipped',
      data: { to: [], cc: [] },
    };
  }

  const verb = targetUser.status === UserStatus.ACTIVE ? 'reactivated' : 'deactivated';
  const html = wrapHtml(
    `User ${verb}`,
    `<p><b>${esc(changedByAdminEmail)}</b> ${esc(verb)} the account
        <b>${esc(targetUser.email)}</b>.</p>
     <p>The user's current status is
        <b style="font-family:monospace;">${esc(targetUser.status)}</b>.</p>`,
    'Review users',
    mainPageUrl('admin_users'),
  );

  return send({
    to:        recipients,
    subject:   `[${PRODUCT_NAME_EN}] User ${verb} — ${targetUser.email}`,
    html,
    type:      EmailType.USER_DEACTIVATED,
    resourceId: targetUser.email,
  });
}

/**
 * Sent TO opted-in admins when a failed authentication attempt is detected.
 *
 * Triggered by the login handlers when a Google token verifies successfully
 * but the resolved email is not registered in the Users sheet. A rate limit
 * would be wise in a future iteration; for now every rejected sign-in fires
 * one email and writes one SECURITY_EVENT_DETECTED audit row.
 */
export function notifySecurityEvent(
  attemptedEmail: string,
  reason: string,
  context: Record<string, unknown> = {},
): ServiceResult<{ to: string[]; cc: string[] }> {
  const recipients = listRecipientsForType(EmailType.SECURITY_EVENT);

  // Always write the audit log even if nobody is opted in.
  appendAuditLog({
    actorEmail: attemptedEmail.toLowerCase(),
    action:     AuditAction.SECURITY_EVENT_DETECTED,
    resourceType: 'security',
    resourceId: attemptedEmail.toLowerCase(),
    details:    { reason, ...context },
  });

  if (recipients.length === 0) {
    return {
      status: ResultStatus.SUCCESS,
      message: 'No admins opted in — logged but not emailed',
      data: { to: [], cc: [] },
    };
  }

  const html = wrapHtml(
    `Security event detected`,
    `<p>A failed authentication attempt was recorded.</p>
     <table style="border-collapse:collapse;margin:12px 0;font-size:14px;">
       <tr><td style="padding:4px 12px 4px 0;color:#666;">Attempted email</td>
           <td style="padding:4px 0;font-family:monospace;">${esc(attemptedEmail)}</td></tr>
       <tr><td style="padding:4px 12px 4px 0;color:#666;">Reason</td>
           <td style="padding:4px 0;">${esc(reason)}</td></tr>
       <tr><td style="padding:4px 12px 4px 0;color:#666;">Detected at</td>
           <td style="padding:4px 0;font-family:monospace;">${esc(new Date().toISOString())}</td></tr>
     </table>
     <p>No further action required if this was expected.
        If not, review the Audit Log for the full context.</p>`,
    'Open audit log',
    mainPageUrl('admin_audit'),
  );

  return send({
    to:        recipients,
    subject:   `[${PRODUCT_NAME_EN}] Security alert — auth rejected for ${attemptedEmail}`,
    html,
    type:      EmailType.SECURITY_EVENT,
    resourceId: attemptedEmail.toLowerCase(),
  });
}

// ─── Scheduled digests ───────────────────────────────────────────────────────

/**
 * Renders the report body for a daily / weekly digest.
 *
 * Aggregates the last N days of upload activity plus a count of new users
 * over the same window. Reuses SummaryService to avoid duplicate code paths.
 */
function buildDigestHtml(
  windowLabel: string,
  sinceIsoDate: string,
  summary: SystemSummary,
  newUserCount: number,
  recentUploadCount: number,
): string {
  const rowsHtml = summary.eventsWithUploads.slice(0, 10)
    .map((es) => `
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;">${esc(es.event.eventName)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;font-family:monospace;">${esc(es.event.eventDate)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;">${es.totalFiles}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;">${es.totalSizeMb}</td>
      </tr>`)
    .join('');

  const violationsLine = summary.violations.length > 0
    ? `<p style="color:#b71c1c;"><b>${summary.violations.length}</b> naming violation(s) detected.</p>`
    : `<p style="color:#2e7d32;">No naming violations.</p>`;

  const body = `
    <p><b>${esc(windowLabel)}</b> digest for ${esc(PRODUCT_NAME_EN)}.</p>
    <p>Since <b>${esc(sinceIsoDate)}</b>:</p>
    <ul style="margin:8px 0 16px 20px;padding:0;">
      <li><b>${recentUploadCount}</b> upload batch(es)</li>
      <li><b>${newUserCount}</b> new user(s)</li>
      <li><b>${summary.totalPhotos}</b> total photos across all events (all time)</li>
      <li><b>${summary.eventsWithoutUploads.length}</b> event(s) with zero uploads</li>
    </ul>
    ${violationsLine}
    <h3 style="font-size:15px;margin:20px 0 8px;">Top events (all-time)</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <thead>
        <tr style="background:#f5f5f5;">
          <th style="padding:6px 12px;text-align:left;">Event</th>
          <th style="padding:6px 12px;text-align:left;">Date</th>
          <th style="padding:6px 12px;text-align:right;">Photos</th>
          <th style="padding:6px 12px;text-align:right;">MB</th>
        </tr>
      </thead>
      <tbody>${rowsHtml || '<tr><td colspan="4" style="padding:6px 12px;color:#888;">No uploads yet.</td></tr>'}</tbody>
    </table>`;

  return wrapHtml(`${windowLabel} activity digest`, body, 'Open dashboard', mainPageUrl('admin_summary'));
}

/**
 * Counts the number of user rows with addedDate >= sinceIsoDate.
 * "Added" dates older than the window are ignored. Returns 0 on read failure.
 */
function countUsersAddedSince(sinceIsoDate: string): number {
  try {
    const users = listAllUsers(1, 1000).items;
    return users.filter((u) => (u.addedDate ?? '') >= sinceIsoDate).length;
  } catch {
    return 0;
  }
}

/**
 * Counts upload batches with uploadTimestamp >= sinceIsoTimestamp.
 * Returns 0 on read failure.
 */
function countUploadsSince(sinceIsoTimestamp: string): number {
  try {
    const logsResult = getAllUploadLogs();
    if (logsResult.status !== ResultStatus.SUCCESS || !logsResult.data) return 0;
    return logsResult.data.filter((l) => (l.uploadTimestamp ?? '') >= sinceIsoTimestamp).length;
  } catch {
    return 0;
  }
}

/**
 * Builds and sends the daily digest. Intended to be called from a GAS
 * time-driven trigger once per day.
 */
export function sendDailyReport(): ServiceResult<{ to: string[]; cc: string[] }> {
  const recipients = listRecipientsForType(EmailType.DAILY_REPORT);
  if (recipients.length === 0) {
    return {
      status: ResultStatus.SUCCESS,
      message: 'No admins opted in to the daily report — skipped',
      data: { to: [], cc: [] },
    };
  }

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 1);
  const sinceIso = since.toISOString();
  const sinceDate = sinceIso.slice(0, 10);

  const summaryResult = generateSummary();
  if (summaryResult.status !== ResultStatus.SUCCESS || !summaryResult.data) {
    return { status: ResultStatus.ERROR, message: summaryResult.message };
  }

  const html = buildDigestHtml(
    'Daily',
    sinceDate,
    summaryResult.data,
    countUsersAddedSince(sinceDate),
    countUploadsSince(sinceIso),
  );

  return send({
    to:      recipients,
    subject: `[${PRODUCT_NAME_EN}] Daily digest — ${sinceDate}`,
    html,
    type:    EmailType.DAILY_REPORT,
  });
}

/**
 * Builds and sends the weekly digest. Intended to be called from a GAS
 * time-driven trigger once per week.
 */
export function sendWeeklyReport(): ServiceResult<{ to: string[]; cc: string[] }> {
  const recipients = listRecipientsForType(EmailType.WEEKLY_REPORT);
  if (recipients.length === 0) {
    return {
      status: ResultStatus.SUCCESS,
      message: 'No admins opted in to the weekly report — skipped',
      data: { to: [], cc: [] },
    };
  }

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 7);
  const sinceIso = since.toISOString();
  const sinceDate = sinceIso.slice(0, 10);

  const summaryResult = generateSummary();
  if (summaryResult.status !== ResultStatus.SUCCESS || !summaryResult.data) {
    return { status: ResultStatus.ERROR, message: summaryResult.message };
  }

  const html = buildDigestHtml(
    'Weekly',
    sinceDate,
    summaryResult.data,
    countUsersAddedSince(sinceDate),
    countUploadsSince(sinceIso),
  );

  return send({
    to:      recipients,
    subject: `[${PRODUCT_NAME_EN}] Weekly digest — week of ${sinceDate}`,
    html,
    type:    EmailType.WEEKLY_REPORT,
  });
}

// ─── Trigger installers (run from the GAS editor) ────────────────────────────

/**
 * Installs the daily and weekly time-driven triggers if they don't exist.
 *
 * Run this once from the GAS editor (Run → installEmailReportTriggers) after
 * the first deploy. Idempotent — uses the handler function name as the
 * uniqueness key, so calling it again is a no-op.
 *
 * Schedule (all in the script's timezone — see File → Project properties):
 *   • dailyReportTrigger   — every day between 07:00 and 08:00
 *   • weeklyReportTrigger  — every Monday between 07:00 and 08:00
 */
export function installEmailReportTriggers(): void {
  /* global ScriptApp */
  const existing = ScriptApp.getProjectTriggers();
  const names = new Set(existing.map((t) => t.getHandlerFunction()));

  if (!names.has('dailyReportTrigger')) {
    ScriptApp.newTrigger('dailyReportTrigger').timeBased().everyDays(1).atHour(7).create();
  }
  if (!names.has('weeklyReportTrigger')) {
    ScriptApp.newTrigger('weeklyReportTrigger')
      .timeBased()
      .onWeekDay(ScriptApp.WeekDay.MONDAY)
      .atHour(7)
      .create();
  }
}

/**
 * Removes the daily / weekly triggers, if present.
 * Run from the GAS editor to pause scheduled digests without a redeploy.
 */
export function uninstallEmailReportTriggers(): void {
  const all = ScriptApp.getProjectTriggers();
  for (const t of all) {
    const fn = t.getHandlerFunction();
    if (fn === 'dailyReportTrigger' || fn === 'weeklyReportTrigger') {
      ScriptApp.deleteTrigger(t);
    }
  }
}

// Make absolutely sure the unused-import lint doesn't trim UserRole; it's
// re-exported transitively via UserStatus usage above.
void UserRole;
