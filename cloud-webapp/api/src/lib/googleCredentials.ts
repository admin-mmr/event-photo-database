/**
 * googleCredentials.ts — the ONE place the api obtains Google credentials.
 *
 * Every other module went through its own `new GoogleAuth(...)`; that made the
 * cloud coupling diffuse and impossible to swap. This module centralises it
 * behind a small set of operations and a provider switch (AZURE_MIGRATION_DEV_
 * PLAN.md AZ1):
 *
 *   - CLOUD_PROVIDER=gcp   → metadata server / ADC (keyless on Cloud Run). This
 *                            is today's behaviour, byte-for-byte.
 *   - CLOUD_PROVIDER=azure → an explicit service-account key (GOOGLE_SA_KEY_JSON)
 *                            since there is no Google metadata server off GCP.
 *                            Google Workspace (Sheets/Drive/Gmail) and the Google
 *                            project stay — only the way we authenticate to them
 *                            changes.
 *
 * Three credential shapes live here, matching how the app talks to Google:
 *   1. mintDwdToken       — keyless domain-wide-delegation access tokens
 *                           (Drive/Sheets/Gmail), signing a JWT as the DWD SA.
 *   2. getIdTokenHeaders  — OIDC ID tokens for private Cloud Run services
 *                           (matcher, image-convert). Skipped off GCP / on http.
 *   3. getAccessToken /   — a plain cloud-platform token / authenticated client
 *      getAuthedClient      for GCP REST APIs (Cloud Tasks, Cloud Run Jobs).
 *
 * The signing round-trip (iamcredentials signJwt) is identical in both modes:
 * on GCP the runtime SA holds signJwt on the DWD SA; on Azure the SA key IS the
 * DWD SA, which may sign for itself.
 */

import { GoogleAuth, type AuthClient, type JWTInput } from 'google-auth-library';
import { env } from './config.js';

const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Parsed GOOGLE_SA_KEY_JSON, or null on GCP where ADC is keyless. Computed once;
 * a malformed key fails loudly here rather than as a confusing 401 later.
 */
let _saKey: Record<string, unknown> | null | undefined;
export function serviceAccountKey(): Record<string, unknown> | null {
  if (_saKey !== undefined) return _saKey;
  const raw = env.GOOGLE_SA_KEY_JSON;
  if (!raw) {
    _saKey = null;
    return _saKey;
  }
  try {
    _saKey = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('GOOGLE_SA_KEY_JSON is set but is not valid JSON');
  }
  return _saKey;
}

/**
 * The single shared GoogleAuth. Scoped to cloud-platform (the widest scope any
 * caller needs; ID-token minting ignores scopes). On GCP this resolves ADC from
 * the metadata server; on Azure it is built from the explicit SA key.
 */
let _auth: GoogleAuth | null = null;
function baseAuth(): GoogleAuth {
  if (_auth) return _auth;
  const key = serviceAccountKey();
  _auth = new GoogleAuth({
    scopes: [CLOUD_PLATFORM],
    ...(key ? { credentials: key as unknown as JWTInput } : {}),
  });
  return _auth;
}

/** An authenticated client for direct GCP REST calls (`client.request(...)`). */
export function getAuthedClient(): Promise<AuthClient> {
  return baseAuth().getClient();
}

/** A cloud-platform access token (Cloud Tasks / Cloud Run Jobs REST). */
export async function getAccessToken(): Promise<string> {
  const client = await baseAuth().getClient();
  const resp = await client.getAccessToken();
  const token = typeof resp === 'string' ? resp : resp.token;
  if (!token) throw new Error('could not mint a cloud-platform access token');
  return token;
}

/**
 * The Google Cloud project id. From GCP_PROJECT_ID when set; otherwise the
 * metadata server (GCP only). Off GCP the env var is required (enforced in
 * config), so this never falls through to a metadata lookup that would hang.
 */
export async function getProjectId(): Promise<string> {
  if (env.GCP_PROJECT_ID) return env.GCP_PROJECT_ID;
  if (env.CLOUD_PROVIDER === 'azure') {
    throw new Error('GCP_PROJECT_ID must be set explicitly when CLOUD_PROVIDER=azure');
  }
  return baseAuth().getProjectId();
}

/**
 * Sign a JWT as `sa` via iamcredentials:signJwt using the base credentials.
 * The signing principal differs by provider but the call is the same.
 */
async function signJwt(sa: string, payload: string): Promise<string> {
  const client = await baseAuth().getClient();
  const res = await client.request<{ signedJwt: string }>({
    url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:signJwt`,
    method: 'POST',
    data: { payload },
  });
  return res.data.signedJwt;
}

/**
 * Access-token cache for DWD tokens, keyed by SA + impersonated subject + scope
 * so the Drive read/write scopes, the Sheets scope and the Gmail subject never
 * clobber each other (previously each service kept its own cache).
 */
const dwdCache = new Map<string, { token: string; expiresAt: number }>();

export interface DwdTokenOptions {
  /** OAuth scope to request, e.g. the Drive / Sheets / gmail.send scope. */
  scope: string;
  /** Workspace user to impersonate (the DWD `sub`). */
  subject: string;
  /** DWD-enabled service account to sign as. Defaults to env.DWD_SA. */
  sa?: string;
}

/**
 * Mint (and cache) a Google access token via keyless domain-wide delegation:
 * sign a JWT as the DWD SA impersonating `subject`, exchange it for a
 * scoped access token. Used for Drive, Sheets and Gmail.
 */
export async function mintDwdToken(opts: DwdTokenOptions): Promise<string> {
  const sa = opts.sa ?? env.DWD_SA;
  const key = `${sa}|${opts.subject}|${opts.scope}`;
  const hit = dwdCache.get(key);
  if (hit && Date.now() < hit.expiresAt - 60_000) return hit.token;

  const now = Math.floor(Date.now() / 1000);
  const claims = JSON.stringify({
    iss: sa,
    sub: opts.subject,
    scope: opts.scope,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });
  const signedJwt = await signJwt(sa, claims);

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: signedJwt,
  });
  const res = await fetch(TOKEN_URL, { method: 'POST', body });
  if (!res.ok) {
    throw new Error(`DWD token exchange failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  dwdCache.set(key, { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 });
  return json.access_token;
}

/**
 * Authorization headers carrying an OIDC ID token for a private Cloud Run
 * service (`audience` = the service URL). Returns `{}` — no token — when:
 *   - `requestUrl` is plain http (a local dev matcher/convert service), or
 *   - CLOUD_PROVIDER=azure, where these services sit behind internal ingress
 *     over plain HTTP and are not IAM-gated.
 * Callers pass both the audience and the concrete request URL (they can differ
 * only in path); the http/provider check keys off the request URL.
 */
export async function getIdTokenHeaders(
  audience: string,
  requestUrl: string,
): Promise<Record<string, string>> {
  if (requestUrl.startsWith('http://') || env.CLOUD_PROVIDER === 'azure') return {};
  const client = await baseAuth().getIdTokenClient(audience);
  const headers = await client.getRequestHeaders(requestUrl);
  return Object.fromEntries(Object.entries(headers));
}

/** Test-only: drop cached credentials/state so a fresh provider takes effect. */
export function __resetForTests(): void {
  _auth = null;
  _saKey = undefined;
  dwdCache.clear();
}
