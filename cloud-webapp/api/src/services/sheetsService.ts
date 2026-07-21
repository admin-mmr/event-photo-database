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

import { env } from '../lib/config.js';
import { mintDwdToken } from '../lib/googleCredentials.js';
import { sleep } from './driveRateLimit.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

// Sheets has tight per-user quotas (all our calls share one DWD subject), so a
// burst — e.g. a managed-folders rebuild upserting many Special_Folders rows —
// can hit 429 RESOURCE_EXHAUSTED. Retry transient 429/5xx with backoff (honour
// Retry-After) so we slow down instead of failing. Tunable via SHEETS_MAX_RETRIES.
const SHEETS_MAX_RETRIES = Math.max(0, Number(process.env.SHEETS_MAX_RETRIES ?? 5));

async function sheetsFetch(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if ((res.status === 429 || res.status >= 500) && attempt < SHEETS_MAX_RETRIES) {
      const ra = Number(res.headers.get('retry-after'));
      const delay = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : Math.min(32_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 1000);
      await sleep(delay);
      continue;
    }
    return res;
  }
}
// Read/write scope — covers both values.get and values.append. Add THIS exact
// scope to the DWD client id in the Workspace Admin console.
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** Mint (and cache) a Sheets access token via keyless DWD. */
export function getSheetsToken(): Promise<string> {
  return mintDwdToken({ scope: SCOPE, subject: env.DWD_SUBJECT });
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
  const res = await sheetsFetch(url, { headers: { Authorization: `Bearer ${token}` } });
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
  const res = await sheetsFetch(url, {
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

/**
 * Overwrite an exact range in place via `spreadsheets.values.update` — used for
 * row edits (deactivate user, revoke/rotate link, etc.) where we already know
 * the row number from a prior read.
 *
 * `range` is an A1 range that EXACTLY spans the cells written, e.g.
 * `Users!A7:K7` to rewrite the 7th sheet row. Values are sent `RAW`. Pass fewer
 * cells than the range width and the API errors, so size the range to the row.
 *
 * Requires the read/WRITE `spreadsheets` scope on the DWD client (see header).
 * Returns the number of cells the API reported updated.
 */
export async function updateSheetValues(
  spreadsheetId: string,
  range: string,
  rows: unknown[][],
  opts?: { token?: string },
): Promise<number> {
  const token = opts?.token ?? (await getSheetsToken());
  const params = new URLSearchParams({ valueInputOption: 'RAW' });
  const url = `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${params}`;
  const res = await sheetsFetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
  });
  if (!res.ok) {
    throw new Error(`Sheets API update ${res.status} on '${range}': ${await res.text()}`);
  }
  const json = (await res.json()) as { updatedCells?: number };
  return json.updatedCells ?? 0;
}

/**
 * List the tab (sheet) titles in a spreadsheet via `spreadsheets.get` with a
 * field mask. Used to decide whether a tab needs creating before writing.
 */
export async function getSheetTitles(spreadsheetId: string, opts?: { token?: string }): Promise<string[]> {
  const token = opts?.token ?? (await getSheetsToken());
  const url = `${SHEETS}/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`;
  const res = await sheetsFetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets API get ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { sheets?: Array<{ properties?: { title?: string } }> };
  return (json.sheets ?? []).map((s) => String(s.properties?.title ?? '')).filter(Boolean);
}

/**
 * Ensure a tab named `title` exists, creating it via `batchUpdate { addSheet }`
 * if absent. Idempotent — a no-op when the tab is already present. Returns true
 * when it created the tab. Requires the read/write `spreadsheets` scope.
 */
export async function ensureSheetTab(
  spreadsheetId: string,
  title: string,
  opts?: { token?: string },
): Promise<boolean> {
  const token = opts?.token ?? (await getSheetsToken());
  const titles = await getSheetTitles(spreadsheetId, { token });
  if (titles.includes(title)) return false;
  const url = `${SHEETS}/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
  const res = await sheetsFetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });
  // A concurrent create loses the race with 400 "already exists" — treat as fine.
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 && body.toLowerCase().includes('already exists')) return false;
    throw new Error(`Sheets API addSheet ${res.status} on '${title}': ${body}`);
  }
  return true;
}

/**
 * Clear a tab's cell contents via `values.clear` (keeps formatting/frozen rows).
 * Used by the public folder-index writer before rewriting a tab wholesale.
 */
export async function clearSheetValues(
  spreadsheetId: string,
  range: string,
  opts?: { token?: string },
): Promise<void> {
  const token = opts?.token ?? (await getSheetsToken());
  const url = `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:clear`;
  const res = await sheetsFetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets API clear ${res.status} on '${range}': ${await res.text()}`);
}
