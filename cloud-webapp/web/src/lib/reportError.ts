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
 */

import { apiPost } from './api.js';
import type { ClientErrorReport } from '@cloud-webapp/shared';

/** True while a report is in flight, so a failure inside reporting can't recurse. */
let reporting = false;

export type ClientErrorKind =
  | 'download_failed'
  | 'unhandled_error'
  | 'unhandled_rejection'
  | 'react_render'
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
  reporting = true;

  const report: ClientErrorReport = {
    kind,
    message: String(message ?? '').slice(0, 2000) || 'unknown client error',
    ...(opts.stack ? { stack: String(opts.stack).slice(0, 8000) } : {}),
    url: typeof location !== 'undefined' ? location.href.slice(0, 2000) : undefined,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 1000) : undefined,
    ...(opts.context ? { context: opts.context } : {}),
  };

  void apiPost('/api/client-errors', report)
    .catch(() => {
      // Intentionally swallow — never let reporting surface its own error.
    })
    .finally(() => {
      reporting = false;
    });
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
