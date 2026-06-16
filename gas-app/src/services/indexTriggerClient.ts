/**
 * indexTriggerClient.ts — fire cloud-webapp automation on the api the moment
 * something changes in the gas-app, so Find Me stays fresh without anyone
 * clicking anything. Two best-effort, fire-and-forget triggers live here:
 *
 *   1. triggerEventIndex(eventId)  — POST /api/events/:id/index. The *primary*,
 *      event-driven trigger for the indexing pipeline: as soon as a volunteer
 *      finishes uploading to Drive, we ask the api to (re)index that event so
 *      photo matches appear on arrival. A Cloud Scheduler "index-scan" backstop
 *      (infra/scripts/provision-index-scan-scheduler.sh) catches misses.
 *
 *   2. triggerMetadataSync(context) — POST /api/admin/sync (the "Sync with
 *      Drive" reconciler). Called right after an event or upload link is
 *      created so the new event + its name reach Firestore in seconds instead
 *      of waiting up to a day for the scheduled `findme-drive-sync` reconciler
 *      (dev plan §5A B8). The daily reconciler stays as the backstop.
 *
 * Both reuse the same shared X-Sync-Token machine secret (middleware/
 * cronAuth.ts) and OIDC identity-token auth described below.
 *
 * Best-effort by design: the upload is already complete and recorded once the
 * bytes are in Drive. A failed or unconfigured trigger is logged and swallowed
 * — it must never surface as an upload error to the volunteer (same philosophy
 * as the legacy special-folders rebuild, DESIGN_DECISIONS §11).
 *
 * Auth: the api is private (Cloud Run --no-allow-unauthenticated), so we send
 * BOTH a Google OIDC ID token for the Cloud Run IAM gate (Authorization
 * header, same pattern as cloudRunClient.ts) AND the X-Sync-Token the api's
 * cronAuth middleware checks. The gas-app's effective identity must have
 * roles/run.invoker on the event-photo-api service (one-time IAM grant).
 *
 * Config (Script Properties): FINDME_API_URL, INDEX_TRIGGER_TOKEN.
 */

/* global UrlFetchApp, ScriptApp, Logger */

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
      headers: {
        // Cloud Run IAM gate (service is --no-allow-unauthenticated).
        Authorization: `Bearer ${ScriptApp.getIdentityToken()}`,
        // App-level machine-caller gate (cronAuth middleware).
        'X-Sync-Token': getIndexTriggerToken(),
      },
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

export interface MetadataSyncResult {
  readonly triggered: boolean;
  /** Why we didn't trigger, or the upstream error — for logging/tests. */
  readonly reason?: string;
  readonly status?: number;
}

/**
 * Asks the api to reconcile Drive/Sheet metadata into Firestore *now* by POSTing
 * /api/admin/sync (the same reconciler the daily `findme-drive-sync` job runs).
 * Used immediately after an event or upload link is created so the new event and
 * its human-readable name surface in Find Me within seconds instead of waiting
 * up to a day (dev plan §5A B8).
 *
 * Best-effort by design — the gas-app/Sheet write is already the source of truth
 * and the daily reconciler is the backstop, so a failed or unconfigured trigger
 * is logged and swallowed and must NEVER surface as an error to the admin (same
 * philosophy as triggerEventIndex above). Never throws.
 *
 * @param context  Short label for logs, e.g. 'event_created' | 'link_generated'.
 */
export function triggerMetadataSync(context = 'metadata'): MetadataSyncResult {
  if (!isIndexTriggerConfigured()) {
    Logger.log('[metadataSync] FINDME_API_URL / INDEX_TRIGGER_TOKEN not set — skipping (no-op).');
    return { triggered: false, reason: 'not_configured' };
  }

  const url = `${getFindMeApiUrl()}/api/admin/sync`;
  try {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        // Cloud Run IAM gate (service is --no-allow-unauthenticated).
        Authorization: `Bearer ${ScriptApp.getIdentityToken()}`,
        // App-level machine-caller gate (cronAuth middleware).
        'X-Sync-Token': getIndexTriggerToken(),
      },
      payload: JSON.stringify({}), // reconcile reads the master Sheet; no body needed
      muteHttpExceptions: true,
    });
    const status = res.getResponseCode();
    if (status === 200 || status === 202) {
      Logger.log(`[metadataSync] ${context}: drive sync triggered (HTTP ${status}).`);
      return { triggered: true, status };
    }
    Logger.log(`[metadataSync] ${context}: HTTP ${status} — ${res.getContentText().slice(0, 200)}`);
    return { triggered: false, reason: `http_${status}`, status };
  } catch (err) {
    Logger.log(`[metadataSync] ${context}: request failed — ${String(err)}`);
    return { triggered: false, reason: 'request_failed' };
  }
}
