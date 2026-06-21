import pino from 'pino';
import { isProd } from './config.js';

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
export const logger = pino({
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
});
