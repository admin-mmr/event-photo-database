/**
 * duplicateHandlers.ts — google.script.run server actions for the
 * "Duplicate Cleanup" page (?action=duplicates).
 *
 * Flow (review-then-delete, never automatic):
 *   1. serverScanDuplicateFiles  — read-only scan of one event's Drive
 *      subtree; returns groups of identical files with a proposed keeper.
 *   2. The admin reviews the list in the UI and unchecks anything they
 *      want to keep.
 *   3. serverTrashDuplicateFiles — soft-deletes the confirmed copies via
 *      deleteService (audited, 30-day restorable), sweeps now-dangling
 *      shortcuts out of the Photos_NNN / Videos / Album folders, and
 *      refreshes the public sheet.
 *
 * Auth model
 *   Both actions require an authenticated User (club_admin or super_admin —
 *   the Users sheet only holds admins). Club admins are scoped to their own
 *   club: scan results are filtered to their club and deletion requests for
 *   other clubs are rejected.
 */

import { authenticateRequest } from '../middleware/authMiddleware';
import { ResultStatus, UserRole } from '../types/enums';
import { ServerResponse } from '../types/responses';
import { UserRecord } from '../types/models';
import {
  scanEventForDuplicates,
  DuplicateScanReport,
} from '../services/duplicateCleanupService';
import { softDeleteFile } from '../services/deleteService';
import { removeShortcutsForTargets } from '../services/specialFoldersService';
import { tryRebuildPublicFoldersIndex } from '../services/publicSpreadsheetService';

/* global Logger */

// ─── Payload shapes ───────────────────────────────────────────────────────────

interface ScanPayload {
  readonly sessionToken?: string;
  readonly eventId?: string;
}

/** One confirmed-for-deletion file sent back from the review UI. */
export interface TrashItem {
  readonly fileId: string;
  readonly fileName: string;
  readonly clubName: string;
  readonly batchFolderName: string;
}

interface TrashPayload {
  readonly sessionToken?: string;
  readonly eventId?: string;
  readonly items?: TrashItem[];
}

/** Aggregate counts returned by serverTrashDuplicateFiles. */
interface TrashSummary {
  readonly attempted: number;
  readonly deleted: number;
  readonly failed: number;
  readonly shortcutsRemoved: number;
  readonly errorSamples: string[];
}

// ─── Shared auth gate ─────────────────────────────────────────────────────────

function requireAuth(
  sessionToken?: string
): { ok: true; user: UserRecord } | { ok: false; response: ServerResponse } {
  const result = authenticateRequest(sessionToken);
  if (result.status !== ResultStatus.SUCCESS || !result.data) {
    return {
      ok: false,
      response: {
        status: 'error',
        message: '需要登录验证。\nAuthentication required.',
      },
    };
  }
  return { ok: true, user: result.data };
}

// ─── Actions ──────────────────────────────────────────────────────────────────

/**
 * Read-only duplicate scan for one event. Club admins receive only their
 * own club's groups; super admins see every club.
 */
export function serverScanDuplicateFiles(payload: ScanPayload): ServerResponse {
  const auth = requireAuth(payload?.sessionToken);
  if (!auth.ok) return auth.response;

  const eventId = String(payload?.eventId ?? '').trim();
  if (!eventId) {
    return { status: 'error', message: 'eventId is required.' };
  }

  try {
    Logger.log(
      `[duplicateHandlers.serverScanDuplicateFiles] caller=${auth.user.email} event=${eventId}`
    );
    const result = scanEventForDuplicates(eventId);
    if (result.status !== ResultStatus.SUCCESS || !result.data) {
      return { status: 'error', message: result.message ?? 'Scan failed.' };
    }

    let report: DuplicateScanReport = result.data;
    if (auth.user.role === UserRole.CLUB_ADMIN) {
      const own = auth.user.clubId ?? '';
      const groups = report.groups.filter((g) => g.clubName === own);
      report = {
        ...report,
        groups,
        duplicateFileCount: groups.reduce((n, g) => n + g.duplicates.length, 0),
        duplicateBytes: groups.reduce(
          (n, g) => n + g.duplicates.reduce((m, d) => m + d.sizeBytes, 0),
          0
        ),
      };
    }

    return { status: 'success', message: result.message ?? '', data: report };
  } catch (err) {
    Logger.log(`[duplicateHandlers.serverScanDuplicateFiles] error: ${String(err)}`);
    return { status: 'error', message: `Scan failed: ${String(err)}` };
  }
}

/**
 * Soft-deletes the reviewed duplicate copies, then sweeps their shortcuts
 * and refreshes the public sheet. Per-file failures are aggregated into a
 * 'warning' response rather than aborting the batch.
 */
export function serverTrashDuplicateFiles(payload: TrashPayload): ServerResponse {
  const auth = requireAuth(payload?.sessionToken);
  if (!auth.ok) return auth.response;

  const eventId = String(payload?.eventId ?? '').trim();
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!eventId || items.length === 0) {
    return { status: 'error', message: 'eventId and a non-empty items list are required.' };
  }

  // Club-admin scoping: every requested item must belong to their club.
  if (auth.user.role === UserRole.CLUB_ADMIN) {
    const own = auth.user.clubId ?? '';
    const foreign = items.find((i) => i.clubName !== own);
    if (foreign) {
      return {
        status: 'error',
        message: `You administer "${own}" and cannot delete files for "${foreign.clubName}".`,
      };
    }
  }

  Logger.log(
    `[duplicateHandlers.serverTrashDuplicateFiles] caller=${auth.user.email} ` +
    `event=${eventId} items=${items.length}`
  );

  const errorSamples: string[] = [];
  const deletedIds: string[] = [];
  let failed = 0;

  for (const item of items) {
    const fileId = String(item?.fileId ?? '').trim();
    const fileName = String(item?.fileName ?? '').trim();
    if (!fileId || !fileName) {
      failed++;
      if (errorSamples.length < 5) errorSamples.push('Malformed item (missing fileId/fileName).');
      continue;
    }
    try {
      const r = softDeleteFile({
        driveFileId: fileId,
        fileName,
        eventId,
        clubName: String(item.clubName ?? '').trim(),
        batchFolderName: String(item.batchFolderName ?? '').trim() || '(scope folder)',
        uploadedBy: 'unknown',
        actorEmail: auth.user.email,
        reason: 'Duplicate cleanup',
      });
      if (r.status === ResultStatus.SUCCESS) {
        deletedIds.push(fileId);
      } else {
        failed++;
        if (errorSamples.length < 5) errorSamples.push(`${fileName}: ${r.message}`);
      }
    } catch (err) {
      failed++;
      if (errorSamples.length < 5) errorSamples.push(`${fileName}: ${String(err)}`);
    }
  }

  // Sweep dangling shortcuts for everything that was actually trashed, then
  // refresh the public sheet so file counts stay accurate. Both steps are
  // best-effort — the deletions above are already safely recorded.
  let shortcutsRemoved = 0;
  if (deletedIds.length > 0) {
    try {
      const sweep = removeShortcutsForTargets(deletedIds);
      shortcutsRemoved = sweep.shortcutsRemoved;
      for (const e of sweep.errors) {
        if (errorSamples.length < 5) errorSamples.push(e);
      }
    } catch (err) {
      if (errorSamples.length < 5) errorSamples.push(`Shortcut sweep: ${String(err)}`);
    }
    tryRebuildPublicFoldersIndex();
  }

  const summary: TrashSummary = {
    attempted: items.length,
    deleted: deletedIds.length,
    failed,
    shortcutsRemoved,
    errorSamples,
  };

  return {
    status: failed === 0 ? 'success' : 'warning',
    message:
      `Moved ${deletedIds.length}/${items.length} duplicate file(s) to trash` +
      (failed > 0 ? ` (${failed} failed)` : '') +
      ` and removed ${shortcutsRemoved} shortcut(s). ` +
      `Files are restorable for 30 days.`,
    data: summary,
  };
}
