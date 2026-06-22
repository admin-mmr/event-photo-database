# CLAUDE.md — project notes for Claude

## Control plane migration (gas-app → cloud-webapp)

- The admin/control plane (users, clubs, events, upload links, email, audit,
  duplicates/trash, reporting, partner API) has been reimplemented in
  `cloud-webapp/` (dev plan `GAS_MIGRATION_DEV_PLAN.md`, milestones G1–G5).
  **New control-plane work goes in `cloud-webapp/`, not `gas-app/`** (now
  deprecated — see `gas-app/DEPRECATED.md`).
- **The Google Sheet stays the source of truth.** It is human-viewable and lives
  in Google Workspace, the constant across a future Azure move. cloud-webapp
  *writes* the Sheet via the Sheets API (keyless DWD); Firestore is only a
  derived read cache. Never put secrets (e.g. partner API keys) in the Sheet —
  it is world-viewable; secrets go in env / Secret Manager.
- Control-plane writes are RBAC-guarded in middleware (`rbac.ts`) since a Sheet
  has no row-level security, and are recorded in the Audit_Log tab.
- Cutover from gas-app is operational, not code — follow `CUTOVER_RUNBOOK.md`.

## Local environment

- The dev machine is **macOS (zsh)**. `watch` is **NOT installed by default** on
  macOS — do not suggest `watch -n N ...`; it errors with `command not found`.
  Use a shell loop instead, or `brew install watch` if the user wants it:

  ```bash
  while :; do clear; <command>; sleep 15; done
  ```

- In zsh, unquoted parentheses are special (globbing). Always quote URLs/args
  containing them, e.g. Firestore REST paths with `databases/(default)/...`.

- **No `#` comments inside bash blocks.** Do not put `#` comment lines or
  trailing `# ...` inline comments in any bash code block — they don't run
  cleanly when the user pastes them. Keep commands comment-free; put any
  explanation in prose outside the code block.

## Cost policy — zero idle cost

- **Every Google Cloud process must scale to zero when idle.** No service or
  job should cost money while nothing is happening. Concretely:
  - Cloud Run **services run with `--min-instances=0`** (no warm instance held
    24/7). Do NOT set a min-instance count, and leave CPU throttling at the
    default (CPU only during requests) — an always-allocated/min-instance setup
    bills for memory + CPU around the clock even when idle. This was the source
    of a ~$2/day idle charge on the `matcher` service (2 vCPU / 8 GiB held warm)
    until it was set back to scale-to-zero.
  - Cloud Run **jobs** (e.g. `photo-indexer`) already cost only while a run is
    executing — fine as-is; don't add schedules that fire when there's no work.
  - Accept the tradeoff: scale-to-zero means a cold start on the first request
    after idle (the matcher reloads vectors into memory). If a service ever
    needs to stay warm, prefer a scheduled warm window over a permanent
    min-instance, and document why here.
- **Verify nothing is silently always-on:** list services with their min-scale
  and CPU-throttle so a stray warm instance is obvious.

  ```bash
  gcloud run services list --project=mmr-data-pipeline --region=us-central1 \
    --format='table(metadata.name, spec.template.metadata.annotations["autoscaling.knative.dev/minScale"]:label=MIN, spec.template.metadata.annotations["run.googleapis.com/cpu-throttling"]:label=CPU_THROTTLE)'
  ```

## Never serve photo bytes through the Firebase Hosting `/api/**` rewrite

- **The web app reaches the api via the Firebase Hosting rewrite (`/api/**` →
  `event-photo-api`), so every byte the api streams in a response is billed
  twice: once as Cloud Run egress and again as Firebase Hosting data transfer
  ($0.15/GB after the 10 GB/mo free tier).** Originals are the heavy bytes in
  this app. A single live event day of attendees using "Save to Photos" and the
  full-res lightbox — which used to fetch originals *through* the api — spiked
  the Hosting line to ~$3 in one day (it looked tiny only because a 13-month
  billing chart averaged it away). Hosting is **not** a per-day/idle cost; it's
  pure egress, and the spike scales with originals downloaded per event.
- **Rule: deliver originals only via short-lived signed GCS URLs, never by
  piping `createReadStream()`/`archiver` into the response.** Thumbnails/`web`
  derivatives already do this (signed URLs straight from GCS → browser, which
  also dodges Hosting). The originals paths now match:
  - `GET /api/events/:id/photos/:photoId/original` **302-redirects** to a signed
    URL (`signOrigUrl`). The client's `fetch(...).blob()` follows it; the browser
    drops `Authorization` on the cross-origin hop and the signed URL carries its
    own auth.
  - `POST /api/events/:id/download` returns **JSON of signed URLs** (one call
    signs the whole selection, keeping the `downloadRateLimit` budget). The
    browser assembles the ZIP itself via `web/src/lib/zip.ts` (dependency-free,
    STORE method — photos are already compressed) + `lib/zipDownload.ts`. The old
    server-side `archiver` ZIP was removed (dep dropped from `api/package.json`).
- **Signed-URL blob reads need bucket CORS.** `<img>`/thumbnail loads don't, but
  `fetch(signedUrl).blob()`/`.arrayBuffer()` is a cross-origin read of
  `storage.googleapis.com`, so the **derivatives bucket needs a CORS policy**.
  Apply/refresh it (idempotent) with:

  ```bash
  ./cloud-webapp/infra/scripts/provision-derivatives-cors.sh mmr-data-pipeline https://mmr-data-pipeline.web.app
  ```

  Symptom of missing CORS: Save-to-Photos / Download-ZIP fail in the browser
  console with a CORS error while the signed URL itself opens fine in a new tab.

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
- **Dockerfiles must COPY source by glob, never a hand-kept filename list.** The
  indexer image shipped without `capture_time.py` because the Dockerfile had an
  explicit `COPY indexer/job.py indexer/drive.py …` list that nobody updated when
  the module was added — the build succeeded and the job only crashed at runtime
  with `ModuleNotFoundError: No module named 'capture_time'`. Use
  `COPY indexer/*.py ./` (and the matcher equivalent) so new modules are included
  automatically; keep tests out of the image via `.dockerignore`
  (`**/test_*.py`, `**/conftest.py`) rather than by curating the COPY line. When
  adding a new local module, also confirm it isn't excluded by `.gcloudignore`
  (the Cloud Build upload filter) or it won't reach the build context at all.
  - **`.dockerignore` is resolved at each image's build-context root, and our
    contexts differ:** the api/indexer build from `cloud-webapp/` (use
    `cloud-webapp/.dockerignore`), but the matcher builds from `cloud-webapp/matcher/`
    (`deploy-matcher.sh` submits `$REPO_ROOT/matcher`) so it needs its own
    `cloud-webapp/matcher/.dockerignore` — the parent one does NOT apply. Keep
    both in sync when changing exclude rules.

## Indexer notes

- One Cloud Run Job execution = one event. Per-event vectors live as flat
  `.npy` files in the derivatives bucket; the matcher does in-memory cosine.
- The store/manifest are written only at the END of a run, so a killed run makes
  no progress. Large events (~1600 photos, CPU) need enough memory (8 GiB),
  modest `INDEX_CONCURRENCY` (≈4 to avoid OOM), and the Drive-token refresh on
  401 (the access token expires ~1h mid-run). Follow-up worth doing:
  incremental checkpointing so interrupted runs persist progress.

## Indexer speed vs. free tier

- **Embedding is CPU-bound ONNX**, so throughput scales ~linearly with vCPUs.
  `deploy-indexer.sh` now defaults to `--cpu=8 --memory=12Gi` and
  `INDEX_CONCURRENCY=8` (was 4 / 8 GiB / 4). For a one-off bigger/faster run
  without redeploying, override at execute time:

  ```bash
  gcloud run jobs update photo-indexer --region=us-central1 --project=mmr-data-pipeline --cpu=8 --memory=12Gi --update-env-vars=INDEX_CONCURRENCY=8
  ```

- **Bumping CPU is free-tier-neutral; bumping memory is not (unless it speeds up
  the run).** Cloud Run **Jobs** have their own monthly free tier in us-central1
  (Tier 1), separate from the services pool: **240,000 vCPU-seconds and 450,000
  GiB-seconds**. Billing is resource × wall-time, so doubling CPU while halving
  runtime leaves vCPU-seconds ≈ unchanged — work is constant. A ~1,134-photo
  event run costs ≈ 9,600 vCPU-s and ≈ 19,200 GiB-s either way, so ~20–25 such
  runs/month stay free (memory/450k GiB-s is the binding constraint). The trap:
  raising memory without a matching runtime drop (e.g. if a run is I/O-bound on
  Drive) just burns more GiB-seconds — so raise CPU/`INDEX_CONCURRENCY` freely
  but keep memory only as high as needed to avoid OOM (12 GiB at concurrency 8).
- **GPU is never free.** An L4 is ~$0.000187/sec (~$0.67/hr) on top of CPU+memory
  and isn't covered by any free tier; reserve it for events large enough to
  justify a few cents each. Jobs bill the full instance lifetime (model load +
  startup), minimum 1 minute. Source: https://cloud.google.com/run/pricing
