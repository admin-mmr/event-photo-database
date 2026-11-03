/**
 * reportError.ts — ship browser-side errors back to the api so ops gets alerted.
 *
 * Failures that happen entirely in the browser (a thrown render error, an
 * unhandled promise rejection, every signed-URL fetch in the ZIP download
 * failing) never reach the server, so the Cloud Monitoring email alert never
 * fires. This helper POSTs them to /api/client-errors, which logs them at ERROR
 * severity — tripping the existing alert. See api/src/routes/telemetry.ts.
 *
 * Hard rules: this must NEVER throw and must NEVER recurse. It is called from
 * global error handlers, so a failure here (or an error it itself triggers)
 * could otherwise loop forever. We swallow everything and set a re-entrancy
 * guard around the fetch.
 *
 * Repeats are deduplicated per page load (see `admit`). During the NYC Marathon
 * one iPhone Safari tab sent 60 identical "Connection to Indexed Database server
 * lost" rejections in five minutes — a WebKit/Firebase bug we can't fix — and
 * since the api logs every accepted report at ERROR, that was 60 alert-matching
 * lines burying the real errors. The in-flight guard only stops overlap, not a
 * sequential loop.
 */

import { apiPost } from './api.js';
import type { ClientErrorReport } from '@cloud-webapp/shared';

/** True while a report is in flight, so a failure inside reporting can't recurse. */
let reporting = false;

/** Backstop: no page load sends more than this many reports, whatever they are. */
export const MAX_REPORTS_PER_PAGE = 10;
/** The Nth occurrence of one error sends a single follow-up carrying the count,
 *  so ops can tell a looping tab from a one-off. Nothing is sent after that. */
export const REPEAT_FOLLOWUP_AT = 10;
/** Dedupe keys on this much of the (whitespace-normalised) message. */
const KEY_MESSAGE_CHARS = 200;
/**
 * Kinds whose call sites already report once per user action (one failed save,
 * one stuck-selfie streak). Once this long has passed since the last report, the
 * same error again is a NEW action and is sent; only an exact repeat inside the
 * window counts as a duplicate. Every other kind comes from a global handler,
 * where a repeat is the same fault firing again, so it stays suppressed for the
 * rest of the page load.
 */
const ACTION_KINDS: ReadonlySet<string> = new Set(['selfie_stuck', 'download_failed']);
export const ACTION_REPEAT_WINDOW_MS = 30_000;

interface Seen {
  /** When this key's report was last actually sent. */
  sentMs: number;
  /** Occurrences since then, that one included. */
  count: number;
  followupSent: boolean;
}

const seen = new Map<string, Seen>();
let sentThisPage = 0;

/** Test hook: forget everything, as a fresh page load would. */
export function resetClientErrorReporting(): void {
  seen.clear();
  sentThisPage = 0;
  reporting = false;
}

function dedupeKey(kind: string, message: string): string {
  return `${kind}\u0000${message.replace(/\s+/g, ' ').trim().slice(0, KEY_MESSAGE_CHARS)}`;
}

/**
 * Decide whether this occurrence goes out: null drops it, 0 is a first (or
 * fresh-action) report, and a positive number is the repeat count carried by
 * the one follow-up.
 */
function admit(kind: string, message: string, nowMs: number): number | null {
  if (sentThisPage >= MAX_REPORTS_PER_PAGE) return null;
  const key = dedupeKey(kind, message);
  const prev = seen.get(key);
  if (!prev || (ACTION_KINDS.has(kind) && nowMs - prev.sentMs >= ACTION_REPEAT_WINDOW_MS)) {
    seen.set(key, { sentMs: nowMs, count: 1, followupSent: false });
    return 0;
  }
  prev.count += 1;
  if (!prev.followupSent && prev.count >= REPEAT_FOLLOWUP_AT) {
    prev.followupSent = true;
    return prev.count;
  }
  return null;
}

export type ClientErrorKind =
  | 'download_failed'
  | 'unhandled_error'
  | 'unhandled_rejection'
  | 'react_render'
  /** A searcher's selfie has been refused several times running — not a crash,
   *  but someone is stuck and about to give up, which ops wants to know. */
  | 'selfie_stuck'
  | 'client_error';

interface ReportOptions {
  /** Stack trace, if available. */
  stack?: string | undefined;
  /** Small bag of extra diagnostics (counts, sample statuses, …). */
  context?: Record<string, unknown> | undefined;
}

/**
 * Fire-and-forget: report a client-side error. Returns immediately; the POST
 * runs in the background and any failure is silently dropped (we never want
 * error reporting to break the page or spam the console).
 */
export function reportClientError(
  kind: ClientErrorKind,
  message: string,
  opts: ReportOptions = {},
): void {
  if (reporting) return;
  try {
    const text = String(message ?? '').slice(0, 2000) || 'unknown client error';
    const repeats = admit(kind, text, Date.now());
    if (repeats === null) return;
    sentThisPage += 1;
    reporting = true;

    const report: ClientErrorReport = {
      kind,
      message: text,
      ...(opts.stack ? { stack: String(opts.stack).slice(0, 8000) } : {}),
      url: typeof location !== 'undefined' ? location.href.slice(0, 2000) : undefined,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 1000) : undefined,
      ...(opts.context ? { context: opts.context } : {}),
      ...(repeats > 0 ? { repeatCount: repeats } : {}),
    };

    void apiPost('/api/client-errors', report)
      .catch(() => {
        // Intentionally swallow — never let reporting surface its own error.
      })
      .finally(() => {
        reporting = false;
      });
  } catch {
    // Never throw: this runs inside the global error handlers.
    reporting = false;
  }
}

/**
 * Install global handlers for uncaught errors and unhandled promise rejections.
 * Call once at app startup. Errors caught by a React ErrorBoundary are reported
 * separately (the boundary has the component stack).
 */
export function installGlobalErrorReporting(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('error', (e: ErrorEvent) => {
    const err = e.error as Error | undefined;
    reportClientError('unhandled_error', err?.message || e.message || 'window error', {
      stack: err?.stack,
      context: {
        ...(e.filename ? { filename: e.filename } : {}),
        ...(Number.isFinite(e.lineno) ? { lineno: e.lineno } : {}),
        ...(Number.isFinite(e.colno) ? { colno: e.colno } : {}),
      },
    });
  });

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const reason = e.reason as unknown;
    const message =
      reason instanceof Error ? reason.message : String(reason ?? 'unhandled rejection');
    reportClientError('unhandled_rejection', message, {
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
