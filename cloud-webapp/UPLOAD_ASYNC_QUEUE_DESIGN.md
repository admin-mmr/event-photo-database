# Design: async Drive-copy queue + phased upload status

## Problem

Today the volunteer upload finishes in two server calls:

1. The browser uploads each file directly to the **GCS staging bucket** via a
   resumable session (`/volunteer/upload/session`). Resumable + per-file, so a
   closed tab resumes from the last byte.
2. The browser calls `/volunteer/upload/complete`, and `enqueueStagedBatch`
   **synchronously**, inside that one HTTP request: lists the Drive folder for
   dedup, builds the `Event/Club/tag/batch` folders, downloads every staged
   object from GCS and re-uploads it to Drive, deletes the staged copy, triggers
   the indexer, and appends the `Upload_Log` row. Only then does it respond.

Two problems with step 2:

- **It can exceed Cloud Run's 60s request timeout.** Each file is buffered in
  memory (`file.download()`) and re-uploaded to Drive within the request. A
  large batch (dozens of multi-MB photos, or any video) can blow the timeout —
  the user sees a failure even though their bytes are safe in GCS.
- **It conflates "your bytes are safe" with "saved to Drive + indexed".** The
  user can't be told "done" until the slow part finishes, even though their
  device was free the moment step 1 completed.

## Goal

- Return success to the volunteer as soon as the bytes are in GCS.
- Do the Drive copy + index trigger in the **background**, off the request path,
  with no timeout ceiling.
- Surface the real phases to the user with live status:
  **uploading → received → saving to library → indexing → visible in gallery.**
- Stay within the zero-idle-cost policy (scale-to-zero, free-tier-covered).

## Proposed architecture

```
browser ──(resumable PUT)──▶ GCS staging bucket
   │
   └─(POST /complete)──▶ event-photo-api
                              │  1. write upload_batches/{batchId} = {phase:"received", ...}
                              │  2. enqueue ONE Cloud Tasks task (HTTP target → worker)
                              │  3. respond { phase:"received" }  ◀── user sees "Upload received"
                              ▼
                        Cloud Tasks queue (retries, rate limit)
                              │ push (OIDC-authed HTTP)
                              ▼
                 POST /internal/process-batch  (worker; same api service, or its own)
                              │  phase:"saving"  → copy GCS→Drive (current enqueueStagedBatch logic)
                              │  phase:"indexing"→ triggerIndexJob
                              │  phase:"ready"   → set when events.indexState shows the run finished
                              ▼
                        upload_batches/{batchId} updated at each step
                              ▲
browser ──(GET /volunteer/upload/status/:batchId, poll ~3s)──┘  live phase + counts
```

### Components

- **`upload_batches/{batchId}` Firestore doc** — the single source of truth for
  status. Fields: `eventId`, `linkId`, `phase`
  (`received|saving|indexing|ready|error`), `total`, `copied`,
  `skippedDuplicates`, `skippedDuplicateNames`, `failed`, `batchFolderName`,
  `createdAt`, `updatedAt`, `error?`. Written by `/complete` (initial) and the
  worker (each transition).
- **Cloud Tasks push queue** — one task per batch, HTTP target = the worker
  endpoint, authenticated with an OIDC token minted for a dedicated service
  account. Built-in retries with backoff cover transient Drive/GCS errors;
  `dispatchDeadline` set to the worker's max runtime (can be minutes, unlike the
  60s web request).
- **Worker endpoint `POST /internal/process-batch`** — runs the existing
  `enqueueStagedBatch` body, but updates `upload_batches/{batchId}` as it goes.
  Can live on the same `event-photo-api` service (simplest) or a dedicated
  scale-to-zero Cloud Run service if we want to isolate its CPU/memory. Protected
  by verifying the Cloud Tasks OIDC token (audience = the worker URL) — same
  trust model as the existing machine callers, no `allUsers` exposure of the
  internal path.
- **Status endpoint `GET /volunteer/upload/status/:batchId`** — returns the
  batch doc; the link token authorizes it. The client polls every ~3s while not
  `ready`/`error` (or we could use a Firestore client listener; polling is
  simpler and avoids shipping Firestore creds to the public page).

### Client phases (already half-built)

The UI already has `uploading → finalizing → done`. With this change:

- `uploading` — bytes → GCS (unchanged; resumable, safe to close tab).
- `received` — `/complete` returned; bytes safe, queued. **This is the success
  moment.** "Upload received ✓ — you can close this page."
- `saving` / `indexing` — driven by polling the status endpoint.
- `ready` — indexer finished; "Your photos are in the gallery."

The user can leave any time after `received`; the background pipeline is
decoupled from their session.

## Idempotency, retries, ordering

- **Dedup already makes the copy idempotent.** `enqueueStagedBatch` skips files
  already in Drive (credited name + size) and within the batch, so a Cloud Tasks
  retry that partially ran before failing won't double-write — it re-skips what
  it already copied.
- **Task de-duplication.** Name the task after `batchId` so an accidental double
  `/complete` enqueues only one task.
- **Indexer 409.** The worker should treat `already_running` as success (the
  running scan will pick up the new Drive files; the indexer dedups by content
  hash). Optionally debounce: only trigger if `events.indexState` isn't already
  running, else rely on the in-flight run.
- **Staged cleanup** stays best-effort with the bucket lifecycle rule as backstop
  (unchanged).

## Cost

Both queue options scale to zero and are free-tier-covered at this volume:

- **Cloud Tasks**: first **1,000,000 operations/month free**, then $0.40/M (an
  operation = an API call or a push delivery attempt). One batch ≈ a few
  operations, so realistically free. Source: https://cloud.google.com/tasks/pricing
- **Cloud Run** worker: first **2,000,000 requests/month free** plus the CPU/GiB
  free tier; `--min-instances=0` so nothing is held warm. Source:
  https://cloud.google.com/run/pricing

No new always-on resource, consistent with the CLAUDE.md zero-idle-cost rule.

## Why Cloud Tasks (vs Pub/Sub)

Cloud Tasks is the better fit for "run this one unit of work reliably, with
retries and a long deadline, against an HTTP endpoint." It gives per-task
scheduling, OIDC auth to the target, and backoff out of the box. Pub/Sub is
designed for fan-out event streaming to many subscribers — more than we need for
a single per-batch job. (If we later want multiple independent consumers of an
"upload completed" event, Pub/Sub via Eventarc becomes attractive; not now.)

## Migration plan (incremental, low-risk)

1. **Status doc + endpoint, no behaviour change.** Write `upload_batches/{id}`
   in `/complete` and expose the status GET. Client starts polling. (Drive copy
   still synchronous — but now observable.)
2. **Add the worker endpoint** that runs `enqueueStagedBatch` and updates the
   status doc. Keep `/complete` calling it inline behind a flag.
3. **Flip to Cloud Tasks.** `/complete` enqueues a task and returns `received`
   immediately; the worker does the copy. Provision the queue, the worker SA,
   and the OIDC binding (one-time, documented in the runbook like the indexer
   `run.developer` grant).
4. **Tune.** Set `dispatchDeadline`, retry config, and (optionally) split very
   large batches into per-file tasks if single-batch runtime gets long.

## What stays the same

- The resumable browser→GCS upload (step 1) is unchanged — it's already the
  right design.
- `enqueueStagedBatch`'s copy/dedup/credit/folder logic is reused verbatim; it
  just moves from "inside the request" to "inside the worker," and gains status
  writes.
- `Upload_Log` and the indexer trigger are unchanged in behaviour.

## Open questions

- Worker on the existing `event-photo-api` (simplest, shares the image) vs a
  dedicated `upload-worker` service (isolates memory for big video copies, its
  own scaling). Recommend starting on the existing service; split out only if
  copy memory/CPU contends with web traffic.
- Per-batch task vs per-file tasks. Per-batch is simpler and fine for typical
  sizes; per-file gives finer retry granularity and parallelism for huge batches.
  Start per-batch.
- Polling vs Firestore client listener for status. Start with polling (no client
  creds, works on the public link page).
