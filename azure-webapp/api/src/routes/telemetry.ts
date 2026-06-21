/**
 * telemetry.ts — POST /api/client-errors: surface browser-side failures to ops.
 *
 * Why this exists: a failure that happens entirely in the browser (a thrown
 * render error, an unhandled promise rejection, or a download/save that fails
 * for every selected photo) produces no server log, so a log-based alert never
 * fires and ops never hears about it. This endpoint lets the client POST those
 * failures back; we re-emit them as ERROR-severity logs, which an alert rule on
 * the api's logs can pick up.
 *
 * Mirrors cloud-webapp/api/src/routes/telemetry.ts so the GCP and Azure
 * deployments behave identically. Auth + a dedicated rate-limit bucket keep it
 * from becoming an alert-spam vector (each accepted report is a potential alert).
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

      // ERROR severity is the whole point: it's what an alert rule matches.
      // `clientError: true` lets you tell these apart from server exceptions in
      // the alert / log query.
      logger.error(
        {
          clientError: true,
          kind: report.kind,
          clientMessage: report.message,
          stack: report.stack,
          clientUrl: report.url,
          userAgent: report.userAgent ?? req.get('user-agent'),
          context,
          by: req.user?.email,
          uid: req.user?.uid,
        },
        `client error reported: ${report.kind}`,
      );

      const body: ClientErrorAck = { ok: true };
      res.status(202).json(body);
    } catch (err) {
      next(err);
    }
  },
);
