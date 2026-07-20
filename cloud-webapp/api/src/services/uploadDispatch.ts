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

import { GoogleAuth } from 'google-auth-library';

import { env } from '../lib/config.js';
import { logger } from '../lib/logger.js';

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

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
  token: string;
  batchId: string;
  objectNames: string[];
}

/**
 * Create a Cloud Tasks task that will POST the batch to the worker endpoint.
 * Throws on failure so the caller can fall back to an inline copy. A 409
 * (task name already exists) is treated as success — the batch is already
 * queued, and the copy is idempotent anyway.
 */
export async function enqueueProcessBatchTask(payload: ProcessBatchTaskPayload): Promise<void> {
  const parent = `projects/${env.GCP_PROJECT_ID}/locations/${env.UPLOAD_TASKS_LOCATION}/queues/${env.UPLOAD_TASKS_QUEUE}`;
  const url = `https://cloudtasks.googleapis.com/v2/${parent}/tasks`;

  const client = await auth.getClient();
  const tokenResp = await client.getAccessToken();
  const accessToken = typeof tokenResp === 'string' ? tokenResp : tokenResp.token;
  if (!accessToken) throw new Error('could not mint cloud-platform token for Cloud Tasks');

  const workerUrl = `${env.UPLOAD_WORKER_URL.replace(/\/$/, '')}/api/internal/process-batch`;
  const body = {
    task: {
      // Name = batchId so a duplicate /complete enqueues at most one task.
      name: `${parent}/tasks/${payload.batchId}`,
      // Cloud Tasks' maximum (30 min): a batch with a ~10 GiB video needs well
      // over the old 600s. Must stay ≤ the api service's Cloud Run --timeout
      // (deploy-api.sh) or Cloud Run cuts the request before the deadline.
      dispatchDeadline: '1800s',
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
