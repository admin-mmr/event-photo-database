/**
 * uploadLimits.ts — answer multer's limit errors as a 4xx the client can act on.
 *
 * Unwrapped, a multer middleware hands a `MulterError` to `next(err)`, and the
 * error handler turns it into a generic 500. That is what attendees got on the
 * NYC Marathon event day (2026-11-03): nine "File too large" 500s on Find Me,
 * shown as "search failed" with nothing about the photo being too big.
 *
 *   LIMIT_FILE_SIZE  → 413 `file_too_large` (+ `maxFileBytes`)
 *   LIMIT_FILE_COUNT → 413 `too_many_files` (+ `maxFiles`)
 *   any other multer error (wrong field name, too many parts…) → 400 `bad_upload`
 *
 * All are client mistakes, so they log at WARN — the `severity>=ERROR` alert
 * policy must not fire on someone picking a big photo.
 */

import type { RequestHandler } from 'express';
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

/** Wrap a multer middleware so its limit errors become 413/400 responses.
 *  Anything that is not a MulterError still goes to the error handler. */
export function withUploadLimits(parse: RequestHandler, limits: UploadLimits): RequestHandler {
  return (req, res, next) => {
    parse(req, res, (err?: unknown) => {
      if (!(err instanceof multer.MulterError)) {
        next(err);
        return;
      }
      logger.warn(
        { code: err.code, field: err.field, path: req.path },
        'upload rejected by multer limits',
      );
      switch (err.code) {
        case 'LIMIT_FILE_SIZE':
          res.status(413).json({
            ok: false,
            error: 'file_too_large',
            message: `Each photo must be ${megabytes(limits.maxFileBytes)} MB or smaller`,
            maxFileBytes: limits.maxFileBytes,
          });
          return;
        case 'LIMIT_FILE_COUNT':
          res.status(413).json({
            ok: false,
            error: 'too_many_files',
            message: `Send at most ${limits.maxFiles} photos at a time`,
            maxFiles: limits.maxFiles,
          });
          return;
        default:
          res.status(400).json({ ok: false, error: 'bad_upload', message: err.message });
      }
    });
  };
}
