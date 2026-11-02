/**
 * recaptcha.ts (middleware) — gates an action behind a verified reCAPTCHA
 * Enterprise token (dev plan M5.3 / PRD §9).
 *
 * No-ops when reCAPTCHA is not configured (see services/recaptcha.ts), so the
 * demo and local dev keep working without a key. The client sends the token in
 * the `X-Recaptcha-Token` header (preferred — works for multipart routes) or a
 * `recaptchaToken` body field.
 *
 * RECAPTCHA_MODE decides what a bad verdict does:
 *   - `shadow` (default): log it and let the request through. This is how a
 *     threshold gets chosen from real traffic before anyone can be blocked.
 *   - `enforce`: 403.
 * Either way every verdict is logged as one `recaptcha verdict` line with a
 * stable shape (`recaptcha.{action,mode,outcome,reason,score}`) so the score
 * distribution can be read straight out of Cloud Logging — see
 * BOT_PROTECTION_PLAN.md for the queries.
 *
 * Only GUESTS are checked. A user with a verified sign-in (`hasVerifiedSignIn`
 * in lib/signIn.ts — Google, an allowlist) skips the assessment: no cost,
 * no false-positive 403. Must run after requireAuth so `req.user` is populated.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { hasVerifiedSignIn } from '../lib/signIn.js';
import { isRecaptchaConfigured, verifyRecaptcha, type RecaptchaResult } from '../services/recaptcha.js';

function extractToken(req: Request): string | undefined {
  const header = req.headers['x-recaptcha-token'];
  if (typeof header === 'string' && header.length > 0) return header;
  const body = req.body as { recaptchaToken?: unknown } | undefined;
  if (body && typeof body.recaptchaToken === 'string' && body.recaptchaToken.length > 0) {
    return body.recaptchaToken;
  }
  return undefined;
}

/**
 * pass              — good verdict
 * fail_open         — the assessment itself failed; allowed regardless of mode
 * would_block       — bad verdict, allowed because mode is shadow
 * blocked           — bad verdict, 403'd because mode is enforce
 * skipped_signed_in — signed-in (non-guest) user; no assessment made
 */
export type VerdictOutcome = 'pass' | 'fail_open' | 'would_block' | 'blocked' | 'skipped_signed_in';

export function verdictOutcome(result: RecaptchaResult, mode: 'shadow' | 'enforce'): VerdictOutcome {
  if (result.ok) return result.failOpen ? 'fail_open' : 'pass';
  return mode === 'enforce' ? 'blocked' : 'would_block';
}

/** Middleware factory: verifies the token for `action`; 403 only in enforce mode. */
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
    const mode = env.RECAPTCHA_MODE;
    if (hasVerifiedSignIn(req)) {
      logger.info(
        {
          recaptcha: { action, mode, outcome: 'skipped_signed_in', reason: req.user?.signInProvider },
          uid: req.user?.uid,
        },
        'recaptcha verdict',
      );
      next();
      return;
    }
    const result = await verifyRecaptcha(extractToken(req), action);
    const outcome = verdictOutcome(result, mode);

    const line = {
      recaptcha: {
        action,
        mode,
        outcome,
        reason: result.reason,
        ...(result.score !== undefined ? { score: result.score } : {}),
      },
      uid: req.user?.uid,
    };
    if (outcome === 'blocked' || outcome === 'would_block') {
      logger.warn(line, 'recaptcha verdict');
    } else {
      logger.info(line, 'recaptcha verdict');
    }

    if (outcome !== 'blocked') {
      next();
      return;
    }
    res.status(403).json({
      ok: false,
      error: 'recaptcha_failed',
      message: 'We could not verify this request. Please reload and try again, or sign in with Google.',
    });
  };
}
