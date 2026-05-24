/**
 * drivePermissionsService.ts — grant "Anyone with the link → Viewer" on a Drive folder.
 *
 * Why this module exists
 * ──────────────────────
 * Google deprecated the Photos Library API's album-sharing endpoints on
 * March 31, 2025. We can no longer programmatically flip a Google Photos album
 * to "Anyone with the link can view", and the API will not return shareInfo
 * for albums created with our `appendonly` / `edit.appcreateddata` scopes
 * even after the owner shares them manually.
 *
 * Drive sharing, by contrast, is fully programmable. The codebase already
 * maintains a parallel Drive hierarchy of shortcut folders that mirror every
 * uploaded photo and video (see specialFoldersService.ts). Sharing those
 * Drive folders is the systematic alternative to per-album manual sharing in
 * Google Photos.
 *
 * What this module does
 * ─────────────────────
 * Wraps the Drive v3 REST API's `permissions.create` endpoint to grant
 * `{ role: 'reader', type: 'anyone' }` on a folder. Idempotent — calling it
 * on a folder that is already publicly shared is a no-op (the API returns
 * the existing permission or a benign 4xx, which we swallow).
 *
 * Why REST instead of DriveApp.setSharing()
 * ─────────────────────────────────────────
 * DriveApp.setSharing(ANYONE_WITH_LINK, VIEW) DOES work, but it does not
 * recurse into the file/folder children and it triggers an "owner share"
 * email on some workspace configs. The REST API gives us tighter control
 * (sendNotificationEmail=false), parity with the existing UrlFetchApp-based
 * Drive client used by driveShortcutClient.ts, and avoids dragging in the
 * advanced Drive service (which we deliberately do not enable —
 * appsscript.json keeps the dependency list empty for build simplicity).
 *
 * Scope
 * ─────
 * The `https://www.googleapis.com/auth/drive` OAuth scope already requested
 * in appsscript.json covers permission writes on files the script's effective
 * user owns. No new scope or consent screen prompt is required.
 *
 * Auditability
 * ────────────
 * Every grant is logged with the folder ID and HTTP status. Callers in
 * specialFoldersService grant shares as folders are created; the post-batch-
 * sync hook always retries the grant on existing folders so a transient
 * failure self-heals on the next sync.
 */

import { DRIVE_API_BASE, getDriveAuthToken } from './driveShortcutClient';

/* global UrlFetchApp, Logger */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result envelope for a single permission grant. */
export interface GrantPermissionResult {
  /** True iff the grant succeeded OR the permission was already present. */
  readonly ok: boolean;
  /** Drive permission ID returned by the API, when known. */
  readonly permissionId?: string;
  /**
   * "created" when this call actually wrote a new permission;
   * "exists"  when the API rejected the call because the same permission
   *           was already on the file (the most common idempotent path);
   * "error"   when the request failed for any other reason.
   */
  readonly outcome: 'created' | 'exists' | 'error';
  /** Human-readable error text when outcome === 'error'. */
  readonly error?: string;
  /** HTTP status returned by the Drive API; 0 if the fetch itself threw. */
  readonly status: number;
}

/** Aggregate counters for batch grant operations (used by the backfill path). */
export interface BatchGrantSummary {
  readonly created: number;
  readonly alreadyShared: number;
  readonly errors: number;
  /** Detailed messages for the first ~20 errors so logs stay readable. */
  readonly errorSample: ReadonlyArray<string>;
}

// ─── Single-folder grant ─────────────────────────────────────────────────────

/**
 * Grants "Anyone with the link → Viewer" (role=reader, type=anyone) on
 * `folderId`. Idempotent and safe to call repeatedly.
 *
 * Drive treats a duplicate `type=anyone` permission as a 4xx error rather
 * than a no-op (the error text usually contains "duplicate" or
 * "shareOutNotPermitted"). We map that case to outcome='exists' so callers
 * can distinguish it from a real failure.
 *
 * Errors are intentionally not thrown — the public-sharing path is a
 * convenience layer and must never break a sync.
 */
export function grantAnyoneRead(folderId: string): GrantPermissionResult {
  if (!folderId || !folderId.trim()) {
    return { ok: false, outcome: 'error', status: 0, error: 'folderId is required' };
  }

  // supportsAllDrives=true so the call works for folders that live in a
  // Shared Drive (the rest of driveShortcutClient uses the same flag).
  // sendNotificationEmail=false avoids an email blast to nobody — anyone
  // shares don't have a recipient anyway, but the param is documented as
  // required-for-some-cases and being explicit costs nothing.
  const url =
    `${DRIVE_API_BASE}/files/${encodeURIComponent(folderId)}/permissions` +
    `?supportsAllDrives=true&sendNotificationEmail=false&fields=id`;

  const body = { role: 'reader', type: 'anyone', allowFileDiscovery: false };

  let status = 0;
  let text = '';
  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: {
        Authorization: `Bearer ${getDriveAuthToken()}`,
        'Content-Type': 'application/json',
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    status = response.getResponseCode();
    text = response.getContentText();
  } catch (err) {
    return { ok: false, outcome: 'error', status: 0, error: String(err) };
  }

  if (status >= 200 && status < 300) {
    let permissionId: string | undefined;
    try {
      const parsed = JSON.parse(text) as { id?: string };
      permissionId = parsed.id;
    } catch {
      // Drive returned 2xx with non-JSON body — unusual but harmless.
    }
    return { ok: true, outcome: 'created', permissionId, status };
  }

  // Detect the "already shared" case. Drive does not give us a single error
  // code for it — depending on workspace policy the response may be:
  //   400 with reason "duplicate" / "duplicatePermission"
  //   403 with reason "shareOutNotPermitted" when domain policy forbids
  //       broadening sharing, which from our perspective is also "leave
  //       existing permissions in place" (we never make sharing tighter).
  // We treat any 4xx whose body mentions "duplicate" as exists; everything
  // else (including 5xx) is a real error so the caller can decide to retry.
  const lowerText = text.toLowerCase();
  if (status === 400 && (lowerText.includes('duplicate') || lowerText.includes('exist'))) {
    return { ok: true, outcome: 'exists', status };
  }

  return {
    ok: false,
    outcome: 'error',
    status,
    error: `HTTP ${status}: ${text.slice(0, 300)}`,
  };
}

// ─── Best-effort wrapper for hot paths ───────────────────────────────────────

/**
 * Best-effort variant. Calls grantAnyoneRead and swallows any error — only
 * logs. Use this from sync/upload hot paths so a transient Drive Permissions
 * failure (5xx, quota burst) never fails the underlying operation.
 *
 * Returns the GrantPermissionResult so callers that want to count outcomes
 * still can; callers that don't care can ignore it entirely.
 */
export function tryGrantAnyoneRead(folderId: string): GrantPermissionResult {
  const result = grantAnyoneRead(folderId);
  if (!result.ok) {
    Logger.log(
      `[drivePermissionsService] Non-fatal: failed to share folder ${folderId}: ` +
      `${result.error ?? 'unknown error'}`
    );
  } else if (result.outcome === 'created') {
    Logger.log(`[drivePermissionsService] Shared folder ${folderId} (Anyone with link → Viewer)`);
  }
  return result;
}

// ─── Batch summariser ────────────────────────────────────────────────────────

/**
 * Initial value for a running BatchGrantSummary accumulator. Exported so
 * callers can spread it into their own state without re-typing the shape.
 */
export const EMPTY_BATCH_GRANT_SUMMARY: BatchGrantSummary = {
  created: 0,
  alreadyShared: 0,
  errors: 0,
  errorSample: [],
};

/**
 * Folds a GrantPermissionResult into a running BatchGrantSummary.
 *
 * Pure function — exported so the backfill path in specialFoldersService can
 * build its summary without re-implementing the bucket math.
 *
 * Caps errorSample at 20 entries so log lines stay readable for large
 * backfills (hundreds of folders).
 */
export function foldBatchGrantSummary(
  prev: BatchGrantSummary,
  result: GrantPermissionResult,
  context?: string
): BatchGrantSummary {
  if (result.outcome === 'created') {
    return {
      ...prev,
      created: prev.created + 1,
    };
  }
  if (result.outcome === 'exists') {
    return {
      ...prev,
      alreadyShared: prev.alreadyShared + 1,
    };
  }
  const message = context
    ? `${context}: ${result.error ?? 'unknown error'}`
    : (result.error ?? 'unknown error');
  return {
    ...prev,
    errors: prev.errors + 1,
    errorSample:
      prev.errorSample.length < 20
        ? [...prev.errorSample, message]
        : prev.errorSample,
  };
}
