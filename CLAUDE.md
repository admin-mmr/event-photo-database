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

## Duplicate-file removal (three layers, don't confuse them)

- "Duplicates" means three different things in this repo; a bug report about
  duplicates has to be pinned to the right layer first:
  1. **Duplicate photos in the index** — the indexer collapses byte-identical
     images by Drive's `md5Checksum` (`indexer/job.py`, `duplicateCount`), so
     search/gallery show one copy. Audit with
     `GET /api/events/:id/duplicates`. Nothing is deleted.
  2. **Duplicate entries in the managed folders** — `dedupePhotosByContent` /
     `planShortcutDedupe` keep Photos_NNN / Album from linking the same content
     twice, and `POST /api/admin/folders/dedupe/:eventId` trashes duplicate
     *managed folders* (two "Album" folders from a raced rebuild).
  3. **Duplicate FILES still sitting in Drive** — the actual redundant uploads.
     Layers 1 and 2 only ignore them; the tool below is what removes them.
- **The tool:** `GET /api/admin/duplicates/:eventId` scans the event's live Drive
  tree and reports the groups (`api/src/services/duplicateFilesService.ts`);
  `POST /api/admin/duplicates/:eventId/remove` is a dry run by default and, with
  `apply: true`, **QUEUES** the removal and returns `202` + a `batchId`.
  `POST /api/admin/duplicates/drain` then does the work in bounded ticks
  (`api/src/services/duplicateRemovalQueue.ts`) and
  `GET /api/admin/duplicates/batch/status` reports progress. Admin UI at
  `/admin/duplicates`; shell wrapper
  `./cloud-webapp/infra/scripts/remove-duplicate-files.sh [--apply] [event-id …]`
  (machine token, same `allowCronOrAdmin` gate as `resync-names`).
- **Non-negotiables baked into the service** — keep them if you touch it:
  - **DRY RUN unless the body says `apply: true`** (truthy-but-not-`true` must
    not write), matching the resync-names convention.
  - **The surviving copy is the first in `relPath` order** — the exact rule
    `indexer/job.py` uses when it collapses by md5. Diverge and the tool trashes
    the file the live index points at, so the gallery loses that photo until the
    next re-index. Sort by code point (Python's `sorted()`), NOT `localeCompare`.
  - **Removal is a soft delete**, reusing the G5.1 lifecycle: Drive trash +
    a `Deleted_Files` row + `removeShortcutsForTargets` + public-index refresh +
    an audit row. Never `files.delete` — the purge job owns permanent deletion.
    The Sheet row is written only AFTER the trash call succeeds.
  - **Managed folders are never walked** (`skipChildFolder: isManagedFolderName`)
    — their contents are deliberate copies/shortcuts, not duplicates.
  - **A file with no md5 is always kept.** Unknown ≠ duplicate.
  - **REMOVAL CANNOT RUN INSIDE ONE REQUEST — do not try again.** Two attempts to
    fit it in a single call failed identically. The work is rate-paced Drive
    traffic: every Drive call goes through the shared pacing gate in
    `driveRateLimit.ts` (~8/s, and a rate-limited call backs off up to 32s × 6),
    trashing one duplicate costs ~1 paced PATCH, and retiring the managed
    shortcuts/copies that pointed at it costs ~2–3 more (a photo is usually in
    both Photos_NNN and Album). So ~100 files ≈ 400 paced calls and a real event's
    639 duplicates ≈ 2,500 calls ≈ **5+ minutes** — against a hard 60s ceiling at
    BOTH Firebase Hosting and Cloud Run.
    - The symptom, for recognising a regression: one field call logged
      `totalMs=325833` (**5.4 minutes**) against a 45s "budget", because the
      budget was only checked *between* chunks and the post-loop shortcut sweep
      was **unbudgeted** (284 paced trashes ≈ 34s on its own). Files really were
      being trashed — `filesScanned` fell 2261 → 1746 across attempts — but Cloud
      Run killed the connection at 60.000s every time, so the admin only ever saw
      HTTP 502/504 and `remaining` never came back. Budget-tuning cannot fix this;
      the work simply does not fit.
    - **The fix: enqueue + drain**, mirroring `folderRebuildQueue.ts` (which hit
      this identical wall). The apply POST runs ONE live scan, writes the work list
      to a `duplicateRemovalBatches` doc and returns 202. Each drain tick trashes
      at most `MAX_FILES_PER_TICK` (60) files inside `TICK_BUDGET_MS` (40s),
      sweeps their managed entries under a deadline, and commits.
    - Keep these properties: progress is committed **per chunk** (a tick that dies
      loses at most one chunk's bookkeeping; re-trashing is harmless); **one lease
      per batch** so the browser-driven and scheduler drains never double-process;
      `pendingSweep` carries trashed IDs whose managed entries aren't retired yet,
      so a sweep cut short is just re-run (it is idempotent); the batch is marked
      `done` only when **both** queues are empty, and the public folder index is
      refreshed exactly **once**, there.
    - The work list lives inline in the batch doc, so it is capped
      (`ENQUEUE_CAP` 1500) to stay under Firestore's 1 MiB limit — with compact
      field names. Overflow comes back as `notEnqueued` and a re-run picks it up;
      it is never silently dropped.
  - **`removeShortcutsForTargets` takes an `eventId` AND a `deadlineMs` — pass
    both.** Unscoped it does two Drive list calls for *every* managed folder in
    the system, which can only ever find nothing (a managed folder's shortcuts
    point at photos of its own event). Undeadlined it is what actually overran the
    60s ceiling; it returns `completed: false` when cut short.
  - **Bulk work must batch its Sheet writes.** Per-file `recordSoftDelete` was
    a lock + a Sheets round-trip each; `recordSoftDeletes` appends a whole
    chunk in one call (files are trashed 10 at a time in parallel, then
    ledgered together — still strictly after their trash succeeded).
  - **The admin UI drives the drain itself** while the page is open (POST `/drain`,
    poll `/batch/status`) so progress is near-live; the
    `findme-duplicates-drain` Cloud Scheduler job
    (`provision-duplicates-drain-scheduler.sh`, every 2 min) is the backstop that
    finishes a batch after the admin navigates away. A drain with nothing queued
    is a one-query no-op, so the tick is ~free while idle.
    - The drain query needs the composite index on `duplicateRemovalBatches`
      (`status` ASC + `createdAt` ASC) in `infra/firestore.indexes.json` — without
      it every tick 500s with `FAILED_PRECONDITION`.
  - **Progress must never be reported as one summed number.** The drain's
    `remaining` is `pending` ONLY (files still to trash) and the sweep backlog is
    a separate `sweepRemaining`; cumulative `removed`/`total` come back on every
    tick. It used to return `pending.length + pendingSweep.length`, and since
    trashing a file just MOVES it between those two lists, the figure sat dead
    still — a flat `1239` through the first four ticks of a real 1,239-file batch
    while files were being removed the whole time. A working run was
    indistinguishable from a hang, which sent a live investigation looking for a
    stall that did not exist. Same reason `remove-duplicate-files.sh` takes each
    event's tally from the batch's cumulative `removed` instead of summing its own
    ticks (the scheduler drains the same batch, and those files are invisible to
    the script — it reported "1434" for a run that removed 1,444), and why its
    dry-run footer sums `candidates` and not the `BATCH_LIMIT`-capped `planned`
    (which under-reported 2,683 duplicates as 697).
  - A club_admin's scan/removal is filtered to their own club's subtree *before*
    grouping, so they never see or touch another club's files; a machine caller
    (X-Sync-Token, no Firebase user) runs unscoped — do NOT let it fall through
    to `effectiveClubScope`'s `__none__` sentinel, which silently matches nothing.
- After a removal run the index still lists the trashed copies until the event is
  re-indexed (`reindexRecommended: true` in the response says so).

## Why an upload retry must not re-copy (how the duplicates got made)

- The 2,683-duplicate backlog was not careless volunteers: it was **the upload
  retry path**. Fixing the removal tool only cleaned up after it; these are the
  invariants that stop it happening again. If you touch
  `volunteerUploadService.enqueueStagedBatch`, keep all three.
- **Winning the dedup claim is NOT proof that nobody copied these bytes.** The
  claim doc is written BEFORE the Drive copy and stamped with `driveFileId` only
  after, so a worker killed in between leaves a copy in Drive that no record
  points at. `ClaimResult.verifyBeforeCopy` marks exactly the cases where that is
  possible (a stale claim taken over from a dead holder, or a fail-open past the
  claim backend); in those cases the caller MUST look for an existing copy before
  writing. A clean fresh claim skips the lookup — otherwise it is a per-file Drive
  call on every upload for a case that cannot happen.
- **Every copied file carries its claim id in `appProperties.uploadDedupKey`**
  (`UPLOAD_DEDUP_PROPERTY`), stamped **in the same request as the bytes** so a
  file can never exist untagged. `findFileByAppProperty` is how a later attempt
  recognises its dead predecessor's work. Do not "simplify" this into a second
  `files.update` call — the whole point is that the tag lands atomically.
- **A throw does not prove the write didn't land.** Drive can commit the file and
  still fail on the way back (timeout after the create, 5xx on a retried
  multipart POST). Releasing the claim there invites the Cloud Tasks retry to copy
  the same photo again, so the catch block checks for the tag first and only
  releases when the file genuinely is not there.
- **A retry resumes the batch folder; it must not mint a new one.**
  `buildBatchFolderName()` stamps the CURRENT time, so a retry used to create a
  second `YYYYMMDD-HHMMSS_uploader` folder beside the first and re-land the
  session into it — that is the census's signature of runs ~70s apart. The name is
  persisted to `upload_batches/{batchId}` **as soon as the folder exists** (not at
  the end of the loop, which never runs on a killed pass) and reused on re-entry.
  `initUploadBatch` therefore must NOT reset `batchFolderName` on a re-init;
  blanking it there reintroduces duplicate folders by itself.

## Deleting an event (five stores, one order)

- **An event lives in five places, and deleting it means touching all five in the
  right order.** `api/src/services/eventDeletionService.ts` is the only thing that
  should do it; there was no delete at all until it existed, so any older advice
  to "just remove the row" is wrong.
  1. **Upload links** (Sheet `Upload_Links`) → **REVOKED**, rows kept. A link that
     outlives its event still accepts volunteer uploads, so revoking is FIRST.
  2. **Drive folder** → **TRASHED** + a `Deleted_Files` row, reusing the G5.1
     lifecycle. Never `files.delete` — the purge job owns permanent deletion, and
     restoring that one folder brings the whole file tree back. The managed folders
     (Photos_NNN / Videos / Album) live *inside* the event folder, so they go with
     it; only their `Special_Folders` rows need clearing.
  3. **Derivatives bucket** `<eventId>/` → deleted (regenerable by a re-index).
  4. **Sheet `Events` row** → deleted. **This is not optional**: the Sheet is SSOT
     and `reconcileService` is additive (Firestore docs with no Sheet row come back
     as `orphans`, never deleted), so dropping the Firestore doc while the row
     survives just means the next `findme-drive-sync` tick recreates the event.
  5. **Firestore** → `events`, `photos`, `uploadLinks`, `upload_batches`,
     `upload_dedup`, `match_runs`, `match_feedback`, `specialFolders`.
- **The tool:** `GET /api/admin/events/:eventId/delete-preview` reports the
  inventory; `POST /api/admin/events/:eventId/delete` is a dry run by default and,
  with `apply: true`, does the work. Admin UI: the Delete column on
  `/admin/events` (super_admins only) previews first and needs the event's name
  typed in. Shell wrapper `./cloud-webapp/infra/scripts/delete-event.sh [--apply]
  <event-id …>`.
- Non-negotiables baked in — keep them if you touch it:
  - **DRY RUN unless the body says `apply: true`**, and an apply must carry
    `confirmName` matching the event's name (or its id). The route rejects a
    mismatch with 400 `confirm_mismatch` before anything is touched.
  - **`allowCronOrSuperAdmin`, not `allowCronOrAdmin`.** Deleting an event is
    cross-club by nature (it holds every club's photos), so a club_admin must not
    be able to do it. The machine token still passes, for the shell script.
  - **STAGED UPLOADS ARE NEVER DELETED** — only counted and warned about. A staged
    object can be the only copy of a photo that never reached Drive; deleting those
    is what destroyed volunteer photos on 2026-07-27/28. The staging bucket's
    lifecycle rule reclaims them and `recover-staged-uploads.sh` can still rescue
    them in the meantime.
  - **The slow step runs BEFORE the identity records.** The derivatives sweep is
    the only unbounded work (a 1,600-photo event is ~5,000 objects, well past the
    60s Hosting ceiling), so it is deadline-bounded and, when it runs out of
    budget, the delete STOPS with `derivativesRemaining: true` and leaves the Sheet
    row + Firestore docs in place. Re-running the same call finishes the job. Do
    not "optimise" this by deleting the row first: the leftover objects would then
    have no owner and nothing would ever sweep them.
  - **A Firestore-only orphan is still deletable.** `resolveEvent` merges the Sheet
    row and the cache doc (Sheet wins per field), so a half-deleted event or one
    the reconciler reported as an orphan can be cleaned up.
  - **Every step is idempotent**, and a failing step degrades to a warning in a
    200 response rather than aborting the rest — an already-trashed Drive folder is
    skipped, a missing row deletes 0 rows.
  - `deleteEventRow` deletes by **clear-then-rewrite of the data range** (same
    shape as `deleteSpecialFolderRowsByFolderId`) and anchors below the header —
    on a header-less tab it anchors at row 1, or the first row would be left
    uncleared and then duplicated.

## Recovering volunteer uploads stranded in staging

- **"Photo missing from the gallery" is usually NOT a lost upload.** The path is
  upload → GCS staging bucket → Cloud Tasks worker copies to Drive → indexer →
  gallery. The gallery reads the Firestore `photos` cache, never live Drive, so a
  photo sitting safely in staging is invisible. Diagnose by layer before acting.
- **The tool:** `GET /api/admin/upload-recovery/:eventId` reports what is owed;
  `POST /api/admin/upload-recovery/:eventId` is a dry run by default and, with
  `apply: true`, dispatches the copies and returns `202`
  (`api/src/services/uploadRecoveryService.ts`). Shell wrapper
  `./cloud-webapp/infra/scripts/recover-staged-uploads.sh [--apply] <event-id …>`.
- **It adds NO copy logic.** Every staged object carries the metadata the normal
  path needs (`eventId`, `linkId`, `clubName`, `tag`, `originalName`,
  `photographerName`, `batchId` — stamped by `createResumableSession`), so
  recovery just re-dispatches the same Cloud Tasks work item a volunteer upload
  would and `enqueueStagedBatch` does the rest. Keep it that way; a bespoke
  copier is a second implementation to get wrong.
  - Photographer credit therefore survives even when the `upload_batches` doc is
    missing — credit lives on the OBJECT, not the batch doc. A blank
    `photographerName` is legitimate (the field is optional) and falls back to
    `volunteer` via `buildBatchFolderName`.
  - The worker accepts `linkId` as well as the public `token`, because staged
    objects record the link id, not the token. Recovery tolerates a REVOKED link
    — the bytes were accepted while it was live.
- **Safe to re-run:** objects whose md5 is already in the photo index are filtered
  out before dispatch, and the worker's own md5 claim is the authoritative check,
  so a double run cannot create duplicate Drive files. Each chunk gets a
  `<batchId>-recN` id so the Cloud Tasks name never collides with the original
  dispatch and the volunteer's status doc is left intact.
- **Check the deployed timeout first.** At anything below ~600s the worker is
  killed mid-batch and recovery reproduces the very bug it repairs; the shell
  wrapper refuses to `--apply` in that case.
- **Chunks are dispatched STAGGERED, and must stay that way.** Cloud Run packs
  concurrent requests onto one instance (`--concurrency=80`) and every in-flight
  copy buffers a whole photo, so the first live recovery — 10 chunks dispatched
  at once — OOM-killed the container at 512Mi and had to be forced through by
  hand, one task at a time. Each chunk is now scheduled after the previous should
  have finished, costed by `chunkCostMs` = `PER_OBJECT_MS` (1.2s) +
  bytes / `THROUGHPUT_BYTES_PER_SEC` (6 MB/s, measured); `estimatedMinutes`
  reports the spread. **The cost must count BYTES, not just objects** — a
  count-only estimate called 8.8 GB of video "~1 minute" when it took 21.6, and
  under-spacing is what caused the OOM. Chunks are also capped at
  `MAX_CHUNK_BYTES` (6 GiB ≈ 1,000s) so one task cannot outlive the 1800s
  request timeout no matter how few objects it holds.
  The api runs at **1Gi** for the same reason (see deploy-api.sh).

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
  `SYNC_TRIGGER_TOKEN` now comes from Secret Manager via `--set-secrets` (along
  with `CONSENT_POLICY_VERSION` and `RECAPTCHA_API_KEY`), so a deploy from a
  shell that lacks it can never blank it.
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

## Cloud Scheduler jobs (machine triggers)

- Six scheduler jobs in `us-central1` POST to `event-photo-api`, all authorized
  by the `allowCronOrAdmin` gate (`X-Sync-Token: $SYNC_TRIGGER_TOKEN`):
  `findme-drive-sync` (`/api/admin/sync`, daily reconcile — pre-existing, from
  `provision-sync-scheduler.sh`), `findme-index-scan` (`/api/admin/index-scan`,
  ~every 10 min — `provision-index-scan-scheduler.sh`), `findme-email-daily`
  (`/api/admin/email/daily` — `provision-email-daily-scheduler.sh`),
  `findme-deleted-purge` (`/api/admin/deleted-files/purge` —
  `provision-deleted-purge-scheduler.sh`) and `findme-duplicates-drain`
  (`/api/admin/duplicates/drain`, ~every 2 min —
  `provision-duplicates-drain-scheduler.sh`; backstop for the duplicate-removal
  queue, see the duplicate-file removal section above).
- **Every job needs an OIDC token, not just the header.** Cloud Run IAM runs
  before the app's `X-Sync-Token` gate, so a job without
  `--oidc-service-account-email=api-runtime@mmr-data-pipeline.iam.gserviceaccount.com`
  + `--oidc-token-audience=<service URL>` gets an HTML `403` from Google before
  the app ever sees it. `api-runtime@` already holds `run.invoker` on the service.
- **All provision scripts are idempotent (verb-aware header flag).** gcloud
  takes `--headers` on `create http` but `--update-headers` on `update http`;
  every `provision-*-scheduler.sh` now picks the flag by verb, so re-running any
  of them updates the existing job in place. (The index-scan script used to pass
  `--headers` unconditionally and die on re-run with
  `unrecognized arguments: --headers=…` — fixed.)
- **`findme-folder-rebuild`** (`/api/admin/folders/rebuild-drain`, ~every 2 min —
  `provision-folder-rebuild-scheduler.sh`) drains the managed-folder rebuild
  queue. The "All events" Photos / Videos+Albums / Migrate admin buttons used to
  run a Drive-heavy loop inline and **502 at the 60s Hosting/Cloud Run cap**; they
  now enqueue a batch (`folderRebuildBatches` Firestore collection, written by
  `api/src/services/folderRebuildQueue.ts`) and return `202`. Each drain claims
  pending events transactionally (overlapping ticks never double-process),
  rebuilds them within a ~40s budget, and
  the drain that empties a batch refreshes the public folder index once. A drain
  with nothing queued is a single-query no-op, so the 2-min tick is ~free while
  idle (respects the zero-idle-cost policy). Single-event rebuilds still run
  synchronously.
  - **The drain query needs a composite index** on `folderRebuildBatches`
    (`status` ASC + `createdAt` ASC — `oldestRunningBatch`); it lives in
    `infra/firestore.indexes.json`. It was missing at first cutover and the drain
    500'd every tick with `FAILED_PRECONDITION` (caught in Phase D). If you add a
    new indexed query here, add the index too.
  - **The api request timeout is 1800s, and CI now ASSERTS it after deploying.**
    It must stay >= the Cloud Tasks `dispatchDeadline` in `uploadDispatch.ts`
    (1800s). Both `infra/scripts/deploy-api.sh` and
    `.github/workflows/deploy-api.yml` (`API_TIMEOUT_SECONDS`) set it, and the
    workflow fails the deploy if the live revision disagrees. Verify with:

    ```bash
    gcloud run services describe event-photo-api --region=us-central1 --project=mmr-data-pipeline --format='value(spec.template.spec.timeoutSeconds)'
    ```

    **This drifted once and it cost photos.** The workflow hardcoded
    `--timeout=60` while the script said 1800, and CI is what deploys — so
    production ran at 60s. On 2026-07-27 that killed `/api/internal/process-batch`
    on ~half its requests (exactly 60.000s, HTTP 504) and stranded **1,188
    volunteer photos (~5.1 GB)** in the staging bucket: copied to Drive never,
    therefore never indexed, therefore invisible in the gallery. One batch alone
    lost 857 photos, stuck at `phase: saving`. CLAUDE.md had also asserted 1800s
    as fact, which sent the duplicate-removal 502 investigation down the wrong
    path first. Assume nothing here — the assertion is the source of truth now.
    - The long window exists for two callers: a large event's rebuild (esp.
      `migrate-shortcuts`, per-shortcut image-convert) and the upload worker
      copying a staged video (up to 10 GiB) to Drive in one attempt. The rebuild
      tolerated 60s because it is idempotent-resumable; the upload worker did not.
    - Hosting-routed user paths cap at 60s regardless (Firebase Hosting max), so
      only direct run.app machine callers get the longer window.
    - **A killed request runs no `catch`.** Anything that takes a lock/claim
      before doing work and releases it in a `catch` is silently broken by a
      timeout kill. `upload_dedup` claims are written before the Drive copy and
      stamped after, so a kill stranded them — and a stranded claim silently
      rejected every re-upload of those bytes, which is why the loss did not
      self-heal. They are now reclaimable once older than `STALE_CLAIM_MS`
      (35 min > any possible request). Apply the same reasoning to any new
      claim/lease you add.
    - **NEVER delete the staged bytes on an UNPROVEN duplicate.** This is what
      actually destroyed photos — 9 of them, across the 07-27 timeout incident
      and the 07-28 recovery OOM. `enqueueStagedBatch` used to `file.delete()`
      for every skip, but "skip" has two meanings: the md5 matched a real Drive
      file (proven — delete is right), or a *claim* said someone else holds it
      (unproven — and if that claim is a corpse from a killed request, the bytes
      never reached Drive). `claimUploadedFile` now returns
      `{ won, confirmedInDrive }` and the staged object is deleted only when the
      duplicate is confirmed. Keeping an orphan costs nothing: the bucket
      lifecycle reclaims it, and until then upload-recovery can still save it.
      The stale-claim reclaim does NOT cover this — a claim younger than
      `STALE_CLAIM_MS` is still unproven.
- **Keep all PAUSED until Phase B parity sign-off** (`CUTOVER_RUNBOOK.md`
  §A4). New jobs are `ENABLED` by default — pause right after creating. NOTE: a
  **paused** job CANNOT be triggered with `gcloud scheduler jobs run` — it fails
  `FAILED_PRECONDITION: Job.state must be ENABLED for RunJob` (an earlier note
  here wrongly claimed paused jobs were manually runnable). To exercise a job's
  target on demand while it's paused, POST the endpoint directly with the
  `X-Sync-Token` header instead (see the drain example below), or `resume` first.
  `findme-drive-sync` especially must be paused during parity since
  it writes the master Sheet (the SSOT the parity diffs read). `resume` them all
  after sign-off. (`findme-folder-rebuild` only acts when a batch is queued, so
  it is harmless to leave enabled, but keep it paused with the rest for tidiness.)

## Indexer notes

- One Cloud Run Job execution = one event. Per-event vectors live as flat
  `.npy` files in the derivatives bucket; the matcher does in-memory cosine.
- The store/manifest are written only at the END of a run, so a killed run makes
  no progress. Large events (~1600 photos, CPU) need enough memory (8 GiB),
  modest `INDEX_CONCURRENCY` (≈4 to avoid OOM), and the Drive-token refresh on
  401 (the access token expires ~1h mid-run). Follow-up worth doing:
  incremental checkpointing so interrupted runs persist progress.

## Find-Me matching: per-face quality, anchors, and the pick-time check

- **Per-face quality now lives in the manifest** (`faces_meta[].quality` =
  `{usable, frontality, face_frac, blur}`, written by `indexer/job._face_quality_meta`).
  `frontality` is a landmark yaw proxy from the SCRFD keypoints; `face_frac` is
  the face's short side over the image's short side (absolute px is not
  comparable across cameras). Two rules to keep:
  - **An event only gains the fields on `FORCE_REINDEX=1`** — a byte-unchanged
    photo reuses its stored row verbatim, so a plain re-index backfills nothing.
  - **Absent ≠ bad.** Every consumer treats a missing field as *unmeasured*, so
    pre-quality events behave exactly as before. Don't "default" it to 0.
- **Two knobs, both off/opt-in until a judged sweep says otherwise:**
  `FACE_QUALITY_WEIGHT` (candidate-side attenuation, default **0.0** = today's
  behaviour) and `anchor_photo_ids` (only ever sent because a user tapped
  "find more using this photo"). Sweep them with
  `run_eval.py --anchor-promotion --face-quality-weight '0.25;0.5;1.0'`;
  `PEOPLE_RECOGNITION_QUALITY_PLAN.md` Items 5/11/12 hold the reasoning.
  - `ANCHOR_SWEEP_CFG` in `eval/run_eval.py` **duplicates the matcher's `ANCHOR_*`
    defaults** (the eval can't import `main.py` — flask/onnx). Change one, change
    both, or the sweep stops predicting production.
- **An anchor's outfit REPLACES the selfie's** (`ANCHOR_PERSON_MODE=replace`).
  That is the point: the selfie's clothing may be from another day, and with
  T-norm a strong outfit score can lower the face bar a match must clear.
- **The api tolerates a matcher that predates all this.** `anchorPhotoIds`,
  `anchorSuggestion` and `faceQualityWeight` are optional on the wire and read as
  "none/0" when absent — the two services deploy separately, and a search must
  not 500 mid-rollout. Keep them optional.
- **`POST /quality` (matcher) → `POST /api/findme/selfie-check` (api) is
  detection-only.** No embeddings, no consent row, no reference record, no
  `match_runs` doc; it grades picked selfies before a search. Don't "reuse
  `/embed`" for it — running ArcFace + the person detector on every picked file
  is most of a search's cost for a UI hint, and it would compute biometrics we
  have no reason to compute. It also must never block the search: any failure is
  a missing hint, not an error the user has to clear.
- **`match_runs` stores per-modality scores** (`faceScores`/`personScores`) as
  well as the fused `scores`. Without them a reviewed verdict batch cannot tell a
  face-driven wrong match from an outfit-driven one — which is what sent one
  investigation guessing. Keep writing them.

## outfit-tagger — "find this outfit" is a SEPARATE service

- **`cloud-webapp/outfit-tagger/` is not part of Find-Me and must stay that way.**
  It answers "which photos show this outfit/accessory?" from sample crops and/or a
  text description (SigLIP, Apache-2.0), and it is a separate Cloud Run service
  with its own URL, its own build context, and its own vector store. The api
  reaches it via its own `OUTFIT_URL` (empty until deployed → `/admin/outfit`
  routes 503 and nothing else changes). Deploy with
  `./cloud-webapp/infra/scripts/deploy-outfit-tagger.sh`; full docs in
  `cloud-webapp/outfit-tagger/README.md`.
- **It writes ONLY `<eventId>/outfit/{crops.npy,index.json}`** — a sibling of the
  matcher's `<eventId>/embeddings/`, never inside it. So the matcher needs no
  redeploy, a bad prepare run cannot degrade a search, and rollback is deleting
  the prefix. Keep that boundary: the moment this service writes something the
  matcher reads, the isolation is gone.
- **No detector runs in it.** Person + face boxes come from the indexer's
  `embeddings/manifest.json` (read-only), so there is no new detection compute.
  Two crops per photo: `person` (outfits fill it) and `head` (a face box expanded
  for ears/headwear — an earpiece is a few pixels inside a person crop and
  contributes nothing). Accessory queries want `region=head`.
- **Crops come from the mirrored ORIGINAL, not the 1600px `web` derivative.**
  Manifest boxes are in original-image pixel coordinates and the manifest records
  no original dimensions, so a box cannot be soundly rescaled onto a web copy —
  and the downscale is what destroys the detail a head crop exists for. A photo
  whose original is missing is SKIPPED and recorded, never guessed at.
- **The prepare pass is a Cloud Run JOB (`outfit-prepare`), not an endpoint.**
  ~3,000 crops for a 1,600-photo event is minutes of CPU-ONNX work; this is the
  same 60s ceiling that broke duplicate removal, folder rebuild, and the upload
  worker. Do not "simplify" it into a request. One execution = one event,
  idempotent, skipped when already prepared under the same model + source-manifest
  versions.
- **The two modalities are normalized DIFFERENTLY. Do not "unify" them.**
  Image↔image cosines are ~0.5–0.9 and image↔text ~0.05–0.15, so a raw weighted sum
  is entirely the sample term and `text_weight` would be a lie. Both are mapped to
  "std above background" — but samples use a **cohort z-score** (query and crops
  are the same distribution, as in the matcher's T-norm) while text uses a
  **query-independent calibration**: the mean/std of the (background-prompt × crop)
  cosine population for that event (`scoring.BACKGROUND_PROMPTS`, cached per event
  per process).
  - **Cohort z-scoring the TEXT channel is a real bug and it shipped once.** The
    per-query std is the relevance signal: an out-of-domain prompt is uniformly
    dissimilar to every crop → tiny spread → noise becomes a big z; a relevant
    prompt is broadly similar to all runner crops → its best hit sits fewer std
    above a higher mean. Measured on event 2622d5ab (2,589 crops/region), absurd
    prompts beat plausible ones **+4.41 vs +3.36**, while the RAW cosines separated
    cleanly (0.106 vs 0.031). After the fix: **+3.20 vs +1.04**.
  - A z-score is affine, so it never reordered results *within* a query — the
    damage was to magnitude, which is exactly what `text_weight` and any threshold
    consume. That is why a "harmless rescale" was not harmless.
  - **Absurd-prompt controls are how this was caught.** Keep them in any future
    evaluation; a plausible-only sweep looks fine and says nothing.
  - There is deliberately **no default `min_score`** — the guardrails want a judged
    sweep before a number gates anything.
- **Text is weak on fine-grained gear** ("open-ear headphones", brands) and fine
  on coarse attributes ("orange singlet"). `/detect` returns a `textAdvisory`
  rather than refusing. Samples are the strong modality; `sample_photo_ids` reuses
  stored crop vectors, so it costs no inference and is better framed than an
  uploaded wide shot.
- **Preprocessing is recorded at export time, never hardcoded.**
  `scripts/export_siglip.py` writes `vision_config.json` / `text_config.json` from
  the real processor and refuses to finish unless (1) our tokenizer matches
  `transformers` id-for-id, (2) each graph has exactly ONE rank-2 output, and
  (3) the ONNX towers match torch to cosine ≥ 0.999. A wrong normalization
  constant or pad id yields confidently-wrong embeddings that raise nothing — do
  not hand-assemble `model_files/`.
  - Check (2) earned its place on the first real export: in **transformers 5.x**
    `get_image_features`/`get_text_features` return a `BaseModelOutputWithPooling`,
    not a tensor, and exporting that object flattens it into **two** ONNX outputs
    with `last_hidden_state` FIRST. The runtime reads `outputs[0]`, so it would
    have embedded a `[batch, 196, 768]` token tensor instead of the pooled
    `[batch, 768]` vector — loads fine, raises nothing, ranks garbage. The tower
    wrappers now take `.pooler_output` explicitly.
  - Also version-fragile: `image_processor.size` is a `SizeDict` (attribute
    access, not a dict) in 5.x, and `torch.onnx.export` needs **onnxscript**
    installed or it dies partway through the first export.
- **`model_files/*.onnx` are NOT self-contained** — torch writes weights to
  sibling `*.onnx.data` files (~780 MB; the graphs are ~110 KB). onnxruntime
  resolves them by relative path, so always move the directory whole.
- Changing weights changes the embedding space: bump `OUTFIT_MODEL_VERSION` and
  re-prepare every event. `/detect` returns **409 `model_version_mismatch`** rather
  than ranking a query against vectors from another model.
- `parse_root` is now duplicated a THIRD time (matcher/store.py,
  indexer/blobs.py, outfit-tagger/store.py), as is `ORIG_EXT_BY_MIME`. Same reason
  as before — separate build contexts — and both are pinned by parity tests
  (`outfit-tagger/test_store.py`, `test_crops.py`). The ext-table test caught a
  real drift on the first run; trust it over a grep.

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
