import type { ErrorRequestHandler, RequestHandler, Request } from 'express';
import { logger } from '../lib/logger.js';
import { isProd } from '../lib/config.js';
import { sendErrorAlert } from '../services/alertService.js';

/**
 * Express error handler. Logs the full error server-side, returns a sanitized
 * envelope to the client. In non-prod the message is included for debugging.
 *
 * Must be registered AFTER all routes and after `notFoundHandler`.
 * Express only invokes 4-arg error handlers when something called `next(err)`.
 */
export const errorHandler: ErrorRequestHandler = (err, req: Request, res, _next) => {
  logger.error({ err }, 'unhandled error');
  // Fire-and-forget operator alert (no-op unless configured; throttled; never
  // throws). We don't await it — the client response must not wait on email.
  void sendErrorAlert(err, {
    method: req.method,
    path: req.originalUrl,
    statusCode: 500,
    requestId: typeof req.id === 'string' ? req.id : undefined,
    userEmail: req.user?.email,
  });
  res.status(500).json({
    ok: false,
    error: 'internal',
    message: isProd ? 'Internal server error' : String(err?.message ?? err),
  });
};

/**
 * 404 handler. Plain RequestHandler (3-arg), not ErrorRequestHandler —
 * Express runs the last regular middleware when no route matched.
 * Must be registered AFTER all routes but BEFORE `errorHandler`.
 */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ ok: false, error: 'not_found', message: 'Route not found' });
};
