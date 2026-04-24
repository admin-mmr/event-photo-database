# Code Quality Assessment — event-photo-database

**Date:** 2026-04-23
**Scope:** `gas-app/` (TypeScript / Google Apps Script), `cloud-run/` (Python Flask)
**Focus areas:** Architecture & design, Tests & reliability, Performance & scalability
**Total source:** ~16,000 LOC across 33 TS source files + 1 Python service + 9 HTML templates
**Test surface:** 33 unit tests + 2 integration tests, 1 shared GAS mock file

---

## TL;DR

The codebase is in **solid shape overall**: TypeScript is strict, tests are numerous, services are mostly single-purpose, and the domain model (enums/models/requests/responses) is well-factored. But four recurring problems limit reliability and scale:

1. **Three "god files"** carry far too much logic (`main.ts` 2,391 lines, `photosService.ts` 1,388 lines, `emailService.ts` 921 lines).
2. **Critical services have zero tests** — notably `photosService.ts`, `router.ts`, `cloudRunClient.ts`, and both sync-job services (aggregate ~100 KB of untested code).
3. **Sheet reads are duplicated** inside hot loops (`getAllRows()` called 4+ times per batch sync) and unbatched writes amplify I/O.
4. **Error handling swallows failures silently** at GAS↔Cloud Run and user-facing boundaries, so partial failures look like success to admins.

The fastest wins are: dedup sheet reads in `photosService`, set `Image.MAX_IMAGE_PIXELS` to a sane limit in Cloud Run, move the super-admin allowlist + Cloud Run URL to Script Properties, validate Cloud Run URL at startup, and add tests for `photosService` and `cloudRunClient`.

---

## Severity legend

- **Critical** — data-loss risk, silent production failure, or likely outage at realistic scale
- **High** — reliability/maintainability problem that will bite soon
- **Medium** — meaningful design debt worth a planned fix
- **Low** — polish / hygiene

---

## 1. Architecture & Design

### 1.1 God files (Critical)

Three files concentrate logic that should be distributed:

| File | Lines | Problem |
|---|---|---|
| `gas-app/src/main.ts` | 2,391 | Entry point (`doGet`/`doPost`) + 75+ `serverXxx()` google.script.run handlers + inline orchestration (event creation, album creation, email dispatch). Imports 25+ services. |
| `gas-app/src/services/photosService.ts` | 1,388 | Low-level Photos HTTP helpers + album/file sync orchestration + dedup/reconciliation + sheet persistence, all in one module. |
| `gas-app/src/services/emailService.ts` | 921 | HTML rendering + recipient resolution + MailApp quota management + trigger installation + scheduled digest composition, all in one module. |

**Concrete effects**

- `main.ts` duplicates route logic: `serverCreateEvent` (lines ~363–436) inlines album-creation orchestration that also lives in `photosService.ts`; any behavior change has to be made twice.
- `photosService.ts` forces every test of high-level sync to also touch low-level HTTP concerns, which is likely why it has **zero tests** (see §2.2).
- `emailService.ts`'s double role as dispatcher *and* digest generator means `summaryService` is called from the email module rather than standing on its own.

**Recommended refactor** (sequenced):
1. Extract `serverXxx` handlers in `main.ts` into per-area route modules (already the pattern for apiRoutes/volunteerRoutes); leave only `doGet`/`doPost` and the dispatcher in `main.ts`.
2. Split `photosService.ts` into `photosApiClient.ts` (HTTP/auth), `photoAlbumsRepo.ts` (sheet I/O), and `photosSync.ts` (orchestration).
3. Split `emailService.ts` into `emailDispatcher.ts` (send + quota + retry queue), `emailTemplates.ts` (HTML rendering), and `emailTriggers.ts` (install/uninstall).

### 1.2 Hardcoded secrets / config (Critical)

`gas-app/src/config/superAdmins.ts`:

- **Line 21** — super-admin allowlist hardcoded: `'cathy.lin@mmrunners.org'`. Adding an admin requires editing source and redeploying. Every other secret in this project already lives in Script Properties (see `tokenService.ts:120–122`, `constants.ts:324–327`); this is the exception.
- **Line 32** — `CLOUD_RUN_URL = 'https://image-convert-REPLACE_ME.a.run.app'`. If this placeholder ships unedited, every conversion silently fails (see §1.4 — `cloudRunClient` catches the network error and returns `{ ok: false }` without distinguishing it from a real upstream failure).

**Fix:** Read both from Script Properties at runtime. Log a loud warning (and ideally throw on first call) if either is missing or still the placeholder value.

### 1.3 Error handling: silent partial success (High)

Multiple user-facing handlers catch errors on side-effectful steps and return success anyway. The audit log captures the failure, but the UI reports success:

- `main.ts` lines ~180–187 (`serverVerifyGoogleToken`): security-event notification failure is swallowed; login looks clean.
- `main.ts` lines ~243–247 (`serverCreateUser`): welcome email failure is swallowed.
- `main.ts` lines ~384–424 (`serverCreateEvent`): album creation failure is swallowed; admin sees "event created" even if Photos API is down and the album never existed.

**Pattern to adopt:** return a composite result (`{ status: 'success', warnings: [...] }`) so the UI can show a non-blocking warning when a non-fatal side-effect failed.

### 1.4 GAS ↔ Cloud Run boundary is lossy (High)

`gas-app/src/services/cloudRunClient.ts` (verified):

- Lines 86–93: any network exception (including 401/403/429/5xx surfaced as an exception) is caught and collapsed into a generic `{ ok: false, error: 'internal', message: ... }`.
- No retry / exponential backoff for 429 or 5xx (Cloud Run can and does return these when scaling from zero or under brief load).
- `cloud-run/main.py` already returns specific error codes (`'unauthorized'`, `'source_not_found'`, `'unsupported_format'`, `'download_failed'`, `'upload_failed'`, `'conversion_failed'` at `main.py:287–303`), but the client-side caller (`uploadPrepService`) doesn't inspect `error` — it just checks `ok`, so retriable and fatal conditions are indistinguishable in logs.

**Fix:** Add up to 3 retries with exponential backoff for status 429/500/502/503/504, and surface the upstream `error` string to callers so the manifest can record *why* a file was skipped.

### 1.5 Type safety: unsafe casts on raw payloads (Medium)

`main.ts` handlers receive `google.script.run` payloads as `any` and cast without validation — e.g. lines ~269–273 in `serverUpdateUser` (`as string`, `as UserRole`) and `apiRoutes.ts:242` coerces `payload['sort']` to `'asc' | 'desc'` without validation. Input is validated thoroughly in `doPost` handlers, but `google.script.run` paths bypass the validator.

**Fix:** Route `serverXxx` through the same `inputValidator.ts` pipeline as `doPost` handlers.

### 1.6 Duplication & stale artifacts (Medium/Low)

- Album-creation logic appears in both `main.ts:~396` (`serverCreateEvent`) and `photosService.ts:~250` (`syncEventToAlbums`). Unify behind a single `ensureEventAlbums(eventId)` entry point.
- Accepted MIME types are defined *three times* with no single source of truth: `config/constants.ts:274` (`MEDIA_MIME_TYPES`), `photosService.ts:59` (`PHOTO_MIME_TYPES` hardcoded), and `cloud-run/main.py:~61` (`PILLOW_MIMES`). Drift is likely.
- Seven `STALE_*` files at the repo root (`STALE_README.md`, `STALE_USER_GUIDE.*`, `STALE_XSD_Partner_Overview.pdf`, etc.). These are confusing in git history; move to an `archive/` subfolder or delete.
- Debug endpoints `debugClientId` / `debugConfig` in `main.ts:113–136` are exported in production; they only leak config metadata to authenticated users, but there's no guard.

---

## 2. Tests & Reliability

### 2.1 Test suite shape

33 unit tests + 2 integration tests. Solid total volume, good mocking of GAS globals, AAA layout used consistently. But coverage is heavily uneven.

### 2.2 Untested services (Critical)

The following source files have **no test file at all**. They include the largest and most integration-heavy modules in the codebase:

| File | LOC | Role | Risk |
|---|---|---|---|
| `services/photosService.ts` | 1,388 | Photos API sync, reconciliation, album lifecycle | Silent photo sync failures; dedup bugs corrupt data |
| `routes/router.ts` | 636 | Central dispatch, role-based access control | Auth/ACL regressions untested |
| `routes/apiRoutes.ts` | 626 | HTTP API handlers | Wire-level contract changes untested |
| `routes/pageRoutes.ts` | 365 | Page rendering | Template injection, session handling untested |
| `services/manifestService.ts` | 346 | Upload-prep CSV manifest I/O | Mid-run partial writes could corrupt manifests |
| `routes/apiClientHandlers.ts` | 311 | (note: `apiClientHandlers.test.ts` is intentionally `describe.skip`-stubbed — deprecated by design, see file header) |
| `services/syncJobService.ts` | 307 | Progress tracking in PropertiesService | Stale jobs, concurrency bugs |
| `services/syncQueueService.ts` | 273 | Retry queue in sheet | Duplicate processing, stuck items |
| `services/uploadLinkService.ts` | 295 | Public upload-link lifecycle | Token expiry/revocation regressions |
| `services/tokenService.ts` | 174 | Google ID token verification | Security-critical; no tests |
| `services/cloudRunClient.ts` | 94 | Network boundary to Cloud Run | Error-envelope handling untested |
| `routes/uploadPrepRoutes.ts` | 130 | | |

**`tokenService.ts` and `cloudRunClient.ts` being untested is the most acute gap** — one validates identity, the other talks to a separately deployed service. Both are easy to test in isolation (pure functions with mocked `UrlFetchApp`).

### 2.3 Test quality (Medium)

Spot-checks of `emailService.test.ts` show good coverage of branches (quota exhaustion, MailApp errors, retry queueing), but many assertions only verify "doesn't throw" or "returns ERROR status", not *which* audit row was written or *which* message was enqueued. This makes regressions in message content invisible.

The two smallest test files (`authMiddleware.apiKey.test.ts`, `apiClientHandlers.test.ts`) are intentional `describe.skip` stubs left over from a removed `API_CLIENT` role — documented in their file headers. Not a quality issue; delete them when convenient to reduce noise.

### 2.4 Mock realism (`tests/mocks/gasGlobals.ts`) (Medium)

Good: `SpreadsheetApp`, `DriveApp`, `MailApp`, `ScriptApp`, `PropertiesService`, `CacheService`, `Session` all stubbed; helpers like `resetMockSheets()`, `setMockMailAppQuota()` exist.

Missing / weak:
- **No `UrlFetchApp` global** — each test that needs it stubs locally (e.g. `photosFileService.test.ts:95`). Move to the shared mock.
- **`HtmlService` mock doesn't render templates** — `createTemplateFromFile().evaluate()` returns a stub; no variable binding. Template-injection tests aren't meaningful.
- **No `DriveApp` file-iterator helper** — `makeMockFileIter()` is re-implemented per test file.
- **No timeout / slow-call simulation** — can't test retry logic under latency.

### 2.5 Coverage visibility (Medium)

`gas-app/coverage/coverage-summary.json` exists but is empty/invalid (last update Apr 18). `jest.config.js` sets thresholds (branches 80%, funcs/lines/stmts 85%), but they cannot be enforced without a clean coverage run. The full suite also appears to exceed the 45s subagent bash timeout under `--coverage`; worth profiling/splitting.

### 2.6 Reliability patterns in source (Medium)

- **`emailService.ts:713–892`** has retry with exponential backoff [0.5h, 1h, 2h] and `MAX_RETRY_ATTEMPTS=3` — good. But the retry queue is stored unbounded in PropertiesService; a repeatedly-failing recipient would grow it without limit. Add a max queue size or age-based purge.
- **`cloudRunClient.ts`** — no retry, no backoff, no timeout. Any transient 503 fails the file permanently for that prep run.
- **`photosService.ts`** — relies on dedup (existence check against `Photo_Files`) instead of retry. If a sync is interrupted mid-batch the remaining files are picked up on the next run, which is fine — but there's no deadline check, so a large event can silently run up to the 6-minute GAS limit and partially succeed with no visible error.

---

## 3. Performance & Scalability

GAS limits in play: 6 min per execution, SpreadsheetApp batch ops strongly preferred, UrlFetchApp rate-limited, MailApp daily quota.

### 3.1 Repeated full-sheet reads inside hot loops (Critical)

Verified in `photosService.ts`:

- `loadAlbums()` (line 140) → `getAllRows(PHOTO_ALBUMS)`
- `loadFileRecords()` (line 198) → `getAllRows(PHOTO_FILES)`
- `updateAlbumSyncStats()` (line 246) → `getAllRows(PHOTO_ALBUMS)` again to find the row to update
- `syncBatchToAlbums()` (line ~702) → `loadFileRecords()` again to rebuild dedup set per batch
- `reconcileAllPhotos()` (line 982, 1209, 1292) → three more reads

For an event with 50 batches and 5,000 photo records, each batch sync re-reads the entire sheet 4+ times. This is the single most likely cause of the 6-minute timeout on large events.

**Fix:** Load `PHOTO_ALBUMS` and `PHOTO_FILES` once at the start of `syncEventToAlbums` / `reconcileAllPhotos` and thread them through as parameters. Use an index/Map keyed by `(driveFileId, albumId)` for O(1) dedup lookups instead of `.find()` over the full array.

### 3.2 `getEventDriveTree()` re-walks the folder tree on every request (High)

`driveService.ts:575–635` calls `folder.getFolders()` and `folder.getFiles()` recursively with no caching. A single admin page load can trigger thousands of Drive API calls for a large event. Cache the result in `PropertiesService` for 5–10 min per `eventId`, and invalidate on the upload completion path.

### 3.3 Unbatched `updateRow` inside drain loop (High)

`syncQueueService.ts` updates queue rows one-by-one per drained item (`setValues()` per row). For N queued items this is N separate Sheet API calls. Batch them into a single `setValues()` covering the range.

### 3.4 Cloud Run: decompression-bomb guard disabled (High)

`cloud-run/main.py:37` — `Image.MAX_IMAGE_PIXELS = None`. This turns off Pillow's protection against decompression bombs; a maliciously crafted image (or a plausible super-high-res RAW) can OOM the container. Set a generous but finite limit (e.g. 500 MP or 1 GP) and return 400 with `unsupported_format` above it.

Other Cloud Run notes:
- `download` at `main.py:~101` has `timeout=120`; consider failing faster (30–45 s) and retrying.
- No connection pooling or metadata caching across requests — acceptable for modest scale.

### 3.5 Email quota not pre-checked for bulk operations (Medium)

`emailService.ts:177` checks `MailApp.getRemainingDailyQuota()` per send. Bulk user imports issue many sends sequentially; quota can be exhausted mid-loop, pushing the tail into the retry queue. Pre-check total projected sends up front and refuse (or warn) if insufficient.

### 3.6 `CacheService` vs `PropertiesService` scoping (Medium)

`uploadPrepService.ts:~247` uses `CacheService` for run state. `CacheService` is user-scoped by default; if a second admin resumes a run started by a different admin, the cache miss will look like a fresh run. `PropertiesService` (script-scoped) is the right home for cross-user run state — as already used by `syncJobService` and `emailService` retry queue.

### 3.7 UI payloads (Low)

- `ui/templates/upload.html` is 1,399 lines, with inline JS + Material Design Lite. Concurrency is already capped at 6 (`UPLOAD_CONCURRENCY=6`, acknowledging `google.script.run` round-trip cost). Not a bottleneck for expected admin workload.
- `ui/templates/drive_tree.html` uses lazy node expansion — good.

---

## 4. Hygiene (Low)

- 7 `STALE_*` files at repo root (documented on disk as stale). Archive or delete.
- `.~lock.IAF_Database_schema_v2.xlsx#` committed (Excel lock file). Add pattern to `.gitignore`.
- `gas-app/src/buildInfo.ts` exists — confirm it's generated at build, not hand-edited.
- Debug exports `debugClientId` / `debugConfig` (main.ts:113–136) in production code.

---

## 5. Prioritized action list

### Must fix (Critical)

1. **Dedup sheet reads in `photosService.ts`** — load `PHOTO_ALBUMS` / `PHOTO_FILES` once per sync operation and pass through. Biggest single performance win; unblocks large-event sync from timing out.
2. **Move `SUPER_ADMINS` + `CLOUD_RUN_URL` to Script Properties**, with validation at startup. No more code edits to change the admin list; no more `REPLACE_ME` shipping to prod.
3. **Set `Image.MAX_IMAGE_PIXELS`** to a finite value in `cloud-run/main.py` and validate dimensions before Pillow decodes.
4. **Add tests for `cloudRunClient.ts`, `tokenService.ts`, `syncJobService.ts`, `syncQueueService.ts`, and at least `photosService.ts`'s public API surface** (dedup, album lookup, happy-path `syncBatchToAlbums`).

### Should fix (High)

5. **Split `main.ts`** — move `serverXxx` handlers into per-area modules, leaving only the dispatcher.
6. **Retry + backoff in `cloudRunClient.ts`** for 429/5xx; parse `error` field from response so callers can distinguish retriable vs fatal.
7. **Cache `getEventDriveTree()`** output in `PropertiesService` for 10 min.
8. **Batch `updateRow` writes** in `syncQueueService.drainSyncQueue`.
9. **Surface non-fatal side-effect failures** in `serverCreateEvent`, `serverCreateUser`, `serverVerifyGoogleToken` — return warnings on the success envelope instead of swallowing.

### Nice to have (Medium)

10. Split `photosService.ts` and `emailService.ts` along the lines in §1.1.
11. Single source of truth for accepted MIME types.
12. Input validation for `google.script.run` handlers (same validator as `doPost`).
13. Move `UrlFetchApp` + file iterator helpers into `gasGlobals.ts`.
14. Bound the email retry queue size.

### Polish (Low)

15. Delete or archive `STALE_*` files; add Excel lock-file to `.gitignore`.
16. Delete deprecated `authMiddleware.apiKey.test.ts` / `apiClientHandlers.test.ts` stubs.
17. Guard `debugClientId` / `debugConfig`.

---

## 6. Fixes applied in this pass

These are the changes made in the same session as this assessment. All 1,017 tests still pass; `tsc --noEmit` is clean.

**1. Cloud Run decompression-bomb guard** — `cloud-run/main.py`
Set `Image.MAX_IMAGE_PIXELS` to 500 MP (configurable via `MAX_IMAGE_PIXELS` env var) instead of `None`. Stops a malformed or hostile image from OOMing the container.

**2. Super-admin allowlist → Script Properties** — `gas-app/src/config/superAdmins.ts`, `main.ts`, `services/uploadPrepService.ts`
Added `getSuperAdmins()` which reads `SUPER_ADMINS` from Script Properties (comma- or newline-separated), with the previous hardcoded email as a fallback so existing deploys don't break. `SUPER_ADMINS` is kept as a Proxy export for back-compat with any out-of-tree callers. Admins can now be added/removed without a redeploy.

**3. Cloud Run URL → Script Properties + placeholder guard** — same file + `cloudRunClient.ts`
Added `getCloudRunUrl()` and `isCloudRunConfigured()`. `convertImage()` refuses to call the placeholder and returns a distinct `error: 'not_configured'` so the failure is obvious in logs instead of looking like a generic upstream failure.

**4. Retry + backoff in `cloudRunClient.ts`**
Up to 3 attempts with exponential backoff (750 ms → 1.5 s → 3 s) for HTTP 429/500/502/503/504 and `UrlFetchApp` exceptions. Non-retriable responses (401/404, etc.) are returned immediately with the upstream `error` field preserved, so callers can finally distinguish *why* a file was skipped. On exhaustion, a synthesized error envelope is returned rather than whatever body the upstream sent.

**5. New test file: `tests/unit/cloudRunClient.test.ts`** (8 tests)
Covers: placeholder refusal, happy path + auth header wiring, non-JSON upstream response, retry on 503, retry on thrown exception, give-up after max attempts, no-retry on 401, no-retry on 404.

**6. Minor hygiene**
Removed pre-existing unused import `findClubByNormalizedName` in `main.ts` (was causing a `tsc --noEmit` failure in the checked-in tree; unrelated to the fixes above).

### What I deliberately didn't fix

- **`photosService.ts` sheet-read dedup** — the biggest single performance win (see §3.1), but touching this 1,388-line service with zero test coverage is high risk. The right sequence is to add characterization tests first, then refactor. It's still the top Critical item in the action list.
- **`main.ts` split** — extracting the 75+ `serverXxx` handlers is a larger refactor and should be sequenced after the photos-service tests land.
- **Deleting `STALE_*` and describe-skip-stub test files** — these are documentation/git-history calls the repo owner should make.
