# CLAUDE.md — project notes for Claude

## Local environment

- The dev machine is **macOS (zsh)**. `watch` is **NOT installed by default** on
  macOS — do not suggest `watch -n N ...`; it errors with `command not found`.
  Use a shell loop instead, or `brew install watch` if the user wants it:

  ```bash
  while :; do clear; <command>; sleep 15; done
  ```

- In zsh, unquoted parentheses are special (globbing). Always quote URLs/args
  containing them, e.g. Firestore REST paths with `databases/(default)/...`.

## Monitoring the Cloud Run indexer job

- **Tail logs live** (closest to `tail -f`) with the Logging API:

  ```bash
  gcloud beta logging tail \
    'resource.type="cloud_run_job" AND resource.labels.job_name="photo-indexer"' \
    --project=mmr-data-pipeline --format='value(textPayload)'
  ```

  (Needs the beta component: `gcloud components install beta`.)

- **Poll execution status** (the `watch` replacement):

  ```bash
  while :; do clear; \
    gcloud run jobs executions list --job=photo-indexer \
      --region=us-central1 --project=mmr-data-pipeline --limit=3; \
    sleep 15; done
  ```

- **Read a chunk of recent logs** (one-shot, no streaming):

  ```bash
  gcloud logging read \
    'resource.type="cloud_run_job" AND resource.labels.job_name="photo-indexer"' \
    --project=mmr-data-pipeline --limit=50 --freshness=1h --format='value(textPayload)'
  ```

- **Error-level logs from the api service** (shows the real exception, e.g. the
  `jsonPayload.err.message`, not just the request status):

  ```bash
  gcloud logging read \
    'resource.type="cloud_run_revision" AND resource.labels.service_name="event-photo-api" AND severity>=ERROR' \
    --project=mmr-data-pipeline --limit=5 \
    --format='value(jsonPayload.err.message, jsonPayload.msg, textPayload)'
  ```

## Cloud Run / deploy gotchas (learned the hard way)

- **`event-photo-api` must be PUBLICLY invokable** (`allUsers`/`run.invoker`);
  the app does its own auth (`requireAuth`/`requireAdmin`/`X-Sync-Token`).
  Classic Firebase Hosting → Cloud Run rewrites require a public service — there
  is NO Hosting service account to authorize (the
  `service-<num>@gcp-sa-firebasehosting…` SA does not exist for classic
  rewrites). If the service is private, the browser's Firebase token (not an IAM
  credential) is rejected by Cloud Run IAM with an **HTML 401** before reaching
  the app (no app log line).
  - **Do NOT deploy with `--no-allow-unauthenticated`** — it strips the
    `allUsers` binding and breaks the web app. `deploy-api.sh` now passes
    neither auth flag, leaving IAM untouched.
  - The org's **DRS** policy (`iam.allowedPolicyMemberDomains`) blocks adding
    `allUsers`, so restoring it needs an Org Policy Admin to add a
    project-scoped exception, then:
    `gcloud run services add-iam-policy-binding event-photo-api --region=us-central1 --member=allUsers --role=roles/run.invoker`.
  - A raw `curl` to the `*.run.app` URL still can't exercise Firebase
    `requireAuth` (Cloud Run consumes the `Authorization` bearer for IAM);
    machine callers use the `X-Sync-Token` header instead.
- **`deploy-api.sh` uses `--update-env-vars` (merge), not `--set-env-vars`.**
  `--set-env-vars` wipes every var not re-listed — it repeatedly blanked
  `MATCHER_URL` / `SYNC_TRIGGER_TOKEN`. Optional vars are only set when exported.
  TODO worth doing: move `SYNC_TRIGGER_TOKEN` into Secret Manager via
  `--set-secrets` so deploys can't blank it.
- **Triggering the indexer job needs `roles/run.developer`** on the job for
  `api-runtime@`, not `roles/run.invoker` — we call the Jobs API with env
  overrides, which checks `run.jobs.runWithOverrides` (invoker only has
  `run.jobs.run`).
- **`curl -d` defaults to form-encoding.** Always pass
  `-H "Content-Type: application/json"` or Express's JSON parser ignores the
  body (e.g. `{"force":true}` silently became `force=false`).
- A stale `indexState: "running"` (from a crashed run) blocks new triggers with
  `409 already_running`; clear it by triggering once with `{"force":true}`.

## Indexer notes

- One Cloud Run Job execution = one event. Per-event vectors live as flat
  `.npy` files in the derivatives bucket; the matcher does in-memory cosine.
- The store/manifest are written only at the END of a run, so a killed run makes
  no progress. Large events (~1600 photos, CPU) need enough memory (8 GiB),
  modest `INDEX_CONCURRENCY` (≈4 to avoid OOM), and the Drive-token refresh on
  401 (the access token expires ~1h mid-run). Follow-up worth doing:
  incremental checkpointing so interrupted runs persist progress.
