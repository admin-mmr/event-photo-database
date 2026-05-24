/**
 * publicSheetHandlers.ts — google.script.run server actions for the
 * "Public Sheet" page (?action=public_sheet).
 *
 * All three actions are available to ANY authenticated user — admins and
 * volunteers alike — so anyone can kick off a manual refresh when the
 * auto-refresh hook or the 30-minute scheduled trigger missed something.
 *
 * Auth model
 *   We use authenticateRequest() (not requireAdminOrFail) so club_admins,
 *   super_admins and any link-authenticated upload session can call these.
 *   Each handler logs the caller for auditability, but does NOT write an
 *   audit-log row — these are read/derive operations on data the user can
 *   already see (Drive folders + Special_Folders), and we don't want the
 *   Audit_Log spammed by people clicking "refresh" a few times.
 *
 * Why all three live here (instead of being scattered)
 *   The three buttons share the same auth path, the same response shape, and
 *   end with the same "now refresh the public sheet" follow-up. Keeping them
 *   in one module makes the wiring trivial and the unit tests cohesive.
 */

import { authenticateRequest } from '../middleware/authMiddleware';
import { ResultStatus } from '../types/enums';
import { ServerResponse } from '../types/responses';
import { listAll as listAllEvents } from '../services/eventService';
import { listAll as listAllUploadLinks } from '../services/uploadLinkService';
import {
  rebuildEventPhotoFolders,
  rebuildClubVideoFolder,
} from '../services/specialFoldersService';
import { rebuildPublicFoldersIndex } from '../services/publicSpreadsheetService';

/* global Logger */

/** Common payload shape for every action — only sessionToken is meaningful today. */
interface Payload {
  readonly sessionToken?: string;
}

/** Aggregate counts returned by the rebuild actions. */
interface RebuildSummary {
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed:    number;
  readonly rowsWritten?: number;        // Set by serverRefreshPublicSheet
  readonly errorSamples?: string[];     // Up to 5 error messages for the UI
}

/**
 * Shared auth gate. Returns the authenticated email on success, or a
 * ServerResponse error to short-circuit the handler.
 */
function requireAuth(payload: Payload): { ok: true; email: string } | { ok: false; response: ServerResponse } {
  const result = authenticateRequest(payload?.sessionToken);
  if (result.status !== ResultStatus.SUCCESS || !result.data) {
    return {
      ok: false,
      response: {
        status:  'error',
        message: '需要登录验证。\nAuthentication required.',
      },
    };
  }
  return { ok: true, email: result.data.email };
}

/**
 * Refresh the PUBLIC SHEET (Folder index spreadsheet) from the current
 * Special_Folders state. Does NOT rebuild any Drive folders or shortcuts —
 * just re-renders the Photo Folders / Video Folders tabs from existing rows.
 *
 * Fast (~1-2 seconds) and idempotent.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverRefreshPublicSheet(payload: Payload): ServerResponse {
  const auth = requireAuth(payload);
  if (!auth.ok) return auth.response;

  try {
    Logger.log(`[publicSheetHandlers.serverRefreshPublicSheet] caller=${auth.email}`);
    const rowsWritten = rebuildPublicFoldersIndex();
    return {
      status:  'success',
      message: `Refreshed public sheet — ${rowsWritten} row(s) written.`,
      data:    { rowsWritten },
    };
  } catch (err) {
    Logger.log(`[publicSheetHandlers.serverRefreshPublicSheet] error: ${String(err)}`);
    return {
      status:  'error',
      message: `Failed to refresh public sheet: ${String(err)}`,
    };
  }
}

/**
 * Rebuild every event's Photos_NNN shortcut folders, then refresh the public
 * sheet. Loops events one-at-a-time so a single broken event does not abort
 * the rest of the run — errors are accumulated and reported back to the UI.
 *
 * Wall-clock cost: ~1-3s per event with many photos. For very large archives
 * this approaches the 6-minute GAS execution limit; in that case the user
 * should fall back to running rebuildAllSpecialFoldersForEvent() from the
 * Apps Script editor where the limit is the same but progress is visible.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverRebuildPhotoFolders(payload: Payload): ServerResponse {
  const auth = requireAuth(payload);
  if (!auth.ok) return auth.response;

  try {
    Logger.log(`[publicSheetHandlers.serverRebuildPhotoFolders] caller=${auth.email}`);
    const events = listAllEvents(1, 10000, 'desc').items;

    const errorSamples: string[] = [];
    let succeeded = 0;
    let failed    = 0;

    for (const ev of events) {
      try {
        const r = rebuildEventPhotoFolders(ev.eventId);
        if (r.status === ResultStatus.SUCCESS) {
          succeeded++;
        } else {
          failed++;
          if (errorSamples.length < 5) {
            errorSamples.push(`${ev.eventName}: ${r.message ?? 'unknown error'}`);
          }
        }
      } catch (err) {
        failed++;
        if (errorSamples.length < 5) {
          errorSamples.push(`${ev.eventName}: ${String(err)}`);
        }
      }
    }

    // Always refresh the public sheet at the end so folder count + URL
    // changes propagate even when some events failed.
    let rowsWritten = 0;
    try {
      rowsWritten = rebuildPublicFoldersIndex();
    } catch (err) {
      errorSamples.push(`Public sheet refresh: ${String(err)}`);
    }

    const summary: RebuildSummary = {
      attempted: events.length,
      succeeded,
      failed,
      rowsWritten,
      errorSamples,
    };
    return {
      status:  failed === 0 ? 'success' : 'warning',
      message:
        `Rebuilt Photos folders for ${succeeded}/${events.length} event(s)` +
        (failed > 0 ? ` (${failed} failed)` : '') +
        ` and wrote ${rowsWritten} sheet row(s).`,
      data: summary,
    };
  } catch (err) {
    Logger.log(`[publicSheetHandlers.serverRebuildPhotoFolders] error: ${String(err)}`);
    return {
      status:  'error',
      message: `Failed to rebuild Photos folders: ${String(err)}`,
    };
  }
}

/**
 * Rebuild every (event, club, tag) Videos folder, then refresh the public
 * sheet. The set of tuples is derived from Upload_Links — a Videos folder
 * only makes sense where an upload link exists (or did at some point),
 * since the folder mirrors the per-link sub-tree.
 *
 * Revoked links are still iterated: an admin who rotates a link still wants
 * the old folder rebuilt so the historical videos remain accessible. Each
 * call to rebuildClubVideoFolder is idempotent and no-ops gracefully if the
 * underlying tag folder doesn't exist (link was generated but nobody ever
 * uploaded), so iterating the full link list is safe.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverRebuildVideoFolders(payload: Payload): ServerResponse {
  const auth = requireAuth(payload);
  if (!auth.ok) return auth.response;

  try {
    Logger.log(`[publicSheetHandlers.serverRebuildVideoFolders] caller=${auth.email}`);
    const links = listAllUploadLinks();

    // Dedupe — multiple revoked-and-reissued rows can share the same
    // (eventId, clubName, tag) triple. We only want to rebuild each folder
    // once per click.
    const tuples = new Set<string>();
    const work: Array<{ eventId: string; clubName: string; tag: string }> = [];
    for (const link of links) {
      const key = `${link.eventId}::${link.clubName}::${link.tag}`;
      if (tuples.has(key)) continue;
      tuples.add(key);
      work.push({ eventId: link.eventId, clubName: link.clubName, tag: link.tag });
    }

    const errorSamples: string[] = [];
    let succeeded = 0;
    let failed    = 0;

    for (const w of work) {
      try {
        const r = rebuildClubVideoFolder(w.eventId, w.clubName, w.tag);
        if (r.status === ResultStatus.SUCCESS) {
          succeeded++;
        } else {
          failed++;
          if (errorSamples.length < 5) {
            errorSamples.push(`${w.eventId}/${w.clubName}/${w.tag}: ${r.message ?? 'unknown error'}`);
          }
        }
      } catch (err) {
        failed++;
        if (errorSamples.length < 5) {
          errorSamples.push(`${w.eventId}/${w.clubName}/${w.tag}: ${String(err)}`);
        }
      }
    }

    let rowsWritten = 0;
    try {
      rowsWritten = rebuildPublicFoldersIndex();
    } catch (err) {
      errorSamples.push(`Public sheet refresh: ${String(err)}`);
    }

    const summary: RebuildSummary = {
      attempted: work.length,
      succeeded,
      failed,
      rowsWritten,
      errorSamples,
    };
    return {
      status:  failed === 0 ? 'success' : 'warning',
      message:
        `Rebuilt Videos folders for ${succeeded}/${work.length} (event, club, tag) tuple(s)` +
        (failed > 0 ? ` (${failed} failed)` : '') +
        ` and wrote ${rowsWritten} sheet row(s).`,
      data: summary,
    };
  } catch (err) {
    Logger.log(`[publicSheetHandlers.serverRebuildVideoFolders] error: ${String(err)}`);
    return {
      status:  'error',
      message: `Failed to rebuild Videos folders: ${String(err)}`,
    };
  }
}
