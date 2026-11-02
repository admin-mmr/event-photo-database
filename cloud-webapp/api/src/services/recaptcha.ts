/**
 * recaptcha.ts — reCAPTCHA Enterprise verification for the download and
 * Find-Me search actions (dev plan M5.3 / PRD §9). Deters scripted
 * face-probing of the matcher and bulk-signing of originals.
 *
 * Config gate: verification runs only when RECAPTCHA_PROJECT_ID + _SITE_KEY +
 * _API_KEY are all set. Unset → `isRecaptchaConfigured()` is false and the
 * middleware no-ops, so local dev and the demo work without a key.
 *
 * Fail policy: a real bad verdict (invalid token, wrong action, score below
 * RECAPTCHA_MIN_SCORE) is `ok: false`; what the caller does with it depends on
 * RECAPTCHA_MODE (see middleware/recaptcha.ts — shadow logs, enforce blocks).
 * An infra error fails OPEN — a reCAPTCHA outage must not lock real attendees
 * out of finding their photos.
 *
 * Failing open must never be SILENT again. From 2026-10-04 to 2026-11-02 every
 * assessment returned HTTP 400 "API key not valid" (the stored secret was not
 * an API key) and the only trace was a WARN line nobody was alerted on, so the
 * download and Find-Me routes ran with no bot gate for a month. A non-2xx is
 * now classified:
 *   - CONFIG errors (400/401/403/404 — bad key, key restricted to another API,
 *     wrong project) will fail on every request until someone fixes the
 *     config, so they log at ERROR with `alert: 'recaptcha_broken'`, which the
 *     api's ERROR alert policy (and the dedicated
 *     infra/monitoring/recaptcha-broken-alert-policy.json) turns into email.
 *   - TRANSIENT errors (429, 5xx, network) stay at WARN.
 * `recaptchaSelfCheck()` runs the same classification once at startup, so a
 * deploy with a broken key is caught when the revision boots, not when the
 * first attendee happens to search.
 *
 * We call the Enterprise REST `assessments` endpoint with an API key rather
 * than pulling in the @google-cloud client library, to keep the api image lean
 * (Node 18+ global `fetch`). The key goes in the `X-Goog-Api-Key` header, never
 * the `?key=` query string, so it cannot end up in a logged URL.
 */

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';

export interface RecaptchaResult {
  readonly ok: boolean;
  readonly score?: number;
  /** Machine-readable outcome for logs/tests. */
  readonly reason: string;
  /** True when `ok` is only because the assessment itself failed (fail-open). */
  readonly failOpen?: boolean;
}

/** True only when all three reCAPTCHA settings are present. */
export function isRecaptchaConfigured(): boolean {
  const s = recaptchaConfigStatus();
  return s.configured;
}

/**
 * Startup diagnostics: reports which of the three required settings are present.
 * `partial` (some but not all set) is the dangerous state — verification is
 * silently disabled — so callers log it loudly. This exists because a misnamed
 * secret binding (the env var was `RECAPTCHA_KEY`, the code reads
 * `RECAPTCHA_API_KEY`) once left production unprotected without any signal.
 */
export function recaptchaConfigStatus(): {
  readonly configured: boolean;
  readonly partial: boolean;
  readonly present: { projectId: boolean; siteKey: boolean; apiKey: boolean };
} {
  const present = {
    projectId: env.RECAPTCHA_PROJECT_ID.length > 0,
    siteKey: env.RECAPTCHA_SITE_KEY.length > 0,
    apiKey: env.RECAPTCHA_API_KEY.length > 0,
  };
  const count = Number(present.projectId) + Number(present.siteKey) + Number(present.apiKey);
  return { configured: count === 3, partial: count > 0 && count < 3, present };
}

interface AssessmentResponse {
  tokenProperties?: { valid?: boolean; action?: string; invalidReason?: string };
  riskAnalysis?: { score?: number };
}

/**
 * HTTP statuses that mean OUR configuration is wrong (bad/unrestricted-for-this
 * API key, wrong project, API disabled), not that Google had a bad moment.
 * These repeat on every request until a human fixes them.
 */
const CONFIG_ERROR_STATUSES = new Set([400, 401, 403, 404]);

export function isConfigErrorStatus(status: number): boolean {
  return CONFIG_ERROR_STATUSES.has(status);
}

/**
 * Pulls the safe, non-secret bits out of a Google API error body
 * (`error.status`, `error.details[].reason`, a truncated `error.message`) for
 * the log line. Google's error bodies do not echo the API key, but we still
 * take only these fields rather than logging the raw body.
 */
async function describeApiError(resp: Response): Promise<{ status?: string; reason?: string; detail?: string }> {
  try {
    const body = (await resp.json()) as {
      error?: { status?: string; message?: string; details?: Array<{ reason?: string }> };
    };
    const e = body.error;
    if (!e) return {};
    const reason = e.details?.find((d) => typeof d.reason === 'string')?.reason;
    return {
      ...(e.status ? { status: e.status } : {}),
      ...(reason ? { reason } : {}),
      ...(e.message ? { detail: e.message.slice(0, 200) } : {}),
    };
  } catch {
    return {};
  }
}

/** POSTs one assessment. The key rides in a header, never the URL. */
function postAssessment(token: string, expectedAction: string): Promise<Response> {
  const url =
    `https://recaptchaenterprise.googleapis.com/v1/projects/` +
    `${encodeURIComponent(env.RECAPTCHA_PROJECT_ID)}/assessments`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.RECAPTCHA_API_KEY },
    body: JSON.stringify({
      event: { token, siteKey: env.RECAPTCHA_SITE_KEY, expectedAction },
    }),
  });
}

/** Logs a non-2xx at ERROR (config — alerts) or WARN (transient). */
async function logApiFailure(resp: Response, action: string, context: string): Promise<void> {
  const api = await describeApiError(resp);
  if (isConfigErrorStatus(resp.status)) {
    logger.error(
      { alert: 'recaptcha_broken', status: resp.status, action, api },
      `recaptcha ${context}: assessment API rejected our CONFIG (fail-open — bot gate is OFF until fixed)`,
    );
  } else {
    logger.warn({ status: resp.status, action, api }, `recaptcha ${context}: API non-2xx (fail-open)`);
  }
}

/**
 * Verifies a client reCAPTCHA token for a given action. Returns `{ ok: true }`
 * (reason 'disabled') when not configured. Never throws.
 */
export async function verifyRecaptcha(
  token: string | undefined,
  expectedAction: string,
): Promise<RecaptchaResult> {
  if (!isRecaptchaConfigured()) return { ok: true, reason: 'disabled' };
  if (!token) return { ok: false, reason: 'missing_token' };

  try {
    const resp = await postAssessment(token, expectedAction);

    if (!resp.ok) {
      // Infra-level failure → fail open so we don't block real users, but
      // loudly (see the header comment).
      await logApiFailure(resp, expectedAction, 'verify');
      return { ok: true, reason: `http_${resp.status}`, failOpen: true };
    }

    const data = (await resp.json()) as AssessmentResponse;
    const valid = data.tokenProperties?.valid === true;
    const action = data.tokenProperties?.action;
    const score = data.riskAnalysis?.score;
    // Only include `score` in the result when present (exactOptionalPropertyTypes).
    const withScore = score !== undefined ? { score } : {};

    if (!valid) {
      return { ok: false, ...withScore, reason: data.tokenProperties?.invalidReason ?? 'invalid_token' };
    }
    // If the token carries an action, it must match what we expect.
    if (action && action !== expectedAction) {
      return { ok: false, ...withScore, reason: 'action_mismatch' };
    }
    if (typeof score === 'number' && score < env.RECAPTCHA_MIN_SCORE) {
      return { ok: false, ...withScore, reason: 'low_score' };
    }
    return { ok: true, ...withScore, reason: 'ok' };
  } catch (err) {
    // Network/parse error → fail open.
    logger.warn({ err, action: expectedAction }, 'recaptcha verify error (fail-open)');
    return { ok: true, reason: 'verify_error', failOpen: true };
  }
}

export type SelfCheckResult =
  | { readonly state: 'disabled' }
  | { readonly state: 'healthy' }
  | { readonly state: 'broken'; readonly status: number }
  | { readonly state: 'unknown'; readonly status?: number };

/**
 * Startup self-check: sends one assessment with a deliberately bogus token.
 * A working key + project answers 200 (with `valid: false`, which is expected
 * and fine); a broken key answers 400/403 — exactly the month-long silent
 * failure. Logs ERROR (`alert: 'recaptcha_broken'`) on a config failure so the
 * revision that shipped it is flagged as it boots. Costs one assessment per
 * instance start. Never throws, never blocks startup.
 */
export async function recaptchaSelfCheck(): Promise<SelfCheckResult> {
  if (!isRecaptchaConfigured()) return { state: 'disabled' };
  try {
    const resp = await postAssessment('startup-self-check', 'self_check');
    if (resp.ok) {
      logger.info({ mode: env.RECAPTCHA_MODE, minScore: env.RECAPTCHA_MIN_SCORE }, 'recaptcha self-check passed');
      return { state: 'healthy' };
    }
    await logApiFailure(resp, 'self_check', 'self-check');
    return isConfigErrorStatus(resp.status)
      ? { state: 'broken', status: resp.status }
      : { state: 'unknown', status: resp.status };
  } catch (err) {
    logger.warn({ err }, 'recaptcha self-check could not reach the API (inconclusive)');
    return { state: 'unknown' };
  }
}
