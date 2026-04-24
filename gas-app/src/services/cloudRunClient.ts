/**
 * cloudRunClient.ts — UrlFetchApp wrapper for the Cloud Run image-convert service.
 *
 * Auth model (recommended approach from spec §7.4):
 *   - Cloud Run IAM requires a Google-signed ID token in Authorization.
 *   - The Drive API inside Cloud Run needs the user's OAuth access token.
 *   - Since both can't share the same header, we send:
 *       Authorization:        Bearer <ID token>    ← Cloud Run IAM gate
 *       X-User-Access-Token:  Bearer <OAuth token> ← Drive calls inside Python
 *
 * The Cloud Run service reads the Drive token from X-User-Access-Token.
 *
 * See UPLOAD_PREP_FEATURE_SPEC.md §4.3 and §7.4 for full specification.
 */

/* global ScriptApp, UrlFetchApp, Logger, Utilities */

import { getCloudRunUrl, isCloudRunConfigured } from '../config/superAdmins';

// ─── Retry policy ─────────────────────────────────────────────────────────────

/**
 * HTTP status codes that indicate a transient upstream failure worth retrying.
 * 429: rate-limited. 500/502/503/504: server/gateway issues.
 * Cloud Run in particular returns 503 briefly while scaling from zero.
 */
const RETRIABLE_STATUS = new Set<number>([429, 500, 502, 503, 504]);

/** Maximum number of attempts (including the first). */
const MAX_ATTEMPTS = 3;

/** Base backoff delay in milliseconds. Doubles on each retry. */
const BASE_BACKOFF_MS = 750;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConvertRequest {
  readonly sourceFileId: string;
  readonly destFolderId: string;
  readonly destName: string;
  readonly jpgQuality: number;
  readonly maxDim: number | null;
  readonly bakeOrientation: boolean;
  readonly preserveExif: boolean;
}

export interface ConvertResponse {
  readonly ok: boolean;
  readonly destFileId?: string;
  readonly destSizeBytes?: number;
  readonly sourceMimeType?: string;
  readonly conversionMs?: number;
  readonly error?: string;
  readonly message?: string;
}

// ─── Client ───────────────────────────────────────────────────────────────────

/**
 * Calls POST /convert on the Cloud Run service and returns the parsed response.
 *
 * Retries up to MAX_ATTEMPTS times with exponential backoff on transient
 * failures (429 and 5xx responses, or UrlFetch exceptions). Non-retriable
 * responses (2xx, 4xx except 429) are returned directly so callers can
 * distinguish fatal vs transient errors via the `error` field in the response
 * envelope (see main.py for the full list: 'unauthorized', 'source_not_found',
 * 'unsupported_format', 'download_failed', 'upload_failed', 'conversion_failed').
 *
 * @throws Never — all errors are surfaced via the returned ConvertResponse.
 */
export function convertImage(req: ConvertRequest): ConvertResponse {
  // Refuse to call the placeholder URL — fail loudly rather than silently
  // 404-ing against a non-existent Cloud Run service.
  if (!isCloudRunConfigured()) {
    Logger.log('[cloudRunClient] CLOUD_RUN_URL is not configured (still placeholder).');
    return {
      ok: false,
      error: 'not_configured',
      message:
        'Cloud Run URL is not configured. Set the CLOUD_RUN_URL Script Property ' +
        'to the deployed image-convert service URL.',
    };
  }

  const url = `${getCloudRunUrl()}/convert`;
  let lastStatus = 0;
  let lastBody = '';
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // ID token for Cloud Run IAM gate (the service is --no-allow-unauthenticated)
      const idToken = ScriptApp.getIdentityToken();
      // User's OAuth token, forwarded to Drive API calls inside Python
      const userToken = ScriptApp.getOAuthToken();

      const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
        method: 'post',
        contentType: 'application/json',
        headers: {
          // Cloud Run IAM verifies this header
          'Authorization': `Bearer ${idToken}`,
          // Python service reads Drive token from this custom header
          'X-User-Access-Token': `Bearer ${userToken}`,
        },
        payload: JSON.stringify(req),
        muteHttpExceptions: true,  // surface non-2xx as response, not exception
      };

      const res = UrlFetchApp.fetch(url, options);
      lastStatus = res.getResponseCode();
      lastBody = res.getContentText();

      // Retry transient upstream failures with exponential backoff.
      if (RETRIABLE_STATUS.has(lastStatus) && attempt < MAX_ATTEMPTS) {
        Logger.log(
          `[cloudRunClient] attempt ${attempt}/${MAX_ATTEMPTS} got HTTP ${lastStatus}; retrying`
        );
        sleep(BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
        continue;
      }

      // Non-retriable status, or we've exhausted retries on a retriable one.
      // If we exhausted retries on a retriable status, synthesize a clear
      // error envelope so callers don't silently treat an empty body as success.
      if (RETRIABLE_STATUS.has(lastStatus)) {
        Logger.log(
          `[cloudRunClient] gave up after ${MAX_ATTEMPTS} retries on HTTP ${lastStatus}`
        );
        return {
          ok: false,
          error: 'internal',
          message: `Cloud Run returned HTTP ${lastStatus} after ${MAX_ATTEMPTS} attempts`,
        };
      }

      // Non-retriable response — parse and return the upstream envelope.
      try {
        return JSON.parse(lastBody) as ConvertResponse;
      } catch {
        Logger.log(
          `[cloudRunClient] Non-JSON response (HTTP ${lastStatus}): ${lastBody.substring(0, 200)}`
        );
        return {
          ok: false,
          error: 'internal',
          message: `Non-JSON response from Cloud Run (HTTP ${lastStatus})`,
        };
      }
    } catch (err) {
      lastErr = err;
      // Network-level exception: retry with backoff.
      if (attempt < MAX_ATTEMPTS) {
        Logger.log(
          `[cloudRunClient] attempt ${attempt}/${MAX_ATTEMPTS} threw: ${String(err)}; retrying`
        );
        sleep(BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
        continue;
      }
    }
  }

  Logger.log(
    `[cloudRunClient] All ${MAX_ATTEMPTS} attempts failed (last status=${lastStatus}, err=${String(lastErr)})`
  );
  return {
    ok: false,
    error: 'internal',
    message:
      lastErr !== null
        ? `Cloud Run request failed after ${MAX_ATTEMPTS} attempts: ${String(lastErr)}`
        : `Cloud Run returned HTTP ${lastStatus} after ${MAX_ATTEMPTS} attempts`,
  };
}

/**
 * Sleep helper — uses Utilities.sleep when available (GAS runtime), falls back
 * to a busy-wait in tests so we don't need to mock the global.
 */
function sleep(ms: number): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u = (globalThis as any).Utilities;
    if (u && typeof u.sleep === 'function') {
      u.sleep(ms);
      return;
    }
  } catch {
    // fall through
  }
  // Fallback — only used in Jest; keeps tests fast by doing a tight busy loop
  // but bounded by ms. In production we'll always go through Utilities.sleep.
  const end = Date.now() + Math.min(ms, 10);
  while (Date.now() < end) { /* spin */ }
}
