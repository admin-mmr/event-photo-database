/**
 * indexTriggerClient.ts — fire the cloud-webapp indexer at the end of an
 * upload batch so photos are indexed on arrival (no-touch automation).
 *
 * This is the *primary*, event-driven trigger for the Find Me indexing
 * pipeline: as soon as a volunteer finishes uploading to Drive, we POST
 * /api/events/:id/index on the api, authorized with the shared X-Sync-Token
 * machine secret (middleware/cronAuth.ts). A Cloud Scheduler "index-scan"
 * backstop (infra/scripts/provision-index-scan-scheduler.sh) catches anything
 * this call misses.
 *
 * Best-effort by design: the upload is already complete and recorded once the
 * bytes are in Drive. A failed or unconfigured trigger is logged and swallowed
 * — it must never surface as an upload error to the volunteer (same philosophy
 * as the legacy special-folders rebuild, DESIGN_DECISIONS §11).
 *
 * Config (Script Properties): FINDME_API_URL, INDEX_TRIGGER_TOKEN.
 */

/* global UrlFetchApp, Logger */

import { getFindMeApiUrl, getIndexTriggerToken, isIndexTriggerConfigured } from '../config/superAdmins';

export interface IndexTriggerResult {
  readonly triggered: boolean;
  /** Why we didn't trigger, or the upstream error — for logging/tests. */
  readonly reason?: string;
  readonly status?: number;
}

/**
 * Asks the api to (re)index an event. Returns immediately on success (the api
 * responds 202 and the indexer runs asynchronously). Never throws.
 *
 * @param eventId  The Find Me / Firestore event id (same id the gas-app uses).
 */
export function triggerEventIndex(eventId: string): IndexTriggerResult {
  if (!eventId) {
    return { triggered: false, reason: 'missing_event_id' };
  }
  if (!isIndexTriggerConfigured()) {
    Logger.log('[indexTrigger] FINDME_API_URL / INDEX_TRIGGER_TOKEN not set — skipping (no-op).');
    return { triggered: false, reason: 'not_configured' };
  }

  const url = `${getFindMeApiUrl()}/api/events/${encodeURIComponent(eventId)}/index`;
  try {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Sync-Token': getIndexTriggerToken() },
      payload: JSON.stringify({}), // force defaults to false; incremental diff handles the rest
      muteHttpExceptions: true,
    });
    const status = res.getResponseCode();
    if (status === 202 || status === 200) {
      Logger.log(`[indexTrigger] event ${eventId}: indexing triggered (HTTP ${status}).`);
      return { triggered: true, status };
    }
    // 409 already_running is benign — a run is already in flight for this event.
    if (status === 409) {
      Logger.log(`[indexTrigger] event ${eventId}: already running (HTTP 409) — fine.`);
      return { triggered: false, reason: 'already_running', status };
    }
    Logger.log(`[indexTrigger] event ${eventId}: HTTP ${status} — ${res.getContentText().slice(0, 200)}`);
    return { triggered: false, reason: `http_${status}`, status };
  } catch (err) {
    Logger.log(`[indexTrigger] event ${eventId}: request failed — ${String(err)}`);
    return { triggered: false, reason: 'request_failed' };
  }
}
