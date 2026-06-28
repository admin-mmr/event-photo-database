# Post-upload operations migration plan (gas-app → cloud-webapp)

Migrate the gas-app "special folders" pipeline — Managed Albums plus the
**Photos_NNN / Videos / Album** folder builds — into `cloud-webapp/` (decisions
locked 2026-06-27):

1. **Storage-minimizing Photos_NNN policy (REVISED from gas-app):**
   - **JPEG → Drive shortcut** (no byte-for-byte copy — avoids duplicating
     storage for the common case).
   - **non-JPEG (PNG/HEIC/WEBP) → real converted JPG** via the Cloud Run
     image-convert service when available; **shortcut fallback** when convert is
     unavailable or fails. So a *real* file is created only when a conversion is
     actually needed.
2. **Match gas-app persistence** — a `Special_Folders` Sheet tab (SSOT) + a
   Firestore read cache, and regenerate the public-folder-index spreadsheet
   tabs (`Photo Folders`, `Video Folders`, one per-club Album tab).
3. **Trigger both ways** — **scoped** rebuild inline after a file update
   (post-upload hook) **and** a **full** rebuild periodically, folded into the
   existing `index-scan` loop. Admin UI buttons to retrigger manually if the
   automatic run failed.

This is a self-contained plan. **Status: M1–M8 implemented** (see
`MANAGED_FOLDERS_CUTOVER.md` to enable). Feature ships disabled
(`MANAGED_FOLDERS_ENABLED=false`); typecheck + lint clean, unit tests green, and
an independent parity review against gas-app passed (only intentional deviations:
JPEG→shortcut storage policy; minor cosmetics aligned).

---

## 1. What we are migrating (source of truth: `gas-app/`)

| gas-app artifact | Behavior |
|---|---|
| `services/specialFoldersService.ts` | The core engine. `rebuildEventPhotoFolders` (Photos_NNN buckets, real materialized JPGs), `rebuildClubVideoFolder` / `rebuildClubAlbumFolder` (per `(event,club,tag)` shortcut folders), `tryRebuildSpecialFoldersForBatch` (best-effort hot-path wrapper), `removeShortcutsForTargets` (orphan sweep on soft-delete), `migrateEventPhotoShortcutsToFiles` (one-time shortcut→JPG upgrade), `backfillSpecialFoldersSharing`. |
| `services/publicSpreadsheetService.ts` | Rewrites the public folder-index spreadsheet: `Photo Folders` tab, `Video Folders` tab, one tab per club for Album folders. Pure row-builders (`buildPhotoFolderRows`, `buildVideoFolderRows`, `buildClubAlbumTabs`, `sanitizeTabName`) + the writer. |
| `services/driveShortcutClient.ts` | REST plumbing: `createDriveShortcut`, `copyDriveFile`, `setFileAppProperties`, `listShortcutsInFolder`, `listManagedCopiesInFolder`, `getDriveFileBasics`, `driveFolderUrl`, `SOURCE_PHOTO_ID_PROPERTY`. |
| `services/cloudRunClient.ts` | `convertImage(...)` → the Cloud Run image-convert service (`CLOUD_RUN_URL`). |
| `services/drivePermissionsService.ts` | `grantAnyoneRead` / `tryGrantAnyoneRead` — "Anyone with link → Viewer" so public-browse folder links work. |
| `Special_Folders` sheet + `SpecialFolderRecord` (`types/models.ts`) | Authoritative state: `folderId, eventId, scope('photos'|'videos'|'albums'), clubName, tag, folderName, folderIndex, folderUrl, fileCount, lastRefreshedAt`. |
| `main.ts` triggers | `scheduledPublicSheetRefresh` (every 2h, force) and `scheduledPublicSheetRefreshLazy` (every 15m; rebuilds only when `latestUpload > latestRefresh`). |
| `routes/publicSheetHandlers.ts` | Manual admin buttons: refresh public sheet, rebuild photos, rebuild videos+albums. |

### Folder layout produced (unchanged — cloud-webapp uploads already build this tree)
```
<Event>/Photos_001/ …            ≤800 entries/bucket. JPEG→shortcut; non-JPEG→converted JPG
                                 (appProperties.sourcePhotoId) or shortcut fallback
<Event>/<Club>/<Tag>/Videos/     shortcuts to every video in scope
<Event>/<Club>/<Tag>/Album/      shortcuts to every media file (photos + videos) in scope
```
The rebuild **walks Drive** (it does not depend on the indexer / Firestore
`photos`), so it can run immediately after the Drive copy.

---

## 2. What cloud-webapp already gives us

- `services/driveService.ts`: `getDriveToken`, `listEventImages`, `getFileMetadata`, `trashFile`, `untrashFile`, `deleteFilePermanently`, `uploadFileToDrive`, `getOrCreateSubfolder`, plus internal `driveGet` + `DRIVE`/`DRIVE_UPLOAD` constants and keyless DWD auth.
- `services/volunteerUploadService.ts` → `enqueueStagedBatch(link, batchId, objectNames)`: copies staged files into `Event/Club/tag/batch`, then `triggerIndexJob(eventId)`. **This is the post-upload hook point** (right after `triggerIndexJob`, alongside `appendUploadLog`).
- `routes/events.ts` → `POST /api/admin/index-scan` (`allowCronOrAdmin`): the existing Cloud-Scheduler-driven scan loop over Firestore `events` with a Drive-fingerprint short-circuit (`computeDriveSig`/`lastIndexSig`). **This is the periodic hook point.**
- Sheet-store pattern: `eventStore.ts`, `linkStore.ts`, `auditStore.ts` — read via `getSheetValues`, write via `appendSheetValues`/`updateSheetValues`, Firestore cache upsert, row addressing in `sheetTable.ts`. `Special_Folders` should follow this exactly.
- `lib/config.ts` (env validation, all config funnels here), `lib/firestore.ts` (singleton), `lib/logger.ts`, `cronAuth.ts`, `infra/scripts/provision-*scheduler.sh`.

### Gaps to build (not present in cloud-webapp today)
Confirmed by search — none of these exist yet and all are required for parity:

1. **Drive shortcut primitives**: create shortcut (`application/vnd.google-apps.shortcut`), `files.copy` byte-for-byte, set `appProperties`, list shortcuts (with `shortcutDetails.targetId`/`targetMimeType`), list managed copies (by `appProperties.sourcePhotoId`).
2. **Non-creating folder lookup** (`findSubfolder`) + `getFolderById` + recursive `walkMediaFiles` (skipping managed folders).
3. **Public sharing** (`permissions.create` anyone/reader, idempotent).
4. **Cloud Run image-convert client** + the env/URL for it. **Dependency: the image-convert Cloud Run service must be reachable from cloud-webapp** (gas-app calls it via `CLOUD_RUN_URL`). Confirm the service still exists and grant the api-runtime SA invoke rights; otherwise non-JPEG photos fall back to shortcuts.
5. **`Special_Folders` Sheet tab + store + Firestore cache**, and the **public folder-index spreadsheet writer** (separate world-readable Sheet, gas-app `PUBLIC_ALBUM_INDEX_SHEET_ID`).

---

## 3. Target design in cloud-webapp

New files under `cloud-webapp/api/src/`:

```
services/
  driveShortcutClient.ts     # shortcut create, files.copy, appProperties, list shortcuts/copies, folder url
  drivePermissionsService.ts # grantAnyoneRead / tryGrantAnyoneRead (idempotent)
  imageConvertClient.ts      # convertImage() → Cloud Run image-convert service
  specialFoldersStore.ts     # Special_Folders Sheet read/write + Firestore cache (mirrors eventStore.ts)
  specialFoldersService.ts   # port of the rebuild engine (Photos/Videos/Album + sweep + migration)
  publicFolderIndexService.ts# port of publicSpreadsheetService.ts (Photo/Video/per-club Album tabs)
routes/
  adminManagedFolders.ts     # manual admin endpoints + the periodic rebuild entrypoint
```

Extend existing files:
```
services/driveService.ts        # add findSubfolder, getFolderById, walkMediaFiles (or co-locate in driveShortcutClient)
services/volunteerUploadService.ts  # post-upload hook after triggerIndexJob
routes/events.ts                # call rebuild from the index-scan loop (periodic), or a dedicated scheduled route
lib/config.ts                   # new env vars (see §6)
shared/src/schemas/...          # SpecialFolder type/contract if surfaced to the web UI
```

### Persistence (decision: match gas-app)
- New **`Special_Folders`** tab on the master Sheet, columns = gas-app `SPECIAL_FOLDERS_HEADERS` (folderId, eventId, scope, clubName, tag, folderName, folderIndex, folderUrl, fileCount, lastRefreshedAt). `folderId` is the upsert key.
- Firestore **`specialFolders/{folderId}`** read cache (used by the periodic "lazy" check and any UI), kept in sync on each upsert — same write-through pattern as the other stores. Sheet remains SSOT; **no secrets** (it satisfies the CLAUDE.md rule — folder IDs/counts only).
- **Public folder-index spreadsheet** stays a *separate* world-readable Sheet (env `PUBLIC_ALBUM_INDEX_SHEET_ID`), rewritten wholesale each run via the Sheets API. Tabs and column order preserved exactly so existing public bookmarks keep working.

### Auth / Drive scopes
All Drive writes use `getDriveToken(DRIVE_SCOPE_READWRITE)` (keyless DWD). Shortcut
create, `files.copy`, `appProperties`, and `permissions.create` are all in scope
under `https://www.googleapis.com/auth/drive` — already required by the upload
copy path, so no new Workspace DWD scope beyond what the cutover runbook (§A1)
already provisions. Public-sheet writes need the Sheets write scope (already used
by the control-plane stores).

---

## 4. Where the triggers wire in

### A. Post-upload hook ("after any file update")
In `enqueueStagedBatch` (volunteerUploadService.ts), after `triggerIndexJob` and
`appendUploadLog`, when `copied > 0`:
```
tryRebuildSpecialFoldersForBatch(link.eventId, link.clubName, link.tag);  // Photos + Videos + Album for this scope
tryRebuildPublicFolderIndex();                                            // rewrite public tabs
```
Best-effort (swallow + log), exactly like gas-app — a Drive hiccup must never
fail an upload whose bytes are already in Drive.

> **Cost/latency caveat (CLAUDE.md zero-idle + request-scoped CPU).** The Photos
> rebuild walks the whole event subtree and may issue many Drive copies +
> Cloud Run conversions; running it inline blocks the volunteer `/complete`
> response and burns request-time CPU. **Recommended:** run the hook on the
> background-worker path (`/api/internal/process-batch`, gated by
> `UPLOAD_DISPATCH_TO_WORKER`) rather than synchronously in `/complete`, OR have
> the hook only enqueue/flag the event and let the scheduled job (B) do the heavy
> build. The scoped per-batch rebuild (one club/tag + the event's Photos buckets)
> is far cheaper than a full-event rebuild and is usually fine inline. Decision
> point flagged in §7.

### B. Periodic rebuild ("also periodically")
Two equivalent options — pick one:

- **B1 (preferred, least new infra):** extend the existing `POST /api/admin/index-scan`
  loop. For each event it decides to (re)index, also call
  `tryRebuildSpecialFoldersForEvent(eventId)` + refresh the public index once at
  the end. Reuse the `computeDriveSig`/`lastIndexSig` fingerprint so unchanged
  events are skipped — this is the cloud-webapp equivalent of gas-app's *lazy*
  trigger.
- **B2:** a dedicated `POST /api/admin/folders/rebuild-scan` route + its own Cloud
  Scheduler job (mirrors gas-app's force-refresh-every-2h), provisioned with a new
  `provision-folders-rebuild-scheduler.sh`. Use this if we want the folder rebuild
  cadence decoupled from indexing.

Both authorized by `allowCronOrAdmin` + OIDC token (per the Cloud Scheduler notes
in CLAUDE.md). Keep new scheduler jobs **paused until parity sign-off** (runbook §A4).

### C. Orphan sweep on delete
Wire `removeShortcutsForTargets(fileIds)` into the existing soft-delete path
(`routes/adminDeletedFiles.ts` / `deletedFilesStore.ts`) so trashing an original
also retires its shortcuts/copies — parity with gas-app.

### D. Manual admin endpoints (parity with publicSheetHandlers.ts)
`routes/adminManagedFolders.ts` (`requireAuth`+`requireAnyAdmin`):
`POST /api/admin/folders/refresh-public`, `.../rebuild-photos`,
`.../rebuild-videos-albums`, and the one-time `.../migrate-photo-shortcuts`.

---

## 5. Build phases (incremental, each independently testable)

**Phase M1 — Drive primitives.** Port `driveShortcutClient.ts` +
`drivePermissionsService.ts` + `findSubfolder`/`getFolderById`/`walkMediaFiles`
onto cloud-webapp's `fetch`/`driveGet` style. Unit-test the pure helpers
(`planShortcutDedupe`, `photoCopyDestName`, `bucketIndexForPosition`,
`bucketCountForFiles`, `photosFolderName`, `decidePhotoAction`) — these port
verbatim from gas-app and already have test coverage to mirror.

**Phase M2 — Special_Folders store.** `specialFoldersStore.ts` (Sheet tab +
Firestore cache, upsert-by-folderId, `getLatestRefreshedAt`). Add the tab to the
master Sheet on first write (`ensureHeaders` equivalent).

**Phase M3 — Image-convert client.** `imageConvertClient.ts` + config; confirm the
Cloud Run convert service is reachable + invokable by api-runtime@. Verify a real
HEIC/PNG conversion end-to-end before relying on it (else fall back to shortcuts).

**Phase M4 — Rebuild engine.** Port `specialFoldersService.ts`
(`rebuildEventPhotoFolders`, `rebuildClubVideoFolder`, `rebuildClubAlbumFolder`,
`rebuildAllSpecialFoldersForEvent`, `tryRebuildSpecialFoldersForBatch`,
`removeShortcutsForTargets`, `migrateEventPhotoShortcutsToFiles`,
`backfillSpecialFoldersSharing`). Same idempotency/dedupe semantics. Async/await
instead of GAS sync; concurrency-bounded Drive calls. **Change `decidePhotoAction`
to the new storage-minimizing policy: JPEG → `'shortcut'` (was `'copy'`),
non-JPEG → `'convert'` with shortcut fallback.** The engine's mixed
shortcut+copy dedupe (shortcuts by `targetId`, converted copies by
`appProperties.sourcePhotoId`) already supports this; JPEG shortcuts grant
`anyoneWithLink` on the target so the public link works.

**Phase M5 — Public folder index.** Port `publicFolderIndexService.ts`
(row-builders + tab writer via Sheets API). Keep tab names/column order identical.

**Phase M6 — Wire triggers.** Post-upload hook (§4A), periodic (§4B-choice),
delete sweep (§4C), manual admin routes + minimal web UI buttons (§4D).

**Phase M7 — Provisioning + cutover.** Env vars, Firestore index for
`specialFolders` if queried, scheduler job(s) (paused), and an addendum to
`CUTOVER_RUNBOOK.md`. One-time `backfillSpecialFoldersSharing` +
`migrateAllPhotoShortcutsToFiles` for historical events.

**Phase M8 — Verification.** Unit tests (pure helpers), an integration test
against a throwaway event folder (upload → assert Photos_NNN JPGs +
Videos/Album shortcuts + Special_Folders rows + public tabs), and a parity diff
vs. a gas-app-built event. Recommend a verification subagent for the parity diff.

---

## 6. New configuration (lib/config.ts + deploy-api.sh)

```
MANAGED_FOLDERS_ENABLED      = true|false      # master switch (default false until parity)
SPECIAL_FOLDERS_SHEET_NAME   = Special_Folders
PUBLIC_FOLDER_INDEX_SHEET_ID = <world-readable Sheet id>   # gas-app PUBLIC_ALBUM_INDEX_SHEET_ID
IMAGE_CONVERT_URL            = <Cloud Run image-convert service URL>   # gas-app CLOUD_RUN_URL
IMAGE_CONVERT_JPG_QUALITY    = 85 (default)
MAX_PHOTOS_PER_BUCKET        = 800
```
All optional-with-defaults so an unconfigured deploy is a safe no-op (feature
disabled), mirroring gas-app's "Script Property unset → no-op" behavior.

---

## 7. Decisions (LOCKED 2026-06-27)

1. **Hook execution model (§4A):** ✅ **Scoped per-batch rebuild runs inline** in
   the upload completion path (one club/tag + the event's Photos buckets — cheap).
   **Full-event rebuilds run on the scheduler**, never inline.
2. **Periodic trigger (§4B):** ✅ **B1 — fold into the existing
   `POST /api/admin/index-scan` loop.** No new scheduler job; reuse the
   `computeDriveSig`/`lastIndexSig` fingerprint to skip unchanged events.
3. **Photos_NNN materialization (§3):** ✅ **Storage-minimizing.** JPEG → shortcut
   (no real copy). non-JPEG → real converted JPG when Cloud Run convert is
   available, else shortcut fallback. *Still requires confirming the image-convert
   Cloud Run service is reachable + invokable by api-runtime@ — otherwise every
   non-JPEG falls back to a shortcut (functional, just no in-bucket JPG).*
4. **Web UI surface:** ✅ **Port the admin buttons** into the cloud-webapp admin
   SPA so an admin can manually retrigger the post-upload procedure when the
   automatic run failed (Refresh public index / Rebuild photos /
   Rebuild videos+albums / Migrate photo shortcuts).

---

## 7a. Google Drive rate limiting (BUILT — `services/driveRateLimit.ts`)

Every Drive call is impersonated as the single `DWD_SUBJECT`, so the whole
rebuild draws from **one user's** Drive quota. A big-event rebuild is bursty
(walk listings + per-photo copy/convert + shortcut creates + permission grants)
and unbounded `fetch` concurrency would trip `403 rateLimitExceeded` /
`403 userRateLimitExceeded` / `429`. Mitigations, all centralised in a single
`driveFetch(url, init, ctx)` wrapper that every Drive REST client calls:

1. **Pacing.** A process-global promise-chain gate starts calls **≥
   `DRIVE_MIN_INTERVAL_MS` apart (default 120 ms ≈ 8 req/s)** — well under the
   per-user limit, so a steady rebuild never bursts. Because the gate is global,
   it paces *all* Drive work in the process (inline hook + scheduled scan +
   manual admin run) together, not per-request.
2. **Exponential backoff + jitter.** On `429`, a `403` whose body names a
   rate-limit reason, or any `5xx`, the call retries up to `DRIVE_MAX_RETRIES`
   (default 6) with `min(cap, 2^n s) + jitter`, honouring `Retry-After`. This is
   Google's recommended handling. After the last retry the raw response is
   returned so existing error handling still runs.
3. **Fewer calls by construction.** Dedupe means steady-state rebuilds touch
   only *new* files; permission grants are issued only for *newly* linked targets
   (never re-granting the whole archive); the `index-scan` Drive-fingerprint skips
   unchanged events entirely; listings are cached. JPEG→shortcut also avoids the
   convert round-trips for the common case.
4. **Bounded work per run.** The scheduled scan processes a capped number of
   events per invocation; the inline hook is *scoped* to one club/tag + the
   event's Photos buckets; huge one-off migrations run resumably (idempotent) so
   they can be re-run rather than pushed through in one burst.

Tunables via env (`DRIVE_MIN_INTERVAL_MS`, `DRIVE_MAX_RETRIES`,
`DRIVE_BACKOFF_CAP_MS`) so pacing can be loosened/tightened without a code change.
The shortcut client, permissions service, and the new `driveService` walk helpers
all route through `driveFetch`; the existing heavy `driveService` mutators used by
the rebuild (`getOrCreateSubfolder`, `uploadFileToDrive`) will be routed through it
in M4 as they're integrated.

## 8. Risks & parity notes

- **Sheets read quota** (60 reads/min/user, all impersonated as `DWD_SUBJECT`):
  the per-batch and scan paths must cache `Special_Folders`/`Events`/`Clubs` reads
  like `volunteerUploadService` already caches `Upload_Links`. Load once per
  rebuild, not per row.
- **Idle cost:** no new always-on service; reuse Cloud Run jobs/scheduler that
  bill only while running. New scheduler jobs start paused.
- **Long runs:** GAS had a 6-min cap; Cloud Run requests have their own timeout.
  Heavy full-catalogue migrations (`migrateAllPhotoShortcutsToFiles`) should run
  as a one-off job/loop, resumable (it already is idempotent), not in a request.
- **Public-sheet bytes:** index tabs are tiny (folder rows), so the Hosting-egress
  rule in CLAUDE.md is not implicated; photo bytes are never served here.
- **Determinism:** preserve gas-app's sort-by-Drive-ID bucketing and the
  clean-name-wins shortcut dedupe so rebuilds are stable and bucket assignments
  don't churn.
```
