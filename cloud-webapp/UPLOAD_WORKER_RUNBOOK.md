# Runbook: turn on the background upload worker (Cloud Tasks)

This enables step 3 of `UPLOAD_ASYNC_QUEUE_DESIGN.md`: `/complete` returns the
moment the bytes are in GCS and hands the Drive copy to a Cloud Tasks queue that
calls `POST /api/internal/process-batch`. Until these steps are done, the flag
stays off and uploads copy inline (current behaviour) — nothing breaks.

All commands target `mmr-data-pipeline` / `us-central1`. Run them once.

## 1. Enable the Cloud Tasks API

```
gcloud services enable cloudtasks.googleapis.com --project=mmr-data-pipeline
```

## 2. Create the queue

```
gcloud tasks queues create upload-process --location=us-central1 --project=mmr-data-pipeline
```

Optional: cap throughput / retries (defaults are fine to start). The copy is
idempotent (dedups by credited name + size), so retries are safe.

```
gcloud tasks queues update upload-process --location=us-central1 --project=mmr-data-pipeline \
  --max-attempts=5 --max-dispatches-per-second=5
```

## 3. Let the api runtime enqueue tasks

The api runs as `api-runtime@`. It needs to create tasks on the queue:

```
gcloud tasks queues add-iam-policy-binding upload-process \
  --location=us-central1 --project=mmr-data-pipeline \
  --member="serviceAccount:api-runtime@mmr-data-pipeline.iam.gserviceaccount.com" \
  --role="roles/cloudtasks.enqueuer"
```

## 4. Find the worker URL

The task posts back to this same service. Use its Cloud Run URL:

```
gcloud run services describe event-photo-api --region=us-central1 --project=mmr-data-pipeline --format='value(status.url)'
```

The worker endpoint authenticates with the `X-Sync-Token` shared secret, which
is already in the api as the `SYNC_TRIGGER_TOKEN` Secret Manager secret — Cloud
Tasks sends it in the task header. (Hardening follow-up: switch the task to an
OIDC token and have the endpoint verify it, removing the shared secret from the
task payload.)

## 5. Deploy with dispatch enabled

```
export UPLOAD_DISPATCH_TO_WORKER=true
export UPLOAD_TASKS_QUEUE=upload-process
export UPLOAD_TASKS_LOCATION=us-central1
export UPLOAD_WORKER_URL="<the status.url from step 4>"
cd cloud-webapp
./infra/scripts/deploy-api.sh mmr-data-pipeline
```

`deploy-api.sh` uses `--update-env-vars` (merge), so these persist across future
deploys even if not re-exported — except `UPLOAD_DISPATCH_TO_WORKER`, which the
script always sets (defaulting to `false`); re-export it `true` on later deploys,
or set it directly on the service.

## 6. Verify

Confirm the env on the service:

```
gcloud run services describe event-photo-api --region=us-central1 --project=mmr-data-pipeline \
  --format='json(spec.template.spec.containers[0].env)' | grep -A1 -i 'UPLOAD_'
```

Then do a real volunteer upload. Expected:

- `/complete` returns immediately with "…saving in the background."
- A task appears and drains on the queue:
  `gcloud tasks queues describe upload-process --location=us-central1 --project=mmr-data-pipeline`
- The upload page status line moves `received → saving → indexing`.
- Logs show `worker processed staged batch` from `/api/internal/process-batch`.

## Rollback

Set the flag off and redeploy (or update the live service directly):

```
gcloud run services update event-photo-api --region=us-central1 --project=mmr-data-pipeline \
  --update-env-vars=UPLOAD_DISPATCH_TO_WORKER=false
```

`/complete` immediately reverts to the inline copy. The queue and IAM can stay;
they cost nothing idle (Cloud Tasks: first 1M ops/month free).

## Cost

Cloud Tasks: first **1,000,000 operations/month free**, then $0.40/M
(https://cloud.google.com/tasks/pricing). The worker runs on the existing
scale-to-zero `event-photo-api` service (first 2M Cloud Run requests/month free).
Effectively $0 at this volume.
