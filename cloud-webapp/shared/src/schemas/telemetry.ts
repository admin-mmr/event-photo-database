/**
 * telemetry.ts — client-side error reporting (POST /api/client-errors).
 *
 * The web client reaches the api via the Firebase Hosting `/api/**` rewrite, so
 * a failure that happens entirely in the browser (e.g. every signed-URL fetch
 * in the ZIP download throwing on a CORS misconfig) never produces a server-side
 * log — and therefore never trips the Cloud Monitoring "severity>=ERROR" email
 * alert. This endpoint lets the client POST those failures back so the api can
 * log them at ERROR severity, which the existing alert policy then emails.
 *
 * Every field is hard-bounded: a client error report becomes an ERROR log line
 * (= a potential alert email), so the payload must stay small and abuse-resistant.
 */

import { z } from 'zod';

/** Max serialized size (bytes) of the optional `context` bag, enforced server-side. */
export const MAX_CLIENT_ERROR_CONTEXT_BYTES = 4000;

export const ClientErrorReportSchema = z.object({
  /**
   * Coarse category so alerts can be triaged at a glance, e.g.
   * 'download_failed', 'unhandled_error', 'unhandled_rejection', 'react_render'.
   */
  kind: z.string().min(1).max(64).default('client_error'),
  /** Human-readable error message (the `.message` of the thrown Error). */
  message: z.string().min(1).max(2000),
  /** Optional stack trace, capped so a huge trace can't bloat the log. */
  stack: z.string().max(8000).optional(),
  /** The page URL where the error happened (location.href). */
  url: z.string().max(2000).optional(),
  /** navigator.userAgent, to help reproduce device-specific failures. */
  userAgent: z.string().max(1000).optional(),
  /** Small free-form bag of extra diagnostics (counts, sample statuses, …). */
  context: z.record(z.string(), z.unknown()).optional(),
});

export type ClientErrorReport = z.infer<typeof ClientErrorReportSchema>;

export const ClientErrorAckSchema = z.object({
  ok: z.literal(true),
});

export type ClientErrorAck = z.infer<typeof ClientErrorAckSchema>;
