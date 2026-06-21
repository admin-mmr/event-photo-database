/**
 * sheetsService.ts — read AND write the master Google Sheet via the Sheets API
 * (dev plan §8 "Sync with Drive" reconciler; volunteer Upload_Log writes).
 *
 * Auth = the same keyless domain-wide delegation as driveService.ts (runbook
 * §G1): sign a JWT as the DWD-enabled SA (indexer-runtime@) with
 * `sub=<workspace user>`, exchange it for an access token. No SA keys.
 *
 * Scope: this mints a token for the read/WRITE `spreadsheets` scope (NOT
 * `drive.readonly`). G1 authorized the `drive` scope for the DWD client; the
 * Sheets scope must be added to the SAME client id in the Workspace Admin
 * console (one-time):
 *
 *     https://www.googleapis.com/auth/spreadsheets
 *
 * This single scope covers both `values.get` (reads — reconciler, link
 * validation) and `values.append` (writes — Upload_Log). It supersedes the old
 * `spreadsheets.readonly`; authorizing just this one is sufficient. Until it
 * propagates, `values.get`/`values.append` return 403 PERMISSION_DENIED.
 *
 * Token caching is per-scope, so this does not collide with driveService's
 * Drive-scoped token cache.
 */

import { GoogleAuth } from 'google-auth-library';
import { env } from '../lib/config.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Read/write scope — covers both values.get and values.append. Add THIS exact
// scope to the DWD client id in the Workspace Admin console.
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

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

  const client = await auth.getClient();
  const signRes = await client.request<{ signedJwt: string }>({
    url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:signJwt`,
    method: 'POST',
    data: { payload: claims },
  });

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: signRes.data.signedJwt,
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

/**
 * Append one or more rows to a sheet via `spreadsheets.values.append`.
 *
 * `range` is an A1 range that anchors the table the API appends to — pass the
 * whole tab (e.g. `Upload_Log!A1`) and the API finds the first empty row after
 * the existing data and writes there (`insertDataOption=INSERT_ROWS`). Values
 * are sent `RAW` so strings/numbers land verbatim (no formula/date coercion).
 *
 * Requires the read/WRITE `spreadsheets` scope on the DWD client (see header).
 * Returns the number of rows the API reported updated.
 */
export async function appendSheetValues(
  spreadsheetId: string,
  range: string,
  rows: unknown[][],
  opts?: { token?: string },
): Promise<number> {
  if (rows.length === 0) return 0;
  const token = opts?.token ?? (await getSheetsToken());
  const params = new URLSearchParams({
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
  });
  const url = `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?${params}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
  });
  if (!res.ok) {
    throw new Error(`Sheets API append ${res.status} on '${range}': ${await res.text()}`);
  }
  const json = (await res.json()) as { updates?: { updatedRows?: number } };
  return json.updates?.updatedRows ?? 0;
}
