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
import type { DocumentStore } from '../lib/db/types.js';

import { firestore } from '../lib/firestore.js';
import { env, isTest } from '../lib/config.js';
import { clientIp, rateLimitKeyForIp } from '../lib/clientIp.js';
import { logger } from '../lib/logger.js';
import { hasVerifiedSignIn } from '../lib/signIn.js';

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
 * The counter's document id. A key may hold characters a document id cannot:
 * an IPv6 key is a CIDR (`ip:2600:4040:9758:900::/64`) and Firestore reads `/`
 * as a path separator — every IPv6 guest's request crashed the api on it. Cosmos
 * forbids `/ \ ? #` too, so all four are replaced. The stored `key` field keeps
 * the original for anyone reading the counters.
 */
export function rateLimitDocId(bucket: string, key: string, windowStart: number): string {
  return `${bucket}:${key}:${windowStart}`.replace(/[/\\?#]/g, '_');
}

/**
 * Increments and checks the counter for one (bucket, key) in the current
 * fixed window. `limit <= 0` disables the bucket (always allowed). Never throws
 * — backend errors fail open.
 */
export async function consumeRateLimit(
  db: DocumentStore,
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

  try {
    // Inside the try: `.doc()` throws SYNCHRONOUSLY on an id it rejects, and a
    // throw here escaped every limiter as an unhandled rejection that killed
    // the whole api instance (2026-11-02).
    const ref = db.collection('rate_limits').doc(rateLimitDocId(bucket, key, windowStart));
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
    let decision: RateLimitDecision;
    try {
      const key = opts.keyFn ? opts.keyFn(req) : req.user?.uid || req.ip || 'anon';
      decision = await consumeRateLimit(firestore(), opts.bucket, key, opts.limit, opts.windowSec);
    } catch (err) {
      // Express 4 does not catch a rejected async middleware: an escaped throw
      // is an unhandled rejection, and Node exits — taking every in-flight
      // request on the instance with it. Fail open instead.
      logger.warn({ err, bucket: opts.bucket }, 'rate limiter threw — failing open');
      next();
      return;
    }

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
 * Client-error reports (POST /api/client-errors), keyed by uid. Each accepted
 * report is logged at ERROR severity and so can trigger an alert email — this
 * bucket caps how many a single client can emit per window (config defaults to
 * 30/hour). Fails open like every other limiter.
 */
export const clientErrorRateLimit = (): RequestHandler =>
  rateLimit({
    bucket: 'client_error',
    limit: env.CLIENT_ERROR_LIMIT,
    windowSec: env.CLIENT_ERROR_WINDOW_SEC,
  });

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

// ── Per-IP limits for guests ─────────────────────────────────────────────────

export type GuestIpLimitMode = 'off' | 'shadow' | 'enforce';

export type GuestIpLimitOutcome =
  | { readonly kind: 'skip'; readonly reason: 'off' | 'disabled' | 'verified_sign_in' | 'no_trusted_ip' }
  | {
      readonly kind: 'allow' | 'would_block' | 'block';
      readonly key: string;
      readonly via: 'hosting' | 'direct' | 'local';
      readonly decision: RateLimitDecision;
    };

/**
 * Decides one guest per-IP check. Exported (and free of Express response
 * handling) so it can be tested against the in-memory store; the middleware
 * below is a no-op under NODE_ENV=test like every other limiter here.
 *
 * Never limits on an IP it cannot trust: `clientIp` returns `suspect` when the
 * address it would use is itself a Google front end (a stale range list), and
 * counting that would lump every Hosting visitor into one bucket.
 */
export async function decideGuestIpLimit(
  db: DocumentStore,
  req: Request,
  opts: { bucket: string; limit: number; windowSec: number; mode: GuestIpLimitMode },
  now: number = Date.now(),
): Promise<GuestIpLimitOutcome> {
  if (opts.mode === 'off') return { kind: 'skip', reason: 'off' };
  if (opts.limit <= 0) return { kind: 'skip', reason: 'disabled' };
  if (hasVerifiedSignIn(req)) return { kind: 'skip', reason: 'verified_sign_in' };
  const resolved = clientIp(req);
  noteFrontEndHop(req, resolved);
  if (!resolved.ip) return { kind: 'skip', reason: 'no_trusted_ip' };

  const key = `ip:${rateLimitKeyForIp(resolved.ip)}`;
  const decision = await consumeRateLimit(db, opts.bucket, key, opts.limit, opts.windowSec, now);
  const kind = decision.allowed ? 'allow' : opts.mode === 'enforce' ? 'block' : 'would_block';
  return { kind, key, via: resolved.via, decision };
}

/**
 * Loud, throttled signal that the Google front-end range list is stale. A
 * request that carries Firebase Hosting's own header but whose last hop we
 * don't recognise means Hosting moved to a range lib/googleFrontEndRanges.ts
 * lacks — and then every Hosting visitor shares the front end's IP as their
 * "client". In shadow mode that only skews counts; in enforce it would 429
 * real attendees en masse. ERROR (the live alert policy emails), at most once
 * per instance per hour. Fix: infra/scripts/refresh-google-front-end-ranges.sh.
 * (The header is forgeable, so this is a signal only — it never changes a
 * decision.)
 */
let lastHopWarnAt = 0;
function noteFrontEndHop(req: Request, resolved: ReturnType<typeof clientIp>): void {
  const viaHosting = req.headers['x-firebase-hosting-channel'] !== undefined;
  const stale = resolved.suspect === true || (viaHosting && resolved.via === 'direct');
  if (!stale || Date.now() - lastHopWarnAt < 3600_000) return;
  lastHopWarnAt = Date.now();
  logger.error(
    { alert: 'client_ip_unrecognized_hop', via: resolved.via, suspect: resolved.suspect === true },
    'clientIp: unrecognized Google front-end hop — per-IP guest limits may be miscounting; ' +
      'run infra/scripts/refresh-google-front-end-ranges.sh',
  );
}

/**
 * Per-IP limit for GUESTS on top of a per-uid limit. Place AFTER requireAuth
 * (needs `req.user` to exempt verified sign-ins) and BEFORE requireRecaptcha,
 * so an over-limit guest in enforce mode never costs a billed assessment.
 * Mode is read per request from env, so a `gcloud run services update` flips it.
 * Over-limit requests are logged as `guest ip limit` with the IP key — that log
 * is what an owner reads to decide whether to enforce.
 */
export function guestIpRateLimit(opts: { bucket: string; limit: number; windowSec: number }): RequestHandler {
  return async function guestIpRateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (isTest) {
      next();
      return;
    }
    let out: GuestIpLimitOutcome;
    try {
      out = await decideGuestIpLimit(firestore(), req, { ...opts, mode: env.GUEST_IP_LIMIT_MODE });
    } catch (err) {
      // See rateLimitMiddleware: an escaped throw here exits the process.
      logger.warn({ err, bucket: opts.bucket }, 'guest ip limiter threw — failing open');
      next();
      return;
    }
    if (out.kind === 'skip' || out.kind === 'allow') {
      next();
      return;
    }
    logger.warn(
      {
        ipLimit: {
          bucket: opts.bucket,
          mode: env.GUEST_IP_LIMIT_MODE,
          outcome: out.kind === 'block' ? 'blocked' : 'would_block',
          key: out.key,
          via: out.via,
          limit: out.decision.limit,
          windowSec: opts.windowSec,
        },
        uid: req.user?.uid,
      },
      'guest ip limit',
    );
    if (out.kind === 'would_block') {
      next();
      return;
    }
    res.setHeader('Retry-After', String(out.decision.resetSec));
    res.status(429).json({
      ok: false,
      error: 'rate_limited',
      message:
        `Too many requests from your network — please try again in ${humanizeRetry(out.decision.resetSec)}, ` +
        'or sign in with Google.',
    });
  };
}

export const findmeSearchIpRateLimit = (): RequestHandler =>
  guestIpRateLimit({
    bucket: 'findme_search_ip',
    limit: env.FINDME_SEARCH_IP_LIMIT,
    windowSec: env.FINDME_SEARCH_IP_WINDOW_SEC,
  });

export const downloadIpRateLimit = (): RequestHandler =>
  guestIpRateLimit({ bucket: 'download_ip', limit: env.DOWNLOAD_IP_LIMIT_PER_DAY, windowSec: 24 * 60 * 60 });

export const originalFetchIpRateLimit = (): RequestHandler =>
  guestIpRateLimit({ bucket: 'original_fetch_ip', limit: env.ORIGINAL_FETCH_IP_LIMIT, windowSec: 24 * 60 * 60 });
