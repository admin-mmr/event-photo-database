/**
 * uploadPrepRoutes.ts — Server-side handlers for the Upload Prep sidebar.
 *
 * These functions are called via google.script.run from uploadPrepSidebar.html.
 * All handlers enforce super-admin access via assertSuperAdmin() before any work.
 *
 * Chunked processing strategy (spec §8 — 6-min GAS limit):
 *   1. Sidebar calls uploadPrep_start(eventFolderId, options) → { runId, ... }
 *   2. Sidebar loops uploadPrep_runBatch(runId, continuationToken?) until done
 *   3. Sidebar polls uploadPrep_getProgress(runId) every 2s between batch calls
 *
 * See UPLOAD_PREP_FEATURE_SPEC.md §7.6 for full specification.
 */

/* global HtmlService, SpreadsheetApp, Logger */

import {
  listEventFolders,
  getEventPrepStatus,
  startUploadPrepRun,
  prepareEventForUploadBatch,
  assertSuperAdmin,
} from '../services/uploadPrepService';
import type { PrepEventBatchResult, EventPrepStatus } from '../services/uploadPrepService';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Standard server response envelope matching the rest of main.ts. */
type ServerResponse = { status: string; message: string; data?: unknown; errors?: unknown };

// ─── Public handlers (re-exported for main.ts to expose via google.script.run) ─

/**
 * Lists all event folders in the SSOT root (sorted newest first).
 * Used to populate the event dropdown in the sidebar.
 */
export function uploadPrep_listEvents(): ServerResponse {
  try {
    assertSuperAdmin();
    const events = listEventFolders();
    return { status: 'success', message: `Found ${events.length} events`, data: events };
  } catch (err) {
    Logger.log(`[uploadPrepRoutes.listEvents] ${String(err)}`);
    return { status: 'error', message: String(err) };
  }
}

/**
 * Returns source-file counts for the event (already prepped vs new/changed).
 * Called when the user selects an event in the dropdown to update the stats banner.
 */
export function uploadPrep_getStatus(eventFolderId: string): ServerResponse {
  try {
    if (!eventFolderId) return { status: 'error', message: 'eventFolderId is required' };
    assertSuperAdmin();
    const status: EventPrepStatus = getEventPrepStatus(eventFolderId);
    return { status: 'success', message: 'Status retrieved', data: status };
  } catch (err) {
    Logger.log(`[uploadPrepRoutes.getStatus] ${String(err)}`);
    return { status: 'error', message: String(err) };
  }
}

/**
 * Starts a new upload-prep run for the given event.
 * Returns the runId and the first batch result.
 * If the first batch is not done, the sidebar should continue with runBatch().
 */
export function uploadPrep_start(
  eventFolderId: string,
  options: { dryRun?: boolean; force?: boolean }
): ServerResponse {
  try {
    if (!eventFolderId) return { status: 'error', message: 'eventFolderId is required' };
    assertSuperAdmin();
    const result = startUploadPrepRun({
      eventFolderId,
      dryRun: options?.dryRun ?? false,
      force:  options?.force ?? false,
    });
    return { status: 'success', message: 'Batch complete', data: result };
  } catch (err) {
    Logger.log(`[uploadPrepRoutes.start] ${String(err)}`);
    return { status: 'error', message: String(err) };
  }
}

/**
 * Continues processing the next batch of files for an in-progress run.
 * Pass the continuationToken from the previous batch response.
 */
export function uploadPrep_runBatch(
  runId: string,
  eventFolderId: string,
  continuationToken: string | undefined,
  options: { dryRun?: boolean; force?: boolean }
): ServerResponse {
  try {
    if (!runId || !eventFolderId) {
      return { status: 'error', message: 'runId and eventFolderId are required' };
    }
    assertSuperAdmin();
    const result: PrepEventBatchResult = prepareEventForUploadBatch({
      runId,
      eventFolderId,
      continuationToken: continuationToken ?? undefined,
      dryRun: options?.dryRun ?? false,
      force:  options?.force ?? false,
    });
    return { status: 'success', message: result.done ? 'Run complete' : 'Batch complete', data: result };
  } catch (err) {
    Logger.log(`[uploadPrepRoutes.runBatch] ${String(err)}`);
    return { status: 'error', message: String(err) };
  }
}

// ─── Sidebar HTML ─────────────────────────────────────────────────────────────

/**
 * Opens the Upload Prep sidebar in the bound spreadsheet.
 * Called from the Super Admin menu item wired up in onOpen().
 */
export function showUploadPrepSidebar(): void {
  const html = HtmlService
    .createTemplateFromFile('uploadPrepSidebar')
    .evaluate()
    .setTitle('Prep Upload Files')
    .setWidth(320);
  SpreadsheetApp.getUi().showSidebar(html);
}
