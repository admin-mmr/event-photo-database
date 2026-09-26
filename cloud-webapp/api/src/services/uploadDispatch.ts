/**
 * uploadDispatch.ts — enqueue a volunteer batch onto Cloud Tasks for background
 * processing (UPLOAD_ASYNC_QUEUE_DESIGN.md step 3).
 *
 * We call the Cloud Tasks REST API with a `google-auth-library` cloud-platform
 * token rather than pulling in `@google-cloud/tasks`, to keep the api image lean
 * (same approach as recaptcha/sheets). The task is an HTTP-target task that
 * POSTs the batch back to our own `/api/internal/process-batch`, carrying the
 * `X-Sync-Token` shared secret the worker endpoint checks. (OIDC auth can be
 * added alongside as hardening; the endpoint already trusts the token.)
 *
 * Dispatch is active only when the flag is on AND the queue + worker URL + token
 * are configured; otherwise `/complete` falls back to the inline copy.
 */

import { env } from '../lib/config.js';
import { getAccessToken } from '../lib/googleCredentials.js';
import { logger } from '../lib/logger.js';

/** True only when background dispatch is fully configured. */
export function isUploadDispatchConfigured(): boolean {
  return (
    env.UPLOAD_DISPATCH_TO_WORKER === 'true' &&
    Boolean(env.GCP_PROJECT_ID) &&
    env.UPLOAD_TASKS_QUEUE.length > 0 &&
    env.UPLOAD_WORKER_URL.length > 0 &&
    env.SYNC_TRIGGER_TOKEN.length > 0
  );
}

export interface ProcessBatchTaskPayload {
  /** Public link token (volunteer path). Supply this OR `linkId`. */
  token?: string;
  /** Upload-link id (admin recovery path — staged objects record linkId). */
  linkId?: string;
  batchId: string;
  objectNames: string[];
  /**
   * Which chunk of the batch this task carries (0 / omitted = the first). The
   * worker stops each chunk well inside the 1800s window and enqueues the rest
   * as chunk + 1 — see `enqueueStagedBatch`'s StagedBatchOptions.
   */
  chunk?: number;
}

/**
 * Cloud Tasks task id for a batch chunk. Chunk 0 keeps the bare batchId, so a
 * duplicate /complete still dedups exactly as before; a continuation gets its
 * own id, because the queue refuses to reuse a name for a while after its task
 * ran — a continuation sharing its batch's name would be dropped as a duplicate.
 */
export function processBatchTaskId(batchId: string, chunk = 0): string {
  return chunk > 0 ? `${batchId}-c${chunk}` : batchId;
}

function queueParent(): string {
  return `projects/${env.GCP_PROJECT_ID}/locations/${env.UPLOAD_TASKS_LOCATION}/queues/${env.UPLOAD_TASKS_QUEUE}`;
}

/**
 * Create a Cloud Tasks task that will POST the batch to the worker endpoint.
 * Throws on failure so the caller can fall back to an inline copy. A 409
 * (task name already exists) is treated as success — the batch is already
 * queued, and the copy is idempotent anyway.
 */
export async function enqueueProcessBatchTask(
  payload: ProcessBatchTaskPayload,
  opts: { scheduleTime?: string } = {},
): Promise<void> {
  const parent = queueParent();
  const url = `https://cloudtasks.googleapis.com/v2/${parent}/tasks`;

  const accessToken = await getAccessToken();

  const workerUrl = `${env.UPLOAD_WORKER_URL.replace(/\/$/, '')}/api/internal/process-batch`;
  const body = {
    task: {
      // Name = batchId (+ chunk) so a duplicate /complete enqueues at most one task.
      name: `${parent}/tasks/${processBatchTaskId(payload.batchId, payload.chunk)}`,
      // Cloud Tasks' maximum (30 min): a batch with a ~10 GiB video needs well
      // over the old 600s. Must stay ≤ the api service's Cloud Run --timeout
      // (deploy-api.sh) or Cloud Run cuts the request before the deadline.
      dispatchDeadline: '1800s',
      // Optional: hold the task until this time. Bulk callers use it to spread
      // work out — Cloud Run packs concurrent requests onto ONE instance, and
      // each in-flight copy buffers a whole photo, so dispatching many batches
      // at once OOM-kills the container (observed on 2026-07-28). A volunteer
      // upload omits it and dispatches immediately.
      ...(opts.scheduleTime ? { scheduleTime: opts.scheduleTime } : {}),
      httpRequest: {
        httpMethod: 'POST',
        url: workerUrl,
        headers: { 'Content-Type': 'application/json', 'X-Sync-Token': env.SYNC_TRIGGER_TOKEN },
        body: Buffer.from(JSON.stringify(payload)).toString('base64'),
      },
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 409) {
    logger.info({ batchId: payload.batchId }, 'process-batch task already queued (dedup)');
    return;
  }
  if (!res.ok) {
    throw new Error(`Cloud Tasks create ${res.status}: ${await res.text()}`);
  }
}

/**
 * Whether a task is still in the queue — i.e. waiting, backing off before a
 * retry, or running (Cloud Tasks deletes a task only once its handler returned
 * 2xx or it exhausted its attempts). The recovery sweep uses this to leave a batch
 * alone while its chain is alive. Throws on anything but 200/404, so an
 * unanswerable question can never read as "dead" and trigger a re-dispatch.
 */
export async function processBatchTaskExists(taskId: string): Promise<boolean> {
  const accessToken = await getAccessToken();
  const res = await fetch(`https://cloudtasks.googleapis.com/v2/${queueParent()}/tasks/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return false;
  if (res.ok) return true;
  throw new Error(`Cloud Tasks get ${res.status}: ${await res.text()}`);
}
