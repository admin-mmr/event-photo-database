/**
 * photosHandlers.ts — google.script.run handlers for Google Photos albums,
 * sync jobs, and the async sync queue.
 *
 * Covers: serverGetEventAlbums, serverSyncAlbum, serverReconcilePhotos,
 *         serverBackfillAlbums, serverCreateSyncJob, serverGetSyncJob,
 *         serverCancelSyncJob, serverGetSyncQueueStatus,
 *         drainSyncQueueTrigger, installSyncQueueTrigger,
 *         uninstallSyncQueueTrigger.
 */

import { ResultStatus } from '../types/enums';
import { ServerResponse, WithSession } from '../types/responses';
import { requireAdminOrFail } from '../middleware/authMiddleware';
import {
  syncBatchToAlbums,
  syncEventToAlbums,
  backfillAllAlbums,
  findAlbumsByEvent,
  reconcileAllPhotos,
  EventInfo,
} from '../services/photosService';
import {
  rebuildPublicAlbumIndex,
  getPublicSpreadsheetUrl,
} from '../services/publicSpreadsheetService';
import { photosListAlbumMediaItems } from '../services/photosApiClient';
import {
  createJob,
  getJob,
  completeJob,
  requestCancel,
  sweepExpired,
  SyncJob,
} from '../services/syncJobService';
import {
  getQueueStatus,
  loadPendingItemsWithContext,
  computeInProgressUpdate,
  computeDoneUpdate,
  computeFailedUpdate,
} from '../services/syncQueueService';
import { batchUpdateRows } from '../services/sheetService';
import { fromSyncQueueRecord } from '../utils/sheetMapper';
import { listActive as listActiveClubs } from '../services/clubService';
import { findById as findEventById } from '../services/eventService';
import { appendAuditLog } from '../services/auditLogService';
import { AuditAction } from '../types/enums';

/* global Logger, ScriptApp */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverGetEventAlbums(payload: WithSession<{ eventId: string }>): ServerResponse {
  try {
    const authResult = requireAdminOrFail(payload?.sessionToken);
    if (!authResult.ok) return authResult.response;
    if (!payload.eventId) return { status: 'error', message: 'eventId is required' };
    const albums = findAlbumsByEvent(payload.eventId);
    return { status: 'success', message: `Found ${albums.length} album(s) for event`, data: { albums } };
  } catch (err) {
    Logger.log(`serverGetEventAlbums error: ${String(err)}`);
    return { status: 'error', message: 'Internal error fetching event albums' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverSyncAlbum(
  payload: WithSession<{ eventId: string; jobId?: string }>
): ServerResponse {
  const jobId = payload?.jobId;
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) {
      if (jobId) completeJob(jobId, 'failed', 'Unauthorized');
      return auth.response;
    }
    if (!payload.eventId) {
      if (jobId) completeJob(jobId, 'failed', 'eventId is required');
      return { status: 'error', message: 'eventId is required' };
    }
    const event = findEventById(payload.eventId);
    if (!event) {
      const msg = `Event "${payload.eventId}" not found`;
      if (jobId) completeJob(jobId, 'failed', msg);
      return { status: 'error', message: msg };
    }
    const clubDisplayNames: Record<string, string> = {};
    listActiveClubs().forEach((c) => { clubDisplayNames[c.normalizedName] = c.displayName; });
    const eventInfo: EventInfo = {
      eventId:       event.eventId,
      eventName:     event.eventName,
      eventDate:     event.eventDate,
      driveFolderId: event.driveFolderId,
    };
    const result = syncEventToAlbums(eventInfo, clubDisplayNames, jobId);
    if (result.status === ResultStatus.SUCCESS && result.data) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.ALBUM_SYNCED,
        resourceType: 'event', resourceId: event.eventId,
        details: { totalSynced: result.data.totalSynced, clubTags: result.data.clubTagsSynced.length, errors: result.data.errors.length },
      });
      if (result.data.errors.length > 0) {
        appendAuditLog({
          actorEmail: auth.adminEmail, action: AuditAction.ALBUM_ERROR,
          resourceType: 'event', resourceId: event.eventId,
          details: { operation: 'sync_event_to_albums', errors: result.data.errors },
        });
      }
      if (jobId) {
        const finalState = getJob(jobId);
        if (finalState?.cancelRequested) {
          completeJob(jobId, 'cancelled',
            `Cancelled after syncing ${result.data.totalSynced} photo(s) across ${result.data.clubTagsSynced.length} (club, tag) bucket(s)`);
        } else {
          completeJob(jobId, 'completed', result.message);
        }
      }
    } else if (result.status !== ResultStatus.SUCCESS) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.ALBUM_ERROR,
        resourceType: 'event', resourceId: event.eventId,
        details: { operation: 'sync_event_to_albums', error: result.message },
      });
      if (jobId) completeJob(jobId, 'failed', result.message);
    }
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverSyncAlbum error: ${String(err)}`);
    appendAuditLog({
      actorEmail: 'system', action: AuditAction.ALBUM_ERROR,
      resourceType: 'event', resourceId: payload.eventId ?? '',
      details: { operation: 'sync_event_to_albums', error: String(err) },
    });
    if (jobId) completeJob(jobId, 'failed', `Internal error: ${String(err)}`);
    return { status: 'error', message: `Internal error syncing album: ${String(err)}` };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverReconcilePhotos(payload: WithSession): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const result = reconcileAllPhotos();
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverReconcilePhotos error: ${String(err)}`);
    return { status: 'error', message: `Internal error during reconciliation: ${String(err)}` };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverBackfillAlbums(payload: WithSession<{ jobId?: string }>): ServerResponse {
  const jobId = payload?.jobId;
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) {
      if (jobId) completeJob(jobId, 'failed', 'Unauthorized');
      return auth.response;
    }
    const clubDisplayNames: Record<string, string> = {};
    listActiveClubs().forEach((c) => { clubDisplayNames[c.normalizedName] = c.displayName; });
    const result = backfillAllAlbums(clubDisplayNames, jobId);
    if (result.status === ResultStatus.SUCCESS && result.data) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.ALBUM_BACKFILLED,
        resourceType: 'report', resourceId: '',
        details: { eventsProcessed: result.data.eventsProcessed, albumsCreated: result.data.albumsCreated, totalSynced: result.data.totalSynced, errorCount: result.data.errors.length },
      });
      if (result.data.errors.length > 0) {
        appendAuditLog({
          actorEmail: auth.adminEmail, action: AuditAction.ALBUM_ERROR,
          resourceType: 'report', resourceId: '',
          details: { operation: 'backfill_all_albums', errors: result.data.errors },
        });
      }
      if (jobId) {
        const finalState = getJob(jobId);
        if (finalState?.cancelRequested) {
          completeJob(jobId, 'cancelled',
            `Cancelled after ${result.data.eventsProcessed} event(s), ${result.data.totalSynced} photo(s) synced`);
        } else {
          completeJob(jobId, 'completed', result.message);
        }
      }
    } else if (result.status !== ResultStatus.SUCCESS) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.ALBUM_ERROR,
        resourceType: 'report', resourceId: '',
        details: { operation: 'backfill_all_albums', error: result.message },
      });
      if (jobId) completeJob(jobId, 'failed', result.message);
    }
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverBackfillAlbums error: ${String(err)}`);
    appendAuditLog({
      actorEmail: 'system', action: AuditAction.ALBUM_ERROR,
      resourceType: 'report', resourceId: '',
      details: { operation: 'backfill_all_albums', error: String(err) },
    });
    if (jobId) completeJob(jobId, 'failed', `Internal error: ${String(err)}`);
    return { status: 'error', message: `Internal error during backfill: ${String(err)}` };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverCreateSyncJob(
  payload: WithSession<{ jobType: SyncJob['jobType']; eventId?: string }>
): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    if (payload.jobType !== 'sync-event' && payload.jobType !== 'backfill-all') {
      return { status: 'error', message: 'Invalid jobType' };
    }
    sweepExpired();
    const job = createJob(payload.jobType, payload.eventId ?? '');
    return { status: 'success', message: 'Job created', data: job };
  } catch (err) {
    Logger.log(`serverCreateSyncJob error: ${String(err)}`);
    return { status: 'error', message: `Internal error creating sync job: ${String(err)}` };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverGetSyncJob(payload: WithSession<{ jobId: string }>): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    if (!payload.jobId) return { status: 'error', message: 'jobId is required' };
    const job = getJob(payload.jobId);
    if (!job) return { status: 'error', message: 'Job not found (expired or invalid id)' };
    return { status: 'success', message: 'OK', data: job };
  } catch (err) {
    Logger.log(`serverGetSyncJob error: ${String(err)}`);
    return { status: 'error', message: `Internal error reading sync job: ${String(err)}` };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverCancelSyncJob(payload: WithSession<{ jobId: string }>): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    if (!payload.jobId) return { status: 'error', message: 'jobId is required' };
    const ok = requestCancel(payload.jobId);
    if (!ok) return { status: 'error', message: 'Job not found or already finished' };
    appendAuditLog({
      actorEmail: auth.adminEmail, action: AuditAction.ALBUM_ERROR,
      resourceType: 'report', resourceId: payload.jobId,
      details: { operation: 'cancel_sync_job' },
    });
    return { status: 'success', message: 'Cancel requested — the worker will stop shortly.' };
  } catch (err) {
    Logger.log(`serverCancelSyncJob error: ${String(err)}`);
    return { status: 'error', message: `Internal error cancelling sync job: ${String(err)}` };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverGetSyncQueueStatus(payload: WithSession): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const status = getQueueStatus();
    return { status: 'success', message: 'OK', data: status };
  } catch (err) {
    Logger.log(`serverGetSyncQueueStatus error: ${String(err)}`);
    return { status: 'error', message: `Internal error reading sync queue status: ${String(err)}` };
  }
}

/**
 * Returns live stats for one Google Photos album, computed from the Photos
 * API (not the cached Photo_Albums sheet). Used by the Albums page to render
 * the actual mediaCount and the latest mediaMetadata.creationTime ("max time
 * a photo in this album was taken").
 *
 * One HTTP page per 100 items; albums under that resolve in a single round
 * trip. Cached lazily by the client — only refreshed on user click.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverGetAlbumStats(
  payload: WithSession<{ albumId: string }>
): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    if (!payload.albumId) {
      return { status: 'error', message: 'albumId is required' };
    }

    const result = photosListAlbumMediaItems(payload.albumId);
    if (!result.ok || !result.items) {
      return { status: 'error', message: result.error ?? 'Photos API call failed' };
    }

    let maxMediaTakenAt = '';
    for (const item of result.items) {
      if (item.creationTime && item.creationTime > maxMediaTakenAt) {
        maxMediaTakenAt = item.creationTime;
      }
    }

    return {
      status: 'success',
      message: `Album has ${result.items.length} item(s)`,
      data: {
        albumId:         payload.albumId,
        mediaCount:      result.items.length,
        maxMediaTakenAt,
      },
    };
  } catch (err) {
    Logger.log(`serverGetAlbumStats error: ${String(err)}`);
    return { status: 'error', message: `Internal error reading album stats: ${String(err)}` };
  }
}

/**
 * Manually re-materializes the public album-index spreadsheet from the
 * authoritative Photo_Albums data. The hot-path callers (album creation,
 * batch sync) already keep the public sheet up to date, so this is intended
 * for recovery — e.g. when an admin has just fixed bad data in Photo_Albums
 * and wants the public view to catch up immediately, or when the public sheet
 * was created/reconfigured after the last sync.
 *
 * Admin-only (requireAdminOrFail). Returns the row count plus the public
 * spreadsheet URL so the UI can offer a "View public sheet" link.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverRebuildPublicAlbumIndex(payload: WithSession): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;

    const url = getPublicSpreadsheetUrl();
    if (!url) {
      return {
        status: 'error',
        message: 'Public album index is not configured. Set the PUBLIC_ALBUM_INDEX_SHEET_ID Script Property to a Google Sheets file ID first.',
      };
    }

    const rowCount = rebuildPublicAlbumIndex();
    appendAuditLog({
      actorEmail:   auth.adminEmail,
      action:       AuditAction.ALBUM_BACKFILLED,
      resourceType: 'report',
      resourceId:   'public_album_index',
      details:      { operation: 'rebuild_public_album_index', rowCount },
    });
    return {
      status: 'success',
      message: `Public album index rebuilt — ${rowCount} row(s) written.`,
      data: { rowCount, url },
    };
  } catch (err) {
    Logger.log(`serverRebuildPublicAlbumIndex error: ${String(err)}`);
    return {
      status: 'error',
      message: `Internal error rebuilding public album index: ${String(err)}`,
    };
  }
}

// ─── Sync queue time-driven triggers ─────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function drainSyncQueueTrigger(): void {
  Logger.log('[drainSyncQueueTrigger] Starting drain run');
  let processed = 0, succeeded = 0, failed = 0;
  try {
    const { items, rowMap, allRows, sheetName: sqSheetName } = loadPendingItemsWithContext();
    if (items.length === 0) {
      Logger.log('[drainSyncQueueTrigger] Queue empty — nothing to drain');
      return;
    }
    Logger.log(`[drainSyncQueueTrigger] Processing ${items.length} item(s)`);
    const clubDisplayNames: Record<string, string> = {};
    try {
      listActiveClubs().forEach((c) => { clubDisplayNames[c.normalizedName] = c.displayName; });
    } catch (clubErr) {
      Logger.log(`[drainSyncQueueTrigger] Could not load clubs (non-fatal): ${String(clubErr)}`);
    }
    const now = new Date();
    type DrainItem = { rowIndex: number; inProgress: ReturnType<typeof computeInProgressUpdate> };
    const drainItems = new Map<string, DrainItem>();
    const inProgressWrites: Array<{ rowIndex: number; row: unknown[] }> = [];
    for (const item of items) {
      const entry = rowMap.get(item.queueId);
      if (!entry) {
        Logger.log(`[drainSyncQueueTrigger] Row not found for queueId=${item.queueId} — skipping`);
        continue;
      }
      const inProgress = computeInProgressUpdate(entry.record, now);
      drainItems.set(item.queueId, { rowIndex: entry.rowIndex, inProgress });
      inProgressWrites.push({ rowIndex: entry.rowIndex, row: fromSyncQueueRecord(inProgress) });
    }
    if (inProgressWrites.length > 0) batchUpdateRows(sqSheetName, inProgressWrites, allRows);
    const terminalWrites: Array<{ rowIndex: number; row: unknown[] }> = [];
    for (const item of items) {
      processed++;
      const label = `queueId=${item.queueId} event=${item.eventId} club=${item.clubName} batch=${item.batchFolderName}`;
      const drainItem = drainItems.get(item.queueId);
      if (!drainItem) continue;
      const { rowIndex, inProgress } = drainItem;
      try {
        const event = findEventById(item.eventId);
        if (!event) {
          Logger.log(`[drainSyncQueueTrigger] Event not found for ${label} — marked failed`);
          failed++;
          terminalWrites.push({ rowIndex, row: fromSyncQueueRecord(computeFailedUpdate(inProgress, `Event not found: ${item.eventId}`)) });
          continue;
        }
        const clubDisplayName = clubDisplayNames[item.clubName] ?? item.clubName.replace(/_/g, ' ');
        const syncResult = syncBatchToAlbums(
          event.eventId, event.eventName, event.eventDate,
          item.clubName, clubDisplayName, item.tag, item.batchFolderId
        );
        if (syncResult.status === ResultStatus.SUCCESS || syncResult.status === 'warning') {
          Logger.log(`[drainSyncQueueTrigger] Done: ${label} — ${syncResult.message}`);
          succeeded++;
          terminalWrites.push({ rowIndex, row: fromSyncQueueRecord(computeDoneUpdate(inProgress, now)) });
        } else {
          Logger.log(`[drainSyncQueueTrigger] Sync error for ${label}: ${syncResult.message}`);
          failed++;
          terminalWrites.push({ rowIndex, row: fromSyncQueueRecord(computeFailedUpdate(inProgress, syncResult.message)) });
        }
      } catch (itemErr) {
        const msg = String(itemErr);
        Logger.log(`[drainSyncQueueTrigger] Exception for ${label}: ${msg}`);
        failed++;
        terminalWrites.push({ rowIndex, row: fromSyncQueueRecord(computeFailedUpdate(inProgress, msg)) });
      }
    }
    if (terminalWrites.length > 0) batchUpdateRows(sqSheetName, terminalWrites);
  } catch (outerErr) {
    Logger.log(`[drainSyncQueueTrigger] Fatal error: ${String(outerErr)}`);
  }
  Logger.log(`[drainSyncQueueTrigger] Drain run complete — processed=${processed} succeeded=${succeeded} failed=${failed}`);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function installSyncQueueTrigger(): void {
  const existing = ScriptApp.getProjectTriggers().filter(
    (t) => t.getHandlerFunction() === 'drainSyncQueueTrigger'
  );
  if (existing.length > 0) {
    Logger.log('[installSyncQueueTrigger] Trigger already installed — nothing to do');
    return;
  }
  ScriptApp.newTrigger('drainSyncQueueTrigger').timeBased().everyMinutes(5).create();
  Logger.log('[installSyncQueueTrigger] 5-minute drain trigger installed');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function uninstallSyncQueueTrigger(): void {
  const triggers = ScriptApp.getProjectTriggers().filter(
    (t) => t.getHandlerFunction() === 'drainSyncQueueTrigger'
  );
  for (const trigger of triggers) ScriptApp.deleteTrigger(trigger);
  Logger.log(`[uninstallSyncQueueTrigger] Removed ${triggers.length} trigger(s)`);
}
