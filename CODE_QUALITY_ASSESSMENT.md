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

1. ✅ **Dedup sheet reads in `photosService.ts`** — `PHOTO_ALBUMS` pre-loaded once in `syncBatchToAlbums` and threaded through `ensureEventAlbum`, `ensureClubAlbum`, and both `updateAlbumSyncStats` calls. Photo_Albums reads: 4 → 1 per call. Characterization tests added first (30 tests in `photosService.test.ts`) to make the refactor safe.
2. ✅ **Move `SUPER_ADMINS` + `CLOUD_RUN_URL` to Script Properties** — `superAdmins.ts`: `getSuperAdmins()`, `getCloudRunUrl()`, `isCloudRunConfigured()`; fallback to hardcoded defaults so existing deploys keep working.
3. ✅ **Set `Image.MAX_IMAGE_PIXELS`** — capped at 500 MP in `cloud-run/main.py` (configurable via `MAX_IMAGE_PIXELS` env var).
4. ⚠️ **Add tests for `cloudRunClient.ts`, `tokenService.ts`, `syncJobService.ts`, `syncQueueService.ts`, and `photosService.ts`'s public API surface** — `cloudRunClient.test.ts` (8 tests) and `photosService.test.ts` (30 tests) done. Still missing: `tokenService.ts`, `syncJobService.ts`, `syncQueueService.ts`.

### Should fix (High)

5. ❌ **Split `main.ts`** — move `serverXxx` handlers into per-area modules, leaving only the dispatcher. Not yet done; sequence after more test coverage lands.
6. ✅ **Retry + backoff in `cloudRunClient.ts`** — 3 attempts, exponential backoff (750 ms → 1.5 s → 3 s) for 429/5xx; upstream `error` field preserved so callers distinguish retriable vs fatal.
7. ✅ **Cache `getEventDriveTree()`** — 10-min PropertiesService cache keyed by `eventId`; `invalidateEventDriveTreeCache()` called from `serverCompleteUpload` after each upload.
8. ❌ **Batch `updateRow` writes in `syncQueueService.drainSyncQueue`** — not yet done. Each `markInProgress` / `markDone` / `markAttemptFailed` still does a separate `getAllRows` + `updateRow`. Requires adding a `batchUpdateRows` helper to `sheetService` and restructuring the drain loop.
9. ✅ **Surface non-fatal side-effect failures** — `warnings?: string[]` added to `ServerResponse`; `serverVerifyGoogleToken`, `serverCreateUser`, and `serverCreateEvent` now return warnings for email/album failures instead of swallowing them.

### Nice to have (Medium)

10. ❌ Split `photosService.ts` and `emailService.ts` along the lines in §1.1.
11. ❌ Single source of truth for accepted MIME types (`MEDIA_MIME_TYPES` in `constants.ts`, `PHOTO_MIME_TYPES` in `photosService.ts`, `PILLOW_MIMES` in `cloud-run/main.py` still in sync by convention only).
12. ❌ Input validation for `google.script.run` handlers (route through same `inputValidator.ts` as `doPost`).
13. ✅ `UrlFetchApp` mock added to `gasGlobals.ts` — `deleteProperty` and `resetMockScriptProperties()` helper added; `makeMockFileIter` still duplicated per test file (not yet consolidated).
14. ❌ Bound the email retry queue size (unbounded PropertiesService growth for repeatedly-failing recipients).
15. ✅ **`CacheService` → `PropertiesService` for `uploadPrepService` run state** — `saveRunState` / `loadRunState` / `deleteRunState` now use script-scoped `PropertiesService` so any admin can resume a run started by a different admin.

### Polish (Low)

16. ⚠️ **Delete or archive `STALE_*` files** — `STALE_README.md`, `STALE_USER_GUIDE.*`, `STALE_XSD_Partner_Overview.pdf`, `STALE_flowcharts.html` still present; owner decision needed on git history.
17. ✅ **Deleted deprecated test stubs** — `authMiddleware.apiKey.test.ts` and `apiClientHandlers.test.ts` removed.
18. ✅ **Excel lock-file added to `.gitignore`** — `.~lock.*#` pattern added.
19. ❌ Guard `debugClientId` / `debugConfig` — still exported in production with no auth check.

---

## 6. All fixes applied (commit `e96555d`)

All 1,047 tests pass; `tsc --noEmit` clean.

### Pass 1 (original assessment session)

**1. Cloud Run decompression-bomb guard** (`cloud-run/main.py`)
`Image.MAX_IMAGE_PIXELS = 500_000_000` (configurable via `MAX_IMAGE_PIXELS` env var).

**2. Super-admin allowlist → Script Properties** (`superAdmins.ts`)
`getSuperAdmins()` reads `SUPER_ADMINS` from Script Properties; falls back to hardcoded default so existing deploys don't break. Proxy export for back-compat.

**3. Cloud Run URL → Script Properties + placeholder guard** (`superAdmins.ts`, `cloudRunClient.ts`)
`getCloudRunUrl()`, `isCloudRunConfigured()`; `convertImage()` returns `error: 'not_configured'` instead of hitting a non-existent URL.

**4. Retry + backoff in `cloudRunClient.ts`**
3 attempts, 750 ms → 1.5 s → 3 s backoff for 429/5xx and thrown exceptions. Non-retriable 4xx returned immediately with upstream `error` field intact.

**5. `cloudRunClient.test.ts`** (8 tests)
Placeholder refusal, happy path, non-JSON response, retry on 503, retry on exception, give-up after max attempts, no-retry on 401/404.

**6. Removed unused import** in `main.ts` (`findClubByNormalizedName`).

### Pass 2

**7. `warnings` field on `ServerResponse`** (`main.ts`)
`serverVerifyGoogleToken`, `serverCreateUser`, `serverCreateEvent` collect non-fatal side-effect failures (email send, album creation) and return them as `warnings` so the UI can surface a non-blocking banner.

**8. `getEventDriveTree()` cache** (`driveService.ts`)
10-min PropertiesService cache per `eventId`. `invalidateEventDriveTreeCache(eventId)` called from `serverCompleteUpload`. `mockScriptProperties` mock extended with `deleteProperty`; `resetMockScriptProperties()` helper added to `gasGlobals.ts`; `driveService.test.ts` calls it in `beforeEach` to prevent inter-test cache leakage.

**9. `uploadPrepService` run state → `PropertiesService`** (`uploadPrepService.ts`)
`saveRunState` / `loadRunState` / `deleteRunState` use script-scoped `PropertiesService` instead of user-scoped `CacheService`.

**10. `.gitignore`** — `.~lock.*#` pattern added.

**11. Deleted deprecated `describe.skip` stubs** — `apiClientHandlers.test.ts`, `authMiddleware.apiKey.test.ts`.

### Pass 3 (§3.1)

**12. `photosService.test.ts`** (30 characterization tests)
`findAlbumByEvent`, `findAlbumsByEvent`, `ensureEventAlbum` (5 tests), `ensureClubAlbum` (6 tests), `syncBatchToAlbums` (11 tests including three `[§3.1 baseline]` sheet-read-count assertions).

**13. `photosService.ts` sheet-read dedup** (`syncBatchToAlbums`)
`Photo_Albums` pre-loaded once; optional `preloadedAlbums` param added to `ensureEventAlbum` and `ensureClubAlbum`; optional `preloadedRows` param added to `updateAlbumSyncStats`. Newly-created album rows appended to local cache so stat updates don't miss them. Photo_Albums reads per `syncBatchToAlbums` call: **4 → 1**.

---

## 7. Remaining work (pick up here next session)

Priority order:

1. **Tests: `tokenService.ts`** (security-critical, pure functions, easy to mock `UrlFetchApp`) — add `tokenService.test.ts`
2. **Tests: `syncJobService.ts` + `syncQueueService.ts`** — progress tracking and retry queue; stale-job and concurrency bugs are currently invisible
3. **Batch writes in `syncQueueService`** (§3.3) — add `batchUpdateRows(sheetName, updates: {rowIndex, row}[])` to `sheetService.ts`; restructure `drainSyncQueueTrigger` to pre-load rows once, write all `markInProgress` in one batch, and write all terminal-state updates in one batch
4. **Guard `debugClientId` / `debugConfig`** (§1.6 / polish item 19) — add `requireAdminOrFail` check or move behind an editor-only function
5. **Single source of truth for MIME types** (§1.6 medium) — export one canonical list from `constants.ts` and import it in `photosService.ts`; document the Python equivalent in `cloud-run/main.py`
6. **Input validation for `google.script.run` handlers** (§1.5 medium) — route `serverXxx` payloads through `inputValidator.ts`
7. **`main.ts` split** (§1.1 high) — extract `serverXxx` handlers into per-area route modules; tackle after the above tests land
8. **`emailService.ts` + `photosService.ts` god-file splits** (§1.1 medium) — sequence after `main.ts` split is done
9. **Email retry queue size bound** (§2.6 medium)
10. **Archive/delete `STALE_*` files** — owner decision
