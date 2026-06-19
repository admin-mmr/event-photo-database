/**
 * sheetsService.ts — read the master Google Sheet via the Sheets API
 * (dev plan §8 "Sync with Drive" reconciler).
 *
 * Auth = the same keyless domain-wide delegation as driveService.ts (runbook
 * §G1): sign a JWT as the DWD-enabled SA (indexer-runtime@) with
 * `sub=<workspace user>`, exchange it for an access token. No SA keys.
 *
 * Scope difference: this mints a token for `spreadsheets.readonly` rather than
 * `drive.readonly`. G1 authorized the `drive` scope for the DWD client; the
 * Sheets scope must be added to the SAME client id in the Workspace Admin
 * console (one-time). Until then `values.get` returns 403 PERMISSION_DENIED.
 *
 * Token caching is per-scope, so this does not collide with driveService's
 * Drive-scoped token cache.
 */

import { GoogleAuth } from 'google-auth-library';
import { env } from '../lib/config.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

let cached: { token: string; expiresAt: number } | null = null;

/** Mint (and cache) a Sheets access token via keyless DWD. */
export async function getSheetsToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const sa = env.DWD_SA;
  const now = Math.floor(Date.now() / 1000);
  const claims = JSON.stringify({
    iss: sa,
    sub: env.DWD_SUBJECT,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });

  // Sign the JWT via Node's native fetch, NOT client.request (gaxios → node-fetch@2),
  // which throws a spurious "Premature close" on Node 18+ when iamcredentials closes
  // the connection — that 500'd /api/admin/sync. The token exchange below already
  // uses native fetch, so this keeps the whole mint path on one HTTP client.
  const client = await auth.getClient();
  const accessToken = (await client.getAccessToken()).token;
  const signResp = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:signJwt`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: claims }),
    },
  );
  if (!signResp.ok) {
    throw new Error(`signJwt failed: ${signResp.status} ${await signResp.text()}`);
  }
  const { signedJwt } = (await signResp.json()) as { signedJwt: string };

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: signedJwt,
  });
  const tokenRes = await fetch(TOKEN_URL, { method: 'POST', body });
  if (!tokenRes.ok) {
    throw new Error(`DWD token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const json = (await tokenRes.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cached.token;
}

/**
 * Read a rectangular range from a sheet via `spreadsheets.values.get`.
 * Returns the raw rows (`values`), each a string[] of cell values; absent /
 * empty rows are omitted by the API and short rows are not right-padded.
 *
 * `range` is A1 notation, e.g. `Events!A2:G`. Pass `token` explicitly in tests.
 */
export async function getSheetValues(
  spreadsheetId: string,
  range: string,
  opts?: { token?: string },
): Promise<string[][]> {
  const token = opts?.token ?? (await getSheetsToken());
  const params = new URLSearchParams({
    majorDimension: 'ROWS',
    // Render formula results as plain strings (dates as the displayed text).
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const url = `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Sheets API ${res.status} on '${range}': ${await res.text()}`);
  }
  const json = (await res.json()) as { values?: string[][] };
  return json.values ?? [];
}
