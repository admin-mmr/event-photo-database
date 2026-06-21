/**
 * recaptcha.ts (middleware) — gates an action behind a verified reCAPTCHA
 * Enterprise token (dev plan M5.3 / PRD §9).
 *
 * No-ops when reCAPTCHA is not configured (see services/recaptcha.ts), so the
 * demo and local dev keep working without a key. The client sends the token in
 * the `X-Recaptcha-Token` header (preferred — works for multipart routes) or a
 * `recaptchaToken` body field.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';

import { logger } from '../lib/logger.js';
import { isRecaptchaConfigured, verifyRecaptcha } from '../services/recaptcha.js';

function extractToken(req: Request): string | undefined {
  const header = req.headers['x-recaptcha-token'];
  if (typeof header === 'string' && header.length > 0) return header;
  const body = req.body as { recaptchaToken?: unknown } | undefined;
  if (body && typeof body.recaptchaToken === 'string' && body.recaptchaToken.length > 0) {
    return body.recaptchaToken;
  }
  return undefined;
}

/** Middleware factory: verifies the token for `action`, 403 on a bad verdict. */
export function requireRecaptcha(action: string): RequestHandler {
  return async function recaptchaMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!isRecaptchaConfigured()) {
      next();
      return;
    }
    const result = await verifyRecaptcha(extractToken(req), action);
    if (result.ok) {
      next();
      return;
    }
    logger.warn({ action, reason: result.reason, score: result.score }, 'recaptcha rejected');
    res.status(403).json({
      ok: false,
      error: 'recaptcha_failed',
      message: 'We could not verify this request. Please reload and try again.',
    });
  };
}
