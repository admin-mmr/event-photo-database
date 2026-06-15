# Automated (No-Touch) Photo Indexing — Implementation

**Status:** implemented (code + tests landed), pending deploy. See `AUTOMATED_INDEXING_RUNBOOK.md` for rollout.
**Author:** IT
**Date:** 2026-06-15

## Problem

Photos became searchable in Find Me only when an admin manually fired `POST /api/events/:id/index` (or ran `gcloud run jobs execute photo-indexer`). Nothing watched Drive, so a photographer dropping files into the event folder triggered no indexing — the matcher returned `event_not_indexed` ("ask an admin to run indexing"). The only scheduled automation, `findme-drive-sync`, syncs *event metadata* from the master Sheet daily, not photos.

A secondary problem: even when triggered, the indexer processed an event in a single serial loop (download → embed → 2 derivative encodes → 3 GCS writes → 1 Firestore write, per photo) on a CPU-only Cloud Run Job pinned to `--parallelism=1`, with a 1-hour task timeout. Large events were slow and could time out.

The result mapped poorly onto the intended five-step workflow: admin creates event → admin creates upload link → user drags files to Drive → **files are indexed on arrival** → user submits a selfie and gets matches that grow over time. Steps 1–3 worked; step 4 required a human, and step 5 therefore stalled.

## Goal

Close the gap between "files land in Drive" and "files are indexed," with no manual touch, while staying inside the existing zero-cost / keyless architecture (no Cloud SQL, no new managed services, no service-account keys).

## Design

The automation has two trigger layers plus a throughput fix and a UX fix.

### 1. Primary trigger — end-of-batch from the upload page (event-driven)

The gas-app upload page already knows when a volunteer finishes a batch: `serverCompleteUpload` writes the upload-log record. That is the natural, no-touch chokepoint. It now calls `POST /api/events/:id/index` on the cloud-webapp api the moment a batch with `fileCount > 0` completes.

This is genuinely event-driven and avoids the renewal/webhook overhead of Drive `files.watch` channels (which expire and need a renewal cron). It is also *not* the abandoned `firestoreClient.ts` GAS-push path — it does not replicate per-photo metadata from GAS; it fires one lightweight HTTP trigger and lets the existing indexer do the work. The call is best-effort: the upload is already complete and recorded once bytes are in Drive, so a failed or unconfigured trigger is logged and swallowed, never surfaced to the volunteer (same philosophy as the legacy special-folders rebuild, `DESIGN_DECISIONS.md §11`).

### 2. Safety-net trigger — scheduled change-scan (polling backstop)

A new Cloud Scheduler job (`findme-index-scan`, every 10 minutes) hits `POST /api/admin/index-scan`. The endpoint triggers the indexer for every active event that has a `driveFolderId` and is not already running. Because the indexer is idempotent (md5 + modelVersion diff), an event with no new photos costs only a Drive listing plus a no-op store rewrite. This catches anything the end-of-batch call missed (a failed trigger, files added straight to Drive outside the upload page, etc.). The scan is bounded by an active window (`activeWithinDays`, default 21) and a per-run `limit` (default 25) so cost stays predictable.

Both triggers authenticate via the existing shared-secret machine path (`X-Sync-Token` / `SYNC_TRIGGER_TOKEN`), extracted into a reusable `allowCronOrAdmin` middleware so the same gate protects sync, the index trigger, and the scan. Human admins still reach all three through the normal Firebase `requireAuth → requireAdmin` path.

### 3. Throughput — parallelize the indexer

The indexer's heavy stage now runs on a `ThreadPoolExecutor` (configurable via `INDEX_CONCURRENCY`, default 8). The work is dominated by Drive download + three GCS uploads (I/O) and ONNX inference (native code that releases the GIL), so threads overlap well even on a small vCPU count. Vectors and the manifest are still assembled in Drive-listing order regardless of completion order, so the stored `.npy`/`manifest.json` are byte-identical across runs and idempotency holds. Reused (unchanged) photos and per-photo skip-on-error semantics are preserved. The deploy config was bumped to `--cpu=4 --memory=4Gi` to give the pool cores.

### 4. UX — honest in-progress state instead of "ask an admin"

With indexing automated, `event_not_indexed` almost always means a run is in progress or just queued, not something an admin forgot. The `/api/findme/search` 409 now reads the event's live `indexState` and returns a friendly, retryable message ("We're still gathering this event's photos — check back in a few minutes and your matches will appear automatically") plus `status` and `retryable: true` so the web UI can poll and show progress rather than a dead end.

## Changes by file

cloud-webapp/indexer/job.py — parallelized the download/embed/upload stage with a thread pool; deterministic in-order assembly; `INDEX_CONCURRENCY` env + `concurrency` param. (`derivatives` import hoisted to module top.)

cloud-webapp/infra/scripts/deploy-indexer.sh — `--cpu=4 --memory=4Gi`, added `INDEX_CONCURRENCY=8` to the job env.

cloud-webapp/api/src/middleware/cronAuth.ts — **new.** Shared `allowCronOrAdmin` + `validCronToken`, extracted from `sync.ts`.

cloud-webapp/api/src/routes/sync.ts — now imports the shared middleware (behavior unchanged).

cloud-webapp/api/src/routes/events.ts — `POST /events/:id/index` now uses `allowCronOrAdmin` (admin **or** machine token); added `POST /admin/index-scan` (the safety-net scan).

cloud-webapp/api/src/routes/findme.ts — `event_not_indexed` 409 now returns the live `indexState` + a friendly, retryable message.

cloud-webapp/infra/scripts/provision-index-scan-scheduler.sh — **new.** Provisions the `findme-index-scan` Cloud Scheduler job (every 10 min).

gas-app/src/config/superAdmins.ts — `getFindMeApiUrl()`, `getIndexTriggerToken()`, `isIndexTriggerConfigured()` (read `FINDME_API_URL` / `INDEX_TRIGGER_TOKEN` Script Properties).

gas-app/src/services/indexTriggerClient.ts — **new.** Best-effort `triggerEventIndex(eventId)` → `POST /api/events/:id/index` with the machine token.

gas-app/src/routes/uploadHandlers.ts — `serverCompleteUpload` fires `triggerEventIndex` after a successful batch (best-effort, non-fatal).

cloud-webapp/api/test/events.test.ts — added tests for the machine-token path and the `index-scan` endpoint.

## Configuration

API (Cloud Run `event-photo-api`): `SYNC_TRIGGER_TOKEN` must be set (it already is, for the daily sync) — the index trigger and scan reuse it. `INDEXER_JOB_NAME`, `GCP_REGION` already exist.

Indexer Job (`photo-indexer`): `INDEX_CONCURRENCY` (default 8).

gas-app (Script Properties): `FINDME_API_URL` (the `event-photo-api` base URL) and `INDEX_TRIGGER_TOKEN` (must equal the api's `SYNC_TRIGGER_TOKEN`). Until both are set, `triggerEventIndex` no-ops cleanly, so the gas-app keeps working unchanged and the scheduled scan still provides automation.

IAM prerequisite (already documented in `indexerJob.ts`): `api-runtime@` needs `roles/run.invoker` on the `photo-indexer` job so both the route and the scan can launch executions.

## How the five-step workflow now behaves

1. Admin creates event → Firestore (daily reconciler; can be made instant by having the gas-app call `/api/admin/sync` on event creation — see "Remaining").
2. Admin creates upload link → Firestore (same reconciler).
3. User drags files → Drive (unchanged, direct-to-Drive).
4. **Files land in Drive → indexed automatically:** end-of-batch trigger fires immediately; the 10-minute scan is the backstop. The parallelized indexer keeps pace.
5. **Selfie → matches that grow over time:** falls out of (4) — each new batch re-indexes the event and the matcher sees the new photos. While a run is in flight, the user sees a friendly in-progress state instead of an error.

## Testing

- Indexer: `cd cloud-webapp/indexer && python -m pytest -q` — 10/10 pass; idempotency/byte-equality, reuse, skip, model-bump, force all preserved under the new thread pool.
- API: `cd cloud-webapp/api && npx vitest run` — 41/41 pass, including new coverage for the machine-token index path and the `index-scan` endpoint (trigger, skip folderless, skip running, active-window).
- gas-app: `npx tsc --noEmit` clean; `npx jest uploadHandlers` 10/10 pass.

## Remaining / future work (not in this change)

- **Instant metadata sync:** have the gas-app call `/api/admin/sync` right after creating an event or upload link, so steps 1–2 don't wait for the daily reconciler. Small follow-up using the same token.
- **Selfie reuse / enrollment (PRD D6/D7):** the reference selfie is still in-memory per request (`findme.ts`) and not persisted; "reuse my previous selfie" is not yet built. This is independent of indexing and tracked in the dev plan.
- **Task-sharding the indexer** (`--parallelism > 1` with per-task work splitting) if any single event grows large enough that in-process threads aren't enough; the thread pool covers expected event sizes today.
- **Web UI polling:** front-end should consume the new `retryable`/`status` fields to auto-retry the search when indexing finishes.
