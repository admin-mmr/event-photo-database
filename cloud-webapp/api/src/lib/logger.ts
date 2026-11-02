import pino from 'pino';
import type { LoggerOptions } from 'pino';
import { isProd } from './config.js';

/**
 * Request headers that carry credentials. pino-http logs every header on each
 * `request completed` line, and Cloud Logging is readable by project members
 * and feeds alert emails — so these must never reach it. The key is kept (its
 * presence is useful when debugging auth); only the value is replaced.
 *
 * - `authorization`: the user's Firebase ID token, or a scheduler's OIDC token.
 * - `x-sync-token`: the SYNC_TRIGGER_TOKEN machine secret (middleware/cronAuth.ts).
 * - `x-recaptcha-token`: a reCAPTCHA token (middleware/recaptcha.ts).
 * - `x-api-key`: a partner API key (middleware/partnerAuth.ts).
 * - `cookie` / `proxy-authorization`: not used by this app, but never safe to log.
 *
 * Node lower-cases incoming header names, so lower-case entries match any casing
 * the client sent. Everything else, `x-forwarded-for` included, stays logged:
 * request logs are where client IPs live for abuse investigation.
 */
export const REDACTED_REQUEST_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-sync-token',
  'x-recaptcha-token',
  'x-api-key',
] as const;

export const REDACTED = '[REDACTED]';

/**
 * Pino options for the app logger, exported so tests can build an identical
 * logger over a capture stream and prove the redaction holds end to end.
 */
export const loggerOptions: LoggerOptions = {
  level: process.env['LOG_LEVEL'] ?? (isProd ? 'info' : 'debug'),
  // Map pino level → Cloud Logging severity.
  formatters: {
    level(label) {
      return { severity: label.toUpperCase() };
    },
  },
  // Cloud Logging looks at `message`, not `msg`.
  messageKey: 'message',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: null, // drop pid/hostname; Cloud Run already records the instance
  redact: {
    paths: [
      ...REDACTED_REQUEST_HEADERS.map((h) => `req.headers["${h}"]`),
      'res.headers["set-cookie"]',
    ],
    censor: REDACTED,
  },
};

/**
 * Pino logger configured for Cloud Logging compatibility.
 *
 * Cloud Run's log shipper parses single-line JSON automatically. The
 * `severity` field (uppercased) is what Cloud Logging uses to colour-code
 * entries in the console — we map pino's numeric levels onto it.
 *
 * In development the `pino-pretty` transport prints human-readable lines;
 * we don't add `pino-pretty` as a dependency so production stays slim.
 * To get pretty logs locally: `npm i -D pino-pretty -w api` then add the
 * transport block below.
 */
export const logger = pino(loggerOptions);
