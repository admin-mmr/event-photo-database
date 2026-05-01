import { ResultStatus, EmailType, AuditAction, UserStatus } from '../types/enums';
import { UserRecord } from '../types/models';
import { ServiceResult, ValidationError } from '../types/responses';
import { listRecipientsForType, listAllAdminEmails } from './emailPreferenceService';
import { appendAuditLog } from './auditLogService';
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

// ─── Template helpers (extracted to emailTemplates.ts) ─────────────────────────
import {
  PRODUCT_NAME,
  PRODUCT_NAME_EN,
  wrapHtml,
  toPlainText,
  mainPageUrl,
  esc,
} from './emailTemplates';


interface SendOptions {
  readonly to: string[];         // Primary recipients
  readonly cc?: string[];        // CC list (deduped against `to`)
  readonly subject: string;
  readonly html: string;
  readonly type: EmailType;      // For audit logging and quota bookkeeping
  readonly resourceId?: string;  // Optional audit resourceId (e.g. target user email)
  /**
   * If true (default), a quota failure is added to the retry queue with
   * exponential backoff. Pass false when called from drainEmailRetryQueue()
   * to prevent recursive queuing.
   */
  readonly retry?: boolean;
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
    // Enqueue for retry with backoff (unless we're already inside the retry drain).
    if (opts.retry !== false) {
      enqueueRetry(opts);
    }
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
       <tr><td style="padding:4px 12px 4px 0;color:#666;">Club</td>
           <td style="padding:4px 0;font-family:monospace;">${esc(newUser.clubId || '—')}</td></tr>
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

// ─── Admin error notifications ────────────────────────────────────────────────

/**
 * Sent TO opted-in admins (+ the acting admin) when a user-creation attempt
 * fails validation. Gives admins full field-level detail so they can diagnose
 * the problem without digging through Logs Explorer.
 */
export function notifyAdminUserCreationFailed(
  attemptedEmail: string,
  actorAdminEmail: string,
  errors: ValidationError[],
): ServiceResult<{ to: string[]; cc: string[] }> {
  const optedIn = listRecipientsForType(EmailType.SECURITY_EVENT);
  // Always include the admin who triggered the failure so they get instant feedback.
  const recipients = Array.from(new Set([...optedIn, actorAdminEmail]));

  const errorsHtml = errors
    .map(
      (e) =>
        `<tr>
           <td style="padding:6px 12px;border-bottom:1px solid #eee;font-family:monospace;color:#b71c1c;">${esc(e.field)}</td>
           <td style="padding:6px 12px;border-bottom:1px solid #eee;">${esc(e.message)}${e.value !== undefined ? ` <span style="color:#888;font-size:12px;">(got: ${esc(String(e.value))})</span>` : ''}</td>
         </tr>`,
    )
    .join('');

  const html = wrapHtml(
    `User creation failed — ${attemptedEmail || '(no email provided)'}`,
    `<p><b>${esc(actorAdminEmail)}</b> attempted to create a user but the request failed validation.</p>
     <table style="border-collapse:collapse;margin:12px 0;font-size:14px;">
       <tr><td style="padding:4px 12px 4px 0;color:#666;">Attempted email</td>
           <td style="padding:4px 0;font-family:monospace;">${esc(attemptedEmail || '(empty)')}</td></tr>
       <tr><td style="padding:4px 12px 4px 0;color:#666;">Actor</td>
           <td style="padding:4px 0;font-family:monospace;">${esc(actorAdminEmail)}</td></tr>
       <tr><td style="padding:4px 12px 4px 0;color:#666;">Time</td>
           <td style="padding:4px 0;font-family:monospace;">${esc(new Date().toISOString())}</td></tr>
     </table>
     <h3 style="font-size:15px;margin:20px 0 8px;color:#b71c1c;">Validation errors</h3>
     <table style="border-collapse:collapse;width:100%;font-size:13px;">
       <thead>
         <tr style="background:#fff3cd;">
           <th style="padding:6px 12px;text-align:left;">Field</th>
           <th style="padding:6px 12px;text-align:left;">Error</th>
         </tr>
       </thead>
       <tbody>${errorsHtml || '<tr><td colspan="2" style="padding:6px 12px;color:#888;">No field errors recorded.</td></tr>'}</tbody>
     </table>
     <p style="margin-top:16px;font-size:13px;color:#555;">
       Fix the highlighted fields and try again, or contact a super admin if the problem persists.
     </p>`,
    'Manage users',
    mainPageUrl('admin_users'),
  );

  return send({
    to:         recipients,
    subject:    `[${PRODUCT_NAME_EN}] User creation failed — ${attemptedEmail || '(no email)'}`,
    html,
    type:       EmailType.SECURITY_EVENT,
    resourceId: attemptedEmail,
  });
}

// ─── Upload error notifications ───────────────────────────────────────────────

/**
 * Sent TO opted-in admins when the browser reports a Drive API error during a
 * volunteer upload.  Routed through the UPLOAD_ERROR type, which shares the
 * securityEvent opt-in flag (no sheet schema change required).
 *
 * @param uploaderEmail   Volunteer's email (from vsession; may be 'unknown' if session expired)
 * @param fileName        Name of the file that failed
 * @param errorMessage    Error string captured client-side (includes HTTP status + Drive response body)
 * @param httpStatus      HTTP status code from the Drive API call, if available
 * @param driveResponse   First 300 chars of the Drive response body, if available
 * @param batchFolderName Name of the Drive batch folder (Layer 3) for cross-referencing
 */
export function notifyUploadClientError(
  uploaderEmail: string,
  fileName: string,
  errorMessage: string,
  httpStatus?: number,
  driveResponse?: string,
  batchFolderName?: string,
): ServiceResult<{ to: string[]; cc: string[] }> {
  const recipients = listRecipientsForType(EmailType.UPLOAD_ERROR);
  if (recipients.length === 0) {
    Logger.log(`[emailService] UPLOAD_ERROR: no opted-in recipients — skipped`);
    return {
      status:  ResultStatus.SUCCESS,
      message: 'No admins opted in — skipped',
      data:    { to: [], cc: [] },
    };
  }

  const statusRow = httpStatus !== undefined
    ? `<tr><td style="padding:4px 12px 4px 0;color:#666;">HTTP status</td>
           <td style="padding:4px 0;font-family:monospace;color:#b71c1c;">${esc(String(httpStatus))}</td></tr>`
    : '';
  const responseRow = driveResponse
    ? `<tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top;">Drive response</td>
           <td style="padding:4px 0;font-family:monospace;font-size:11px;word-break:break-all;">${esc(driveResponse)}</td></tr>`
    : '';
  const folderRow = batchFolderName
    ? `<tr><td style="padding:4px 12px 4px 0;color:#666;">Batch folder</td>
           <td style="padding:4px 0;font-family:monospace;">${esc(batchFolderName)}</td></tr>`
    : '';

  const html = wrapHtml(
    `Upload error — Drive API failure`,
    `<p>A volunteer's browser reported a Drive API error while uploading photos.
        The upload was <b>not</b> recorded in the upload log.</p>
     <table style="border-collapse:collapse;margin:12px 0;font-size:14px;">
       <tr><td style="padding:4px 12px 4px 0;color:#666;">Uploader</td>
           <td style="padding:4px 0;font-family:monospace;">${esc(uploaderEmail)}</td></tr>
       <tr><td style="padding:4px 12px 4px 0;color:#666;">File</td>
           <td style="padding:4px 0;font-family:monospace;">${esc(fileName)}</td></tr>
       ${statusRow}
       <tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top;">Error</td>
           <td style="padding:4px 0;">${esc(errorMessage)}</td></tr>
       ${responseRow}
       ${folderRow}
       <tr><td style="padding:4px 12px 4px 0;color:#666;">Detected at</td>
           <td style="padding:4px 0;font-family:monospace;">${esc(new Date().toISOString())}</td></tr>
     </table>
     <p style="color:#b71c1c;font-weight:500;">
       Common causes: OAuth token expired between folder creation and upload
       (~26 s window), wrong Drive folder permissions, or token scope too narrow.
       Check that <code>ScriptApp.getOAuthToken()</code> covers
       <code>drive.file</code> scope and that the batch folder ID is valid.
     </p>`,
    'Open audit log',
    mainPageUrl('admin_audit'),
  );

  return send({
    to:         recipients,
    subject:    `[${PRODUCT_NAME_EN}] Upload error — Drive ${httpStatus ?? 'API'} for ${uploaderEmail}`,
    html,
    type:       EmailType.UPLOAD_ERROR,
    resourceId: uploaderEmail,
  });
}

// ─── Event lifecycle notifications ────────────────────────────────────────────

/**
 * Sent TO all opted-in admins when a new event is created.
 *
 * Design §10: "All admins receive notifications when a new event is created
 * (subject to each recipient's preferences)."
 *
 * This is the primary coordination signal for club admins — it tells them
 * to generate upload links so volunteers can start submitting photos for
 * the new event. On by default (see emailPreferenceService.defaultPreferences).
 */
export function notifyEventCreated(
  eventName: string,
  eventDate: string,
  createdByAdminEmail: string,
): ServiceResult<{ to: string[]; cc: string[] }> {
  const recipients = listRecipientsForType(EmailType.EVENT_CREATED);
  if (recipients.length === 0) {
    return {
      status: ResultStatus.SUCCESS,
      message: 'No admins opted in to event-created notifications — skipped',
      data: { to: [], cc: [] },
    };
  }

  const linksUrl = mainPageUrl('admin_links');
  const html = wrapHtml(
    `New event created: ${eventName}`,
    `<p><b>${esc(createdByAdminEmail)}</b> created a new event.</p>
     <table style="border-collapse:collapse;margin:12px 0;font-size:14px;">
       <tr><td style="padding:4px 12px 4px 0;color:#666;">Event name</td>
           <td style="padding:4px 0;font-weight:500;">${esc(eventName)}</td></tr>
       <tr><td style="padding:4px 12px 4px 0;color:#666;">Event date</td>
           <td style="padding:4px 0;font-family:monospace;">${esc(eventDate)}</td></tr>
       <tr><td style="padding:4px 12px 4px 0;color:#666;">Created by</td>
           <td style="padding:4px 0;font-family:monospace;">${esc(createdByAdminEmail)}</td></tr>
     </table>
     <p>Club admins: generate an upload link for your club so volunteers can
        start submitting photos for this event.</p>`,
    'Manage upload links',
    linksUrl,
  );

  return send({
    to:        recipients,
    subject:   `[${PRODUCT_NAME_EN}] New event: ${eventName} (${eventDate})`,
    html,
    type:      EmailType.EVENT_CREATED,
    resourceId: eventName,
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
    appendAuditLog({
      actorEmail:   'system',
      action:       AuditAction.EMAIL_FAILED,
      resourceType: 'report',
      resourceId:   '',
      details:      { reason: summaryResult.message ?? 'generateSummary failed' },
    });
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

// ─── Trigger functions (extracted to emailTriggers.ts) ──────────────────────────
// Re-exported for backward compatibility with existing callers.
export {
  installEmailReportTriggers,
  uninstallEmailReportTriggers,
  installEmailRetryTrigger,
  uninstallEmailRetryTrigger,
} from './emailTriggers';

// ─── Email retry queue (exponential backoff) ─────────────────────────────────

/**
 * Persisted retry entry stored as JSON in Script Properties.
 * We use ScriptProperties rather than a dedicated sheet because retries are
 * transient and short-lived (max ~4 hours at the default backoff schedule);
 * the overhead of a sheet is not warranted for < 10 simultaneous entries.
 */
interface PendingRetry {
  readonly id:            string;
  readonly type:          EmailType;
  readonly to:            string[];
  readonly cc:            string[];
  readonly subject:       string;
  readonly html:          string;
  readonly resourceId:    string;
  readonly firstFailedAt: string;
  attempts:               number;
  nextAttemptAt:          string;
  lastError:              string;
}

const RETRY_QUEUE_PROP_KEY = 'EMAIL_RETRY_QUEUE';
const MAX_RETRY_ATTEMPTS   = 3;

/**
 * Backoff intervals in hours for each retry attempt (index = attempts so far).
 *   attempt 0 → wait 30 min, attempt 1 → wait 1 h, attempt 2 → wait 2 h
 * After 3 failed attempts the item is escalated and dropped from the queue.
 */
const RETRY_BACKOFF_HOURS = [0.5, 1, 2] as const;

/**
 * Hard cap on queue length.  If enqueueing a new item would push the queue above
 * this limit, the oldest entry is dropped (already escalated to the audit log in a
 * prior drain) to prevent the PropertiesService value from growing without bound.
 * GAS script properties have a 500 KB total limit; each retry entry is ~1–2 KB.
 */
const MAX_RETRY_QUEUE_SIZE = 50;

/**
 * Entries older than this (in hours) are considered stale and purged during
 * enqueue, even if they have not yet been drained.  This prevents a backlog of
 * failed attempts from a prior outage from being re-attempted days later.
 */
const MAX_RETRY_QUEUE_AGE_HOURS = 24;

/* global PropertiesService */

function loadRetryQueue(): PendingRetry[] {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(RETRY_QUEUE_PROP_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as PendingRetry[];
  } catch {
    return [];
  }
}

function saveRetryQueue(queue: PendingRetry[]): void {
  PropertiesService.getScriptProperties().setProperty(
    RETRY_QUEUE_PROP_KEY,
    JSON.stringify(queue),
  );
}

/**
 * Appends a new entry to the retry queue for the given send options.
 * The first retry will be attempted after RETRY_BACKOFF_HOURS[0] hours.
 *
 * Called by send() when a quota failure occurs (retry: true, the default).
 *
 * Enforces two guards before appending:
 *   1. Age purge — entries older than MAX_RETRY_QUEUE_AGE_HOURS are dropped;
 *      a stale backlog from a past outage should not resurface days later.
 *   2. Size cap — if the queue would exceed MAX_RETRY_QUEUE_SIZE after the new
 *      entry is added, the oldest item is evicted to keep PropertiesService usage
 *      bounded (~1–2 KB/entry × 50 = well within the 500 KB total limit).
 */
function enqueueRetry(opts: SendOptions): void {
  let queue = loadRetryQueue();

  // ── 1. Purge stale entries ────────────────────────────────────────────────
  const cutoff = new Date(Date.now() - MAX_RETRY_QUEUE_AGE_HOURS * 3600 * 1000).toISOString();
  const before = queue.length;
  queue = queue.filter(item => item.firstFailedAt >= cutoff);
  if (queue.length < before) {
    Logger.log(
      `[emailService.enqueueRetry] Purged ${before - queue.length} stale entry/entries ` +
      `(older than ${MAX_RETRY_QUEUE_AGE_HOURS} h)`,
    );
  }

  // ── 2. Enforce size cap ───────────────────────────────────────────────────
  if (queue.length >= MAX_RETRY_QUEUE_SIZE) {
    const evicted = queue.shift(); // remove oldest
    Logger.log(
      `[emailService.enqueueRetry] Queue at capacity (${MAX_RETRY_QUEUE_SIZE}); ` +
      `evicted oldest entry id=${evicted?.id ?? '?'} type=${evicted?.type ?? '?'}`,
    );
  }

  const nextAt = new Date(Date.now() + RETRY_BACKOFF_HOURS[0] * 3600 * 1000).toISOString();
  const id     = `retry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  queue.push({
    id,
    type:          opts.type,
    to:            opts.to,
    cc:            opts.cc ?? [],
    subject:       opts.subject,
    html:          opts.html,
    resourceId:    opts.resourceId ?? '',
    firstFailedAt: new Date().toISOString(),
    attempts:      0,
    nextAttemptAt: nextAt,
    lastError:     '',
  });
  saveRetryQueue(queue);

  Logger.log(
    `[emailService.enqueueRetry] Queued retry for ${opts.type} (id=${id}) ` +
    `— first attempt at ${nextAt}`,
  );
}

/**
 * Processes all due entries in the retry queue.
 *
 * For each due item:
 *   - Tries to resend (with retry=false to prevent recursive queuing).
 *   - On success: removes from queue.
 *   - On failure with attempts < MAX_RETRY_ATTEMPTS: doubles the backoff and
 *     reschedules.
 *   - On exhaustion (attempts >= MAX_RETRY_ATTEMPTS): writes a high-visibility
 *     EMAIL_FAILED audit entry tagged ACTION_REQUIRED, then drops the item.
 *
 * Intended to be called from a GAS time-driven trigger every hour.
 */
export function drainEmailRetryQueue(): void {
  const queue = loadRetryQueue();
  if (queue.length === 0) {
    Logger.log('[emailService.drainEmailRetryQueue] Queue is empty — nothing to do');
    return;
  }

  const now = new Date().toISOString();
  const remaining: PendingRetry[] = [];

  for (const item of queue) {
    if (item.nextAttemptAt > now) {
      remaining.push(item); // Not due yet — keep.
      continue;
    }

    Logger.log(
      `[emailService.drainEmailRetryQueue] Retrying ${item.type} ` +
      `(attempt ${item.attempts + 1}/${MAX_RETRY_ATTEMPTS}, id=${item.id})`,
    );

    // Attempt resend — pass retry:false to avoid recursive queueing.
    const result = send({
      to:         item.to,
      cc:         item.cc,
      subject:    item.subject,
      html:       item.html,
      type:       item.type,
      resourceId: item.resourceId,
      retry:      false,
    });

    const succeeded =
      result.status === ResultStatus.SUCCESS &&
      ((result.data?.to.length ?? 0) > 0 || (result.data?.cc.length ?? 0) > 0);

    if (succeeded) {
      // Sent successfully on retry — drop from queue.
      Logger.log(
        `[emailService.drainEmailRetryQueue] Retry succeeded for ${item.type} ` +
        `(attempt ${item.attempts + 1}, id=${item.id})`,
      );
      // Success already audit-logged by send(); no further action needed.
    } else {
      const newAttempts = item.attempts + 1;

      if (newAttempts >= MAX_RETRY_ATTEMPTS) {
        // Exhausted — escalate to audit log and discard the item.
        Logger.log(
          `[emailService.drainEmailRetryQueue] ESCALATE: ${item.type} failed ` +
          `after ${newAttempts} retries (id=${item.id})`,
        );
        appendAuditLog({
          actorEmail:   'system',
          action:       AuditAction.EMAIL_FAILED,
          resourceType: 'email',
          resourceId:   item.resourceId,
          details:      {
            type:          item.type,
            reason:        'retry_exhausted',
            attempts:      newAttempts,
            firstFailedAt: item.firstFailedAt,
            subject:       item.subject,
            to:            item.to,
            note:          'ACTION_REQUIRED: Email delivery permanently failed after all retries. ' +
                           'Check MailApp daily quota and consider resending manually.',
          },
        });
        // Drop from queue — already escalated.
      } else {
        const backoffMs = (RETRY_BACKOFF_HOURS[newAttempts] ?? 4) * 3600 * 1000;
        remaining.push({
          ...item,
          attempts:      newAttempts,
          lastError:     result.message ?? '',
          nextAttemptAt: new Date(Date.now() + backoffMs).toISOString(),
        });
      }
    }
  }

  saveRetryQueue(remaining);
  Logger.log(
    `[emailService.drainEmailRetryQueue] Done — ${remaining.length} item(s) still pending`,
  );
}
