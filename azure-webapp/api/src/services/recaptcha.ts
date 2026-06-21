/**
 * recaptcha.ts — reCAPTCHA Enterprise verification for the upload/search action
 * (dev plan M5.3 / PRD §9). Deters scripted face-probing of the matcher.
 *
 * Config gate: verification runs only when RECAPTCHA_PROJECT_ID + _SITE_KEY +
 * _API_KEY are all set. Unset → `isRecaptchaConfigured()` is false and the
 * middleware no-ops, so local dev and the demo work without a key.
 *
 * Fail policy: we fail CLOSED on a real bad verdict (invalid token, wrong
 * action, score below RECAPTCHA_MIN_SCORE) but fail OPEN on an infra error
 * (network blip, non-2xx from the API) — a reCAPTCHA outage must not lock real
 * attendees out of finding their photos. Both paths are logged.
 *
 * We call the Enterprise REST `assessments` endpoint with an API key rather
 * than pulling in the @google-cloud client library, to keep the api image lean
 * (Node 18+ global `fetch`).
 */

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';

export interface RecaptchaResult {
  readonly ok: boolean;
  readonly score?: number;
  /** Machine-readable outcome for logs/tests. */
  readonly reason: string;
}

/** True only when all three reCAPTCHA settings are present. */
export function isRecaptchaConfigured(): boolean {
  return (
    env.RECAPTCHA_PROJECT_ID.length > 0 &&
    env.RECAPTCHA_SITE_KEY.length > 0 &&
    env.RECAPTCHA_API_KEY.length > 0
  );
}

interface AssessmentResponse {
  tokenProperties?: { valid?: boolean; action?: string; invalidReason?: string };
  riskAnalysis?: { score?: number };
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

  const url =
    `https://recaptchaenterprise.googleapis.com/v1/projects/${env.RECAPTCHA_PROJECT_ID}` +
    `/assessments?key=${env.RECAPTCHA_API_KEY}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: { token, siteKey: env.RECAPTCHA_SITE_KEY, expectedAction },
      }),
    });

    if (!resp.ok) {
      // Infra-level failure → fail open so we don't block real users.
      logger.warn({ status: resp.status, action: expectedAction }, 'recaptcha API non-2xx (fail-open)');
      return { ok: true, reason: `http_${resp.status}` };
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
    return { ok: true, reason: 'verify_error' };
  }
}
