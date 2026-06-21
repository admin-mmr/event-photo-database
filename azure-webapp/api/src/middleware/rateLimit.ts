/**
 * rateLimit.ts — per-user rate limiting (dev plan M5.3 / PRD §9).
 *
 * A Firestore-backed fixed-window counter keyed by `bucket:key:windowStart`.
 * Firestore (not in-memory) so the limit holds across the multiple Cloud Run
 * instances that spin up during an event-weekend burst. Each counter doc
 * carries an `expireAt` so a Firestore TTL policy on `rate_limits.expireAt`
 * garbage-collects old windows (configured once in infra, not here).
 *
 * Fail OPEN: any backend error resolves to "allowed". A limiter outage must
 * never block a real attendee from finding their photos — abuse protection is
 * defence-in-depth on top of auth + reCAPTCHA, not the primary gate.
 *
 * The middleware no-ops under NODE_ENV=test so existing route tests stay
 * deterministic; the core `consumeRateLimit` is unit-tested directly with an
 * injected Firestore double.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Firestore } from '@google-cloud/firestore';

import { firestore } from '../lib/firestore.js';
import { env, isTest } from '../lib/config.js';
import { logger } from '../lib/logger.js';

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly limit: number;
  /** Seconds until the current window resets (for Retry-After). */
  readonly resetSec: number;
}

/**
 * Render a retry delay as a coarse, human-friendly phrase for the user-facing
 * 429 message — "about 7 hours" reads far better than "in about 24814s". The
 * machine `Retry-After` header still carries exact seconds (HTTP spec).
 */
export function humanizeRetry(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  if (s < 60) return `about ${s} second${s === 1 ? '' : 's'}`;
  const mins = Math.round(s / 60);
  if (mins < 60) return `about ${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(s / 3600);
  return `about ${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * Increments and checks the counter for one (bucket, key) in the current
 * fixed window. `limit <= 0` disables the bucket (always allowed). Never throws
 * — backend errors fail open.
 */
export async function consumeRateLimit(
  db: Firestore,
  bucket: string,
  key: string,
  limit: number,
  windowSec: number,
  now: number = Date.now(),
): Promise<RateLimitDecision> {
  if (limit <= 0) {
    return { allowed: true, remaining: Number.POSITIVE_INFINITY, limit, resetSec: 0 };
  }

  const nowSec = Math.floor(now / 1000);
  const windowStart = Math.floor(nowSec / windowSec) * windowSec;
  const resetSec = windowStart + windowSec - nowSec;
  const docId = `${bucket}:${key}:${windowStart}`;
  const ref = db.collection('rate_limits').doc(docId);

  try {
    const count = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = (snap.exists ? (snap.data()?.count as number | undefined) : 0) ?? 0;
      const next = current + 1;
      tx.set(
        ref,
        {
          bucket,
          key,
          windowStart,
          count: next,
          expireAt: new Date((windowStart + windowSec) * 1000),
        },
        { merge: true },
      );
      return next;
    });

    return { allowed: count <= limit, remaining: Math.max(0, limit - count), limit, resetSec };
  } catch (err) {
    logger.warn({ err, bucket, key }, 'rate limit check failed — failing open');
    return { allowed: true, remaining: limit, limit, resetSec };
  }
}

/**
 * Express middleware factory. By default keys on the authenticated uid (falls
 * back to ip) — place AFTER requireAuth so `req.user` is populated. Pass `keyFn`
 * to key on something else (e.g. a public upload-link token on an unauthenticated
 * route, where there is no uid to key on).
 */
export function rateLimit(opts: {
  bucket: string;
  limit: number;
  windowSec: number;
  keyFn?: (req: Request) => string;
}): RequestHandler {
  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (isTest || opts.limit <= 0) {
      next();
      return;
    }
    const key = opts.keyFn ? opts.keyFn(req) : req.user?.uid || req.ip || 'anon';
    const decision = await consumeRateLimit(firestore(), opts.bucket, key, opts.limit, opts.windowSec);

    res.setHeader('X-RateLimit-Limit', String(decision.limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, decision.remaining)));

    if (decision.allowed) {
      next();
      return;
    }
    res.setHeader('Retry-After', String(decision.resetSec));
    res.status(429).json({
      ok: false,
      error: 'rate_limited',
      message: `Too many requests — please try again in ${humanizeRetry(decision.resetSec)}.`,
    });
  };
}

/** Convenience builders wired to the configured limits. */
export const findmeSearchRateLimit = (): RequestHandler =>
  rateLimit({
    bucket: 'findme_search',
    limit: env.FINDME_SEARCH_LIMIT,
    windowSec: env.FINDME_SEARCH_WINDOW_SEC,
  });

export const downloadRateLimit = (): RequestHandler =>
  rateLimit({ bucket: 'download', limit: env.DOWNLOAD_LIMIT_PER_DAY, windowSec: 24 * 60 * 60 });

/**
 * Per-photo original fetches (the "Save individually" / "Save to Photos" path).
 * Own bucket with a generous limit — one user save fans out into N requests, so
 * this must not share the bulk-ZIP `download` budget (dev plan §5B C1).
 */
export const originalFetchRateLimit = (): RequestHandler =>
  rateLimit({ bucket: 'original_fetch', limit: env.ORIGINAL_FETCH_LIMIT, windowSec: 24 * 60 * 60 });

/**
 * Per-link-token limit on the public volunteer upload `/session` endpoint
 * (UPLOAD_RESUMABLE_NOTES). The route is unauthenticated — the link token is the
 * only stable identity — so we key on the token (a leaked link is the abuse
 * vector, not a logged-in user). Falls back to ip if the body somehow lacks a
 * token (the route's schema validation rejects that case anyway).
 */
export const volunteerUploadRateLimit = (): RequestHandler =>
  rateLimit({
    bucket: 'volunteer_upload',
    limit: env.VOLUNTEER_UPLOAD_LIMIT,
    windowSec: env.VOLUNTEER_UPLOAD_WINDOW_SEC,
    keyFn: (req) => {
      const token = (req.body as { token?: unknown } | undefined)?.token;
      return typeof token === 'string' && token.length > 0 ? `tok:${token}` : req.ip || 'anon';
    },
  });
