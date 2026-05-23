import type { ErrorRequestHandler, RequestHandler } from 'express';
import { logger } from '../lib/logger.js';
import { isProd } from '../lib/config.js';

/**
 * Express error handler. Logs the full error server-side, returns a sanitized
 * envelope to the client. In non-prod the message is included for debugging.
 *
 * Must be registered AFTER all routes and after `notFoundHandler`.
 * Express only invokes 4-arg error handlers when something called `next(err)`.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  logger.error({ err }, 'unhandled error');
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
