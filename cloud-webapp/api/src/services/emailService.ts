/**
 * emailService.ts — send transactional + digest email via the Gmail API using
 * the SAME keyless domain-wide delegation as Drive/Sheets (dev plan G4.1, R3/R4:
 * cloud-neutral, stays on the Workspace domain so SPF/DKIM "just work", and ports
 * to Azure unchanged). No SMTP, no third-party key.
 *
 * Sending is gated by EMAIL_ENABLED: when 'false' (default — dev/test/demo), the
 * functions no-op after logging, so nothing real is sent and tests don't need a
 * network. Flip to 'true' in prod once the `gmail.send` scope is authorized on
 * the DWD client and EMAIL_FROM is set.
 */

import { GoogleAuth } from 'google-auth-library';

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import type { EmailContent } from './emailTemplates.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
let cached: { token: string; expiresAt: number } | null = null;

/** The address mail is sent from / impersonated as (defaults to the DWD subject). */
export function emailFrom(): string {
  return env.EMAIL_FROM || env.DWD_SUBJECT;
}

/** Mint (and cache) a Gmail access token via keyless DWD, impersonating EMAIL_FROM. */
export async function getGmailToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const claims = JSON.stringify({
    iss: env.DWD_SA,
    sub: emailFrom(),
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });
  const client = await auth.getClient();
  const signRes = await client.request<{ signedJwt: string }>({
    url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${env.DWD_SA}:signJwt`,
    method: 'POST',
    data: { payload: claims },
  });
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: signRes.data.signedJwt,
  });
  const res = await fetch(TOKEN_URL, { method: 'POST', body });
  if (!res.ok) throw new Error(`Gmail DWD token exchange failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cached.token;
}

/**
 * RFC 2047-encode a header value when it contains non-ASCII; ASCII passes
 * through untouched. Headers are ASCII-only per RFC 822 — a raw UTF-8 em dash
 * in Subject reaches Gmail as charset-guessed mojibake ("Ã¢Â€Â”"). Each
 * encoded-word stays ≤75 chars and splits on whole characters, so a multi-byte
 * char never straddles two words; words are joined with folding whitespace.
 */
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const chunks: string[] = [];
  let chunk = '';
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      chunks.push(chunk);
      chunk = ch;
    } else {
      chunk += ch;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks
    .map((c) => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`)
    .join('\r\n ');
}

/** Build a base64url-encoded RFC-822 multipart/alternative message. */
export function buildRawMessage(to: string, content: EmailContent): string {
  const boundary = `mmr_${Date.now().toString(36)}`;
  const headers = [
    `From: ${emailFrom()}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(content.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join('\r\n');
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    content.text,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    content.html,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return Buffer.from(`${headers}\r\n\r\n${body}`, 'utf8').toString('base64url');
}

/**
 * Send one email. Returns true if actually sent. No-ops (returns false) when
 * EMAIL_ENABLED!=='true' or `to` is blank. Never throws to its caller path used
 * for best-effort notifications — callers may still await and check the result.
 */
export async function sendEmail(to: string, content: EmailContent): Promise<boolean> {
  if (!to.trim()) return false;
  if (env.EMAIL_ENABLED !== 'true') {
    logger.info({ to, subject: content.subject, emailDisabled: true }, 'email send skipped (EMAIL_ENABLED!=true)');
    return false;
  }
  try {
    const token = await getGmailToken();
    const res = await fetch(GMAIL_SEND, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: buildRawMessage(to, content) }),
    });
    if (!res.ok) throw new Error(`Gmail send ${res.status}: ${await res.text()}`);
    logger.info({ to, subject: content.subject }, 'email sent');
    return true;
  } catch (err) {
    logger.warn({ err, to, subject: content.subject }, 'email send failed (non-fatal)');
    return false;
  }
}

/** Send the same content to many recipients; returns how many were sent. */
export async function sendToMany(recipients: string[], content: EmailContent): Promise<number> {
  let sent = 0;
  for (const to of recipients) {
    if (await sendEmail(to, content)) sent += 1;
  }
  return sent;
}
