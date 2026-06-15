/**
 * indexerJob.ts — trigger the photo-indexer Cloud Run Job (dev plan M1.4).
 *
 * Deviation from the original plan (route → Pub/Sub → Job): we call the
 * Cloud Run Jobs API directly with per-execution env overrides. Zero extra
 * infra (no Eventarc wiring), same admin-triggered semantics; Pub/Sub was a
 * pgvector-era idea for per-photo fanout, which the flat-file store made
 * unnecessary. The `photo-index-requests` topic stays provisioned for the
 * M2+ scheduled change-scan if we want it.
 *
 * IAM prerequisite: api-runtime@ needs roles/run.developer on the photo-indexer
 * job. We pass per-execution env overrides (EVENT_ID/FORCE_REINDEX), so the
 * platform checks run.jobs.runWithOverrides — which roles/run.invoker does NOT
 * grant (it only has run.jobs.run). run.developer includes both:
 *
 *   gcloud run jobs add-iam-policy-binding photo-indexer --region=us-central1 \
 *     --member="serviceAccount:api-runtime@mmr-data-pipeline.iam.gserviceaccount.com" \
 *     --role="roles/run.developer"
 */

import { GoogleAuth } from 'google-auth-library';
import { env } from '../lib/config.js';

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

export interface TriggerResult {
  /** Execution resource name: projects/…/jobs/photo-indexer/executions/<id> */
  execution: string;
}

export async function triggerIndexJob(
  eventId: string,
  opts?: { force?: boolean },
): Promise<TriggerResult> {
  const project = env.GCP_PROJECT_ID ?? (await auth.getProjectId());
  const url =
    `https://run.googleapis.com/v2/projects/${project}/locations/${env.GCP_REGION}` +
    `/jobs/${env.INDEXER_JOB_NAME}:run`;

  const envOverrides = [{ name: 'EVENT_ID', value: eventId }];
  if (opts?.force) envOverrides.push({ name: 'FORCE_REINDEX', value: '1' });

  const client = await auth.getClient();
  const res = await client.request<{ metadata?: { name?: string }; name?: string }>({
    url,
    method: 'POST',
    data: { overrides: { containerOverrides: [{ env: envOverrides }] } },
  });

  // The Jobs API returns a long-running operation; metadata.name is the execution.
  const execution = res.data.metadata?.name ?? res.data.name ?? 'unknown';
  return { execution };
}
