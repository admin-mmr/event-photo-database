/**
 * imageConvertClient.ts — call the Cloud Run image-convert service to
 * materialise a non-JPEG photo (PNG/HEIC/WEBP) as a real JPG inside a Drive
 * folder. Cloud-webapp port of the gas-app cloudRunClient.
 *
 * Auth (two tokens, mirrors gas-app §7.4):
 *   - Authorization: Bearer <ID token>     — Cloud Run IAM gate (the service is
 *     deployed --no-allow-unauthenticated). Minted for audience=IMAGE_CONVERT_URL
 *     via google-auth-library (keyless on Cloud Run via the metadata server),
 *     the same pattern as matcherClient.
 *   - X-User-Access-Token: Bearer <Drive token> — the Python service uses this to
 *     read the source file and upload the converted JPG into Drive. We forward
 *     the keyless DWD read/write Drive token (the cloud-webapp analogue of the
 *     gas-app user's OAuth token).
 *
 * Storage-minimizing policy: this is only called for NON-JPEG sources. JPEGs are
 * linked as shortcuts (no real copy), and when IMAGE_CONVERT_URL is empty (or a
 * convert fails) the rebuild falls back to a shortcut for that one photo too.
 *
 * Never throws — all outcomes are surfaced via the returned ConvertResponse, so
 * the rebuild engine can collect soft errors into its warnings[].
 */

import { GoogleAuth } from 'google-auth-library';

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { getDriveToken, DRIVE_SCOPE_READWRITE } from './driveService.js';
import { sleep } from './driveRateLimit.js';

const auth = new GoogleAuth();

const RETRIABLE_STATUS = new Set<number>([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 750;

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

/** True when the convert service is configured (else non-JPEG → shortcut fallback). */
export function isImageConvertConfigured(): boolean {
  return Boolean(env.IMAGE_CONVERT_URL && env.IMAGE_CONVERT_URL.trim());
}

async function idTokenHeaders(url: string): Promise<Record<string, string>> {
  if (url.startsWith('http://')) return {}; // local dev convert service — no IAM
  const client = await auth.getIdTokenClient(env.IMAGE_CONVERT_URL);
  const headers = await client.getRequestHeaders(url);
  return Object.fromEntries(Object.entries(headers));
}

/**
 * POST /convert on the image-convert service. Retries 429/5xx (Cloud Run returns
 * 503 briefly while scaling from zero) with exponential backoff. Non-retriable
 * responses are returned as-is so the caller sees the upstream error envelope.
 */
export async function convertImage(req: ConvertRequest): Promise<ConvertResponse> {
  if (!isImageConvertConfigured()) {
    return {
      ok: false,
      error: 'not_configured',
      message: 'IMAGE_CONVERT_URL is not set — non-JPEG photos will fall back to shortcuts.',
    };
  }

  const url = `${env.IMAGE_CONVERT_URL.replace(/\/$/, '')}/convert`;

  let driveToken: string;
  let idHeaders: Record<string, string>;
  try {
    [driveToken, idHeaders] = await Promise.all([getDriveToken(DRIVE_SCOPE_READWRITE), idTokenHeaders(url)]);
  } catch (err) {
    return { ok: false, error: 'auth_failed', message: `convert auth failed: ${String(err)}` };
  }

  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          ...idHeaders,
          'X-User-Access-Token': `Bearer ${driveToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(req),
      });
      lastStatus = res.status;
      const text = await res.text();

      if (RETRIABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      if (RETRIABLE_STATUS.has(res.status)) {
        return { ok: false, error: 'internal', message: `image-convert HTTP ${res.status} after ${MAX_ATTEMPTS} attempts` };
      }
      try {
        return JSON.parse(text) as ConvertResponse;
      } catch {
        return { ok: false, error: 'internal', message: `Non-JSON response (HTTP ${res.status})` };
      }
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        logger.warn({ err, attempt }, 'image-convert request threw; retrying');
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      return { ok: false, error: 'internal', message: `image-convert request failed: ${String(err)}` };
    }
  }
  return { ok: false, error: 'internal', message: `image-convert HTTP ${lastStatus} after ${MAX_ATTEMPTS} attempts` };
}
