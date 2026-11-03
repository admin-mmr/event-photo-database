/**
 * uploadLimits.ts — answer multer's limit errors as a 4xx the client can act on.
 *
 * Unhandled, a multer middleware hands a `MulterError` to `next(err)`, and the
 * error handler used to turn it into a generic 500. That is what attendees got
 * on the NYC Marathon event day (2026-11-03): nine "File too large" 500s on
 * Find Me, shown as "search failed" with nothing about the photo being too big.
 *
 *   LIMIT_FILE_SIZE  → 413 `file_too_large`
 *   LIMIT_FILE_COUNT → 413 `too_many_files`
 *   any other multer error (wrong field name, too many parts…) → 400 `bad_upload`
 *
 * This is the ONE place that mapping lives. `errorHandler` calls
 * `sendMulterError` for every route; a route that wraps its parser in
 * `withUploadLimits` also gets its limits named in the message and the body.
 *
 * All are client mistakes, so they log at WARN — the `severity>=ERROR` alert
 * policy must not fire on someone picking a big photo.
 */

import type { Request, RequestHandler, Response } from 'express';
import multer from 'multer';

import { logger } from '../lib/logger.js';

export interface UploadLimits {
  /** The per-file `limits.fileSize` the multer instance was built with. */
  maxFileBytes: number;
  /** The `limits.files` / array maxCount the multer instance was built with. */
  maxFiles: number;
}

/** Bytes → whole MB for a user-facing message ("15 MB", not "15728640"). */
function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/** Answer a MulterError. `limits`, when the caller knows them, are named in the
 *  message and returned as fields so a client can say exactly what to fix. */
export function sendMulterError(
  req: Request,
  res: Response,
  err: multer.MulterError,
  limits?: UploadLimits,
): void {
  logger.warn(
    { code: err.code, field: err.field, path: req.path },
    'upload rejected by multer limits',
  );
  switch (err.code) {
    case 'LIMIT_FILE_SIZE':
      res.status(413).json({
        ok: false,
        error: 'file_too_large',
        message: limits
          ? `That photo is too large to upload (the limit is ${megabytes(limits.maxFileBytes)} MB). Please choose a smaller photo, or take a screenshot of it and use that.`
          : 'That photo is too large to upload. Please choose a smaller photo, or take a screenshot of it and use that.',
        ...(limits ? { maxFileBytes: limits.maxFileBytes } : {}),
      });
      return;
    case 'LIMIT_FILE_COUNT':
      res.status(413).json({
        ok: false,
        error: 'too_many_files',
        message: limits
          ? `Send at most ${limits.maxFiles} photos at a time.`
          : 'Too many files in one upload.',
        ...(limits ? { maxFiles: limits.maxFiles } : {}),
      });
      return;
    default:
      res
        .status(400)
        .json({
          ok: false,
          error: 'bad_upload',
          message: `The upload could not be accepted: ${err.message}.`,
        });
  }
}

/** Wrap a multer middleware so its limit errors are answered with the route's
 *  own limits named. Anything that is not a MulterError still goes to the error
 *  handler. */
export function withUploadLimits(parse: RequestHandler, limits: UploadLimits): RequestHandler {
  return (req, res, next) => {
    parse(req, res, (err?: unknown) => {
      if (err instanceof multer.MulterError) {
        sendMulterError(req, res, err, limits);
        return;
      }
      next(err);
    });
  };
}
