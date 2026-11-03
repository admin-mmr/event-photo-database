/**
 * telemetry.ts — POST /api/client-errors: surface browser-side failures to ops.
 *
 * Why this exists: the web client reaches the api through the Firebase Hosting
 * `/api/**` rewrite, so a failure that happens entirely in the browser produces
 * no server log at all. The bulk ZIP download is the canonical case — the api
 * signs the selection and returns 200, then the browser fetches each signed GCS
 * URL directly; if those all fail (e.g. the derivatives bucket is missing its
 * CORS rule) the user sees "None of the selected photos could be downloaded."
 * but nothing is ever logged server-side, so the Cloud Monitoring alert
 * (severity>=ERROR on event-photo-api → email) never fires.
 *
 * This endpoint lets the client POST those failures back. We re-emit them as
 * ERROR-severity logs, which the EXISTING alert policy
 * (infra/monitoring/error-alert-policy.json) turns into an email — no new GCP
 * infra needed. Auth + a dedicated rate-limit bucket keep it from being abused
 * into an alert-spam vector (each accepted report is a potential email).
 */

import { Router } from 'express';
import {
  ClientErrorReportSchema,
  MAX_CLIENT_ERROR_CONTEXT_BYTES,
  type ClientErrorAck,
} from '@cloud-webapp/shared';

import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { clientErrorRateLimit } from '../middleware/rateLimit.js';

export const telemetryRouter = Router();

/**
 * Backstop for a client that floods identical reports (the web client dedupes
 * per page load, but a tab still on an older bundle does not): after the first
 * ERROR for a given (uid, kind, message), repeats inside this window log at WARN,
 * so one broken tab can't bury real errors under alert-matching lines.
 * In-memory and per instance — a looser bound across instances is fine for a
 * backstop. Keyed on the verified uid, never on `req.ip`.
 */
export const REPEAT_WINDOW_MS = 10 * 60_000;
const MAX_TRACKED_REPORTS = 5000;
const lastErrorAt = new Map<string, number>();

/** True when this report already logged at ERROR inside the window. */
function isRepeat(key: string, nowMs: number): boolean {
  const last = lastErrorAt.get(key);
  if (last !== undefined && nowMs - last < REPEAT_WINDOW_MS) return true;
  if (lastErrorAt.size >= MAX_TRACKED_REPORTS) {
    for (const [k, t] of lastErrorAt) if (nowMs - t >= REPEAT_WINDOW_MS) lastErrorAt.delete(k);
    if (lastErrorAt.size >= MAX_TRACKED_REPORTS) lastErrorAt.clear();
  }
  lastErrorAt.set(key, nowMs);
  return false;
}

/** Test hook. */
export function resetClientErrorRepeats(): void {
  lastErrorAt.clear();
}

telemetryRouter.post(
  '/client-errors',
  requireAuth,
  clientErrorRateLimit(),
  async (req, res, next) => {
    try {
      const parsed = ClientErrorReportSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: 'invalid_request',
          message: parsed.error.issues[0]?.message ?? 'message is required',
        });
        return;
      }

      const report = parsed.data;

      // Drop an oversized context bag rather than logging (and alerting on) a
      // huge blob — the bounded top-level fields are enough to triage.
      let context = report.context;
      if (context && JSON.stringify(context).length > MAX_CLIENT_ERROR_CONTEXT_BYTES) {
        context = { truncated: true };
      }

      // ERROR severity is the whole point: it's what the alert policy matches.
      // `clientError: true` lets you tell these apart from server exceptions in
      // the alert / log filter. A repeat (the client's own follow-up, or one we
      // already logged at ERROR for this user) drops to WARN.
      const key = `${req.user?.uid ?? ''}\u0000${report.kind}\u0000${report.message.slice(0, 200)}`;
      const repeat = isRepeat(key, Date.now()) || report.repeatCount !== undefined;
      const fields = {
        clientError: true,
        kind: report.kind,
        clientMessage: report.message,
        stack: report.stack,
        clientUrl: report.url,
        userAgent: report.userAgent ?? req.get('user-agent'),
        context,
        ...(report.repeatCount !== undefined ? { repeatCount: report.repeatCount } : {}),
        ...(repeat ? { repeat: true } : {}),
        by: req.user?.email,
        uid: req.user?.uid,
      };
      if (repeat) logger.warn(fields, `client error repeated: ${report.kind}`);
      else logger.error(fields, `client error reported: ${report.kind}`);

      const body: ClientErrorAck = { ok: true };
      res.status(202).json(body);
    } catch (err) {
      next(err);
    }
  },
);
