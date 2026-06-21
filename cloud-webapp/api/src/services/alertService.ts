/**
 * alertService.ts — emails an operator when an unhandled error reaches the
 * Express error handler (middleware/error.ts).
 *
 * Sent via SendGrid's HTTPS API (no SMTP egress to worry about on Cloud Run).
 * Like the reCAPTCHA gate, alerting NO-OPS unless it is configured
 * (SENDGRID_API_KEY + ALERT_EMAIL_FROM + ALERT_EMAIL_TO all set), so local dev,
 * tests and CI never send mail.
 *
 * Two guarantees:
 *  - Never throws. A mail failure is logged and swallowed — alerting must not
 *    turn one 500 into two, nor add latency the client waits on (callers
 *    fire-and-forget with `void`).
 *  - Throttled. An error storm (the same bug hit hundreds of times, or many
 *    distinct errors at once) must not flood the inbox: at most one mail per
 *    distinct error signature per ALERT_THROTTLE_SEC, and at most
 *    ALERT_MAX_PER_HOUR mails overall (per instance).
 */

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';

export interface AlertContext {
  method?: string | undefined;
  path?: string | undefined;
  statusCode?: number | undefined;
  requestId?: string | undefined;
  userEmail?: string | undefined;
}

/** True only when all three alert settings are present. */
export function isAlertingConfigured(): boolean {
  return (
    env.SENDGRID_API_KEY.length > 0 &&
    env.ALERT_EMAIL_FROM.length > 0 &&
    env.ALERT_EMAIL_TO.length > 0
  );
}

// ── Throttle state (per instance; reset on cold start) ───────────────────────
const lastSentBySignature = new Map<string, number>();
let sentTimestamps: number[] = [];

/** A stable-ish fingerprint for an error so repeats are de-duped. */
function signatureOf(err: unknown): string {
  if (err instanceof Error) {
    const firstFrame = (err.stack ?? '').split('\n')[1]?.trim() ?? '';
    return `${err.name}:${err.message}:${firstFrame}`;
  }
  return `non-error:${String(err)}`;
}

/**
 * Decides whether to send for this signature now, updating throttle state.
 * Exported for tests. `now` is injectable for deterministic testing.
 */
export function shouldSend(signature: string, now: number = Date.now()): boolean {
  // Global hourly cap (sliding window).
  const hourAgo = now - 3_600_000;
  sentTimestamps = sentTimestamps.filter((t) => t > hourAgo);
  if (env.ALERT_MAX_PER_HOUR > 0 && sentTimestamps.length >= env.ALERT_MAX_PER_HOUR) {
    return false;
  }
  // Per-signature cooldown.
  const last = lastSentBySignature.get(signature);
  if (last !== undefined && now - last < env.ALERT_THROTTLE_SEC * 1000) {
    return false;
  }
  lastSentBySignature.set(signature, now);
  sentTimestamps.push(now);
  return true;
}

/** Reset throttle state (tests only). */
export function _resetThrottleForTest(): void {
  lastSentBySignature.clear();
  sentTimestamps = [];
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function buildBody(err: unknown, ctx: AlertContext): { subject: string; text: string } {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : 'Error';
  const stack = err instanceof Error ? (err.stack ?? '') : '';
  const where = ctx.method && ctx.path ? `${ctx.method} ${ctx.path}` : (ctx.path ?? 'unknown route');
  const subject = truncate(`[event-photo-api] ${name}: ${message}`, 200);
  const lines = [
    `An unhandled error reached the API error handler.`,
    ``,
    `When:     ${new Date().toISOString()}`,
    `Route:    ${where}`,
    `Status:   ${ctx.statusCode ?? 500}`,
    `User:     ${ctx.userEmail ?? '(unauthenticated)'}`,
    `Request:  ${ctx.requestId ?? '(no id)'}`,
    `Build:    ${env.GIT_COMMIT_SHA ?? 'unknown'}`,
    ``,
    `Error:    ${name}: ${message}`,
    ``,
    `Stack:`,
    truncate(stack, 5000),
  ];
  return { subject, text: lines.join('\n') };
}

/**
 * Email an operator about an unhandled error. No-op when unconfigured or
 * throttled. Never throws; callers should `void` it (fire-and-forget).
 */
export async function sendErrorAlert(err: unknown, ctx: AlertContext = {}): Promise<void> {
  try {
    if (!isAlertingConfigured()) return;
    if (!shouldSend(signatureOf(err))) return;

    const { subject, text } = buildBody(err, ctx);
    const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: env.ALERT_EMAIL_TO }] }],
        from: { email: env.ALERT_EMAIL_FROM, name: 'Event Photo API alerts' },
        subject,
        content: [{ type: 'text/plain', value: text }],
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      logger.warn({ status: resp.status, detail: truncate(detail, 500) }, 'alert email send failed');
    }
  } catch (sendErr) {
    // Alerting must never escalate a failure. Log and move on.
    logger.warn({ err: sendErr }, 'alert email threw (swallowed)');
  }
}
