/**
 * drivePermissionsService.ts — grant "Anyone with the link → Viewer" on a Drive
 * folder (or file). Cloud-webapp port of the gas-app module.
 *
 * The public-browse surface for uploaded media is the Drive folder hierarchy —
 * the Photos_NNN buckets and per-(event,club,tag) Videos/Album folders the
 * managed-folders rebuild creates. To make those reachable by non-signed-in
 * viewers we flip them to anyone/reader via Drive's permissions.create.
 *
 * A file can hold at most ONE `type=anyone` permission, and Drive returns 200 on
 * a REPEAT create rather than a 400 "duplicate" — so we can't tell a fresh share
 * from a re-share by status alone. We probe the permission list first and
 * short-circuit to outcome='exists' (no write, no log) when already shared, which
 * keeps repeated rebuilds quiet and quota-cheap. All calls are paced + retried by
 * driveFetch. Errors are never thrown — sharing is a convenience layer.
 */

import { getDriveToken, DRIVE_SCOPE_READWRITE } from './driveService.js';
import { DRIVE_API_BASE } from './driveShortcutClient.js';
import { driveFetch } from './driveRateLimit.js';
import { logger } from '../lib/logger.js';

export interface GrantPermissionResult {
  readonly ok: boolean;
  readonly permissionId?: string;
  readonly outcome: 'created' | 'exists' | 'error';
  readonly error?: string;
  readonly status: number;
}

export interface BatchGrantSummary {
  readonly created: number;
  readonly alreadyShared: number;
  readonly errors: number;
  readonly errorSample: ReadonlyArray<string>;
}

export const EMPTY_BATCH_GRANT_SUMMARY: BatchGrantSummary = {
  created: 0,
  alreadyShared: 0,
  errors: 0,
  errorSample: [],
};

const authHeaders = (tok: string): Record<string, string> => ({ Authorization: `Bearer ${tok}` });

/**
 * True iff `fileId` already carries an "anyone" grant of read or better.
 * Returns null when the probe itself fails, so the caller falls back to
 * attempting the create rather than wrongly assuming "not shared".
 */
async function hasAnyoneReadPermission(fileId: string, tok: string): Promise<boolean | null> {
  const url =
    `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions` +
    `?supportsAllDrives=true&fields=permissions(type,role)`;
  try {
    const res = await driveFetch(url, { headers: authHeaders(tok) }, 'hasAnyoneReadPermission');
    if (!res.ok) return null;
    const parsed = (await res.json()) as { permissions?: Array<{ type?: string; role?: string }> };
    return (parsed.permissions ?? []).some(
      (p) => p.type === 'anyone' && (p.role === 'reader' || p.role === 'writer' || p.role === 'owner'),
    );
  } catch {
    return null;
  }
}

/** Grants "Anyone with the link → Viewer" on `fileId`. Idempotent. */
export async function grantAnyoneRead(fileId: string, opts?: { token?: string }): Promise<GrantPermissionResult> {
  if (!fileId || !fileId.trim()) {
    return { ok: false, outcome: 'error', status: 0, error: 'fileId is required' };
  }
  const tok = opts?.token ?? (await getDriveToken(DRIVE_SCOPE_READWRITE));

  if ((await hasAnyoneReadPermission(fileId, tok)) === true) {
    return { ok: true, outcome: 'exists', status: 200 };
  }

  const url =
    `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions` +
    `?supportsAllDrives=true&sendNotificationEmail=false&fields=id`;
  const body = { role: 'reader', type: 'anyone', allowFileDiscovery: false };

  let status = 0;
  let text = '';
  try {
    const res = await driveFetch(
      url,
      { method: 'POST', headers: { ...authHeaders(tok), 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      'grantAnyoneRead',
    );
    status = res.status;
    text = await res.text();
  } catch (err) {
    return { ok: false, outcome: 'error', status: 0, error: String(err) };
  }

  if (status >= 200 && status < 300) {
    let permissionId: string | undefined;
    try {
      permissionId = (JSON.parse(text) as { id?: string }).id;
    } catch {
      /* 2xx with non-JSON body — harmless */
    }
    return permissionId
      ? { ok: true, outcome: 'created', permissionId, status }
      : { ok: true, outcome: 'created', status };
  }

  const lower = text.toLowerCase();
  if (status === 400 && (lower.includes('duplicate') || lower.includes('exist'))) {
    return { ok: true, outcome: 'exists', status };
  }
  return { ok: false, outcome: 'error', status, error: `HTTP ${status}: ${text.slice(0, 300)}` };
}

/** Best-effort variant for hot paths: swallows errors, only logs. */
export async function tryGrantAnyoneRead(fileId: string, opts?: { token?: string }): Promise<GrantPermissionResult> {
  const result = await grantAnyoneRead(fileId, opts);
  if (!result.ok) {
    logger.warn({ fileId, error: result.error }, 'drivePermissions: share failed (non-fatal)');
  }
  return result;
}

/** Folds a grant result into a running summary (errorSample capped at 20). */
export function foldBatchGrantSummary(
  prev: BatchGrantSummary,
  result: GrantPermissionResult,
  context?: string,
): BatchGrantSummary {
  if (result.outcome === 'created') return { ...prev, created: prev.created + 1 };
  if (result.outcome === 'exists') return { ...prev, alreadyShared: prev.alreadyShared + 1 };
  const message = context ? `${context}: ${result.error ?? 'unknown error'}` : result.error ?? 'unknown error';
  return {
    ...prev,
    errors: prev.errors + 1,
    errorSample: prev.errorSample.length < 20 ? [...prev.errorSample, message] : prev.errorSample,
  };
}
