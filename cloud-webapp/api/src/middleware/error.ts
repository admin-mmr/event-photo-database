import type { ErrorRequestHandler, RequestHandler } from 'express';
import multer from 'multer';
import { logger } from '../lib/logger.js';
import { isProd } from '../lib/config.js';
import { sendMulterError } from './uploadLimits.js';

/**
 * Express error handler. Logs the full error server-side, returns a sanitized
 * envelope to the client. In non-prod the message is included for debugging.
 *
 * Must be registered AFTER all routes and after `notFoundHandler`.
 * Express only invokes 4-arg error handlers when something called `next(err)`.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // A multipart upload over a route's limits is the caller's mistake, not ours.
  // It used to fall through to the 500 below, so an attendee whose selfie was a
  // full-resolution phone photo over 15 MB saw "Internal server error" (9 Find-Me
  // searches on 2026-11-02, the NYC Marathon). See uploadLimits.ts.
  if (err instanceof multer.MulterError) {
    sendMulterError(req, res, err);
    return;
  }
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
