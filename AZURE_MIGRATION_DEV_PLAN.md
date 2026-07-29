# Azure Migration Dev Plan — audit findings & phased plan

**Date:** 2026-07-18 · **re-audited 2026-07-28** (see §1.7 — corrects §1.3–1.5 counts)
**Companion docs:** `azure-webapp/AZURE.md` (service mapping), `azure-webapp/AZURE_MIGRATION_PROGRESS.md` (pilot checklist), `Azure_vs_GCP_Cost_Model.xlsx` (cost rationale), `CUTOVER_RUNBOOK.md` (GAS cutover, in flight).
**Why Azure:** the org's Microsoft nonprofit grant ($2,000/yr, recurring) covers the projected workload ~80× over; existing Azure spend is ~$65/mo with a <$100/mo total ceiling. The GCP stack currently rides temporary credits. Azure egress is also cheaper (first 100 GB/mo free).

---

## 1. Audit summary (what the codebase looks like today)

### 1.1 State of the pilot

`azure-webapp/` was forked from `cloud-webapp/` on ~2026-06-20 and its
`infra/scripts/` were rewritten for Azure Container Apps + Static Web Apps +
Cosmos (serverless) + Blob + Key Vault. **None of the scripts have been run
against a real subscription, and no application data-layer code was ported.**

### 1.2 The fork has rotted — drift is the #1 problem

Since the fork, ~90 commits landed on `cloud-webapp/` (GAS control-plane
migration G0–G6, managed folders, async upload queue, FindMe search quality,
i18n, cutover Phase B parity harness). Measured drift:

| Subtree | New in cloud-webapp (missing from azure-webapp) | Modified since fork |
|---|---|---|
| `api/src` (74 files) | **36 files** (RBAC, sheet stores, 14 admin routes, email service, folder-rebuild queue, Drive hardening) | 18 |
| `web/src` (66 files) | **26 files** (10 admin pages, i18n, zip download, session lib) | 26 |
| `shared/src` | 1 | 4 |
| `matcher/` | 3 | 6 |
| `indexer/` | 0 | 0 (byte-identical) |

Zero deletions and zero azure-only *source* files — all azure-specific work
lives in `infra/` and docs. **Conclusion: cherry-picking is not viable; and a
one-time re-fork just restarts the same rot.** See decision D1.

### 1.3 GCP coupling is real but narrow (api audit)

The api's cloud SDK surface is already funnelled through seams:

- **Firestore:** one client factory (`api/src/lib/firestore.ts`); ~26 files /
  ~90 call-sites consume it, but the usage is Cosmos-friendly — no
  `collectionGroup`, no `onSnapshot`, no `FieldValue.increment/arrayUnion`.
  Non-mechanical work concentrates in **4 files**: `routes/gallery.ts`
  (composite-index cursor paging with `orderBy(field)+orderBy(documentId())`
  tiebreak — Firestore-specific, must become Cosmos continuation tokens),
  `services/folderRebuildQueue.ts` (6 single-doc transactions → ETag
  optimistic concurrency), `middleware/rateLimit.ts` (1 transaction),
  `services/userData.ts` (one `db.batch()`).
- **Storage:** two files own it (`services/gcsService.ts`,
  `services/volunteerUploadService.ts`, ~18 call-sites). V4 signed URLs →
  user-delegation SAS (which signs *locally* — removes the per-URL IAM
  `signBlob` round-trip, a small win). The volunteer **resumable upload**
  protocol has no Blob equivalent — becomes SAS + block-blob upload, with a
  browser-side client change.
- **Five collections are only mirrors.** `users`, `clubs`, `uploadLinks`,
  `auditLog`, `emailPrefs` are Sheet-SSOT with a best-effort Firestore mirror
  for fast reads — they can migrate last or be regenerated, never "migrated."
- **The sneakiest break is the Google Workspace credential path, not the data
  layer.** Sheets/Drive/Gmail *stay* (the Sheet remains SSOT), but all keyless
  DWD token minting goes through GCP IAM `signJwt` authenticated by
  **Application Default Credentials from the Cloud Run metadata server**.
  Azure has no metadata-server ADC, so all 7 `GoogleAuth` sites
  (`sheetsService`, `driveService`, `emailService`, `matcherClient`,
  `imageConvertClient`, `indexerJob`, `uploadDispatch`) plus
  `firebase-admin`'s `applicationDefault()` fail at runtime until a GCP
  credential source is plumbed (see D4).
- **Tests:** ~47 vitest files, no emulator — each hand-rolls a Firestore-shaped
  fake. Adapter migration re-targets ~40 of them (meaningful cost; see AZ2).

### 1.4 Python services are nearly ready (indexer/matcher audit)

- **matcher** (~1–2 days): only `store.py` touches GCS, and it already has a
  dual `gs://`-vs-local backend — add a Blob backend beside it. The service has
  *no auth code* (relies on Cloud Run IAM); on Azure, internal ingress replaces
  IAM and the api's `matcherClient.ts` already has a no-token branch for
  `http://` URLs.
- **indexer** (~2–4 days): `blobs.py` (same dual-backend shape), the
  `FirestoreMeta` class in `job.py` (~40 LOC, `events.indexState` + `photos`
  upserts), and `drive.py`'s DWD JWT signing (same GCP IAM `signJwt` issue as
  the api). Core compute (ONNX embedding, EXIF, derivatives) is 100%
  cloud-agnostic. Tests are provider-neutral and run unchanged.
- **web** (~3–5 days): the only real coupling is `lib/firebase.ts` (Firebase
  Auth SDK + config bootstrap from Firebase Hosting's reserved
  `/__/firebase/init.json`, which doesn't exist on SWA — use the existing
  `VITE_FIREBASE_CONFIG` fallback). `zip.ts`/`zipDownload.ts` are already
  storage-agnostic (opaque signed URLs), so Blob SAS URLs just work — provided
  blob CORS is set.

### 1.5 The Azure infra scripts have defects — ranked

From static review of `azure-webapp/infra/scripts/` (never yet run):

1. **SWA Free tier cannot use linked backends** — `deploy-web.sh:33` creates
   `--sku Free` then `deploy-web.sh:44-49` calls `az staticwebapp backends
   link`, a Standard-tier-only feature. As written, `/api/**` never reaches the
   api and the whole app is dead end-to-end. Fix per decision D6.
2. **3 of 5 scheduled triggers are missing** (email-daily, deleted-purge,
   folder-rebuild). Consequences: trash never purges, the folder-rebuild queue
   never drains (admin "All events" buttons 202-and-pile-up), digests never
   send.
3. **The api identity is never granted rights to start the indexer job** —
   `provision-runtime-identities.sh` comments claim it but assigns no role on
   the Container Apps Job. Automated indexing can't trigger.
4. **No derivatives-CORS provisioning** (Azure counterpart of
   `provision-derivatives-cors.sh` is missing), and worse: Azure Blob CORS is
   account-scoped single-ruleset, and `provision-volunteer-uploads.sh:35-39`
   does `cors clear` + adds only the staging-upload rule — the two purposes
   clobber each other. Needs one merged account-level CORS script.
5. **`backfill-capture-time.sh:40` calls `az cosmosdb sql query`, which does
   not exist** — auto-enumeration silently no-ops (`|| true` swallows it).
6. **`bootstrap-azure.sh:85-88` creates blob containers with
   `--auth-mode login` before any data-plane RBAC exists**, errors swallowed →
   silent partial provisioning. Also `cosmos-indexes.json` (composite indexes
   for gallery sorts) is never applied by bootstrap.
7. **Scheduler job `--command/--args` quoting** in the two ported scheduler
   scripts is pipe-delimited and fragile — likely mis-parses.
8. Smaller: `staticwebapp.config.json` drops `X-Robots-Tag: noindex` (site
   becomes crawlable); globally-unique resource names default off the RG name
   (collision-prone); `verify-drive-access.sh:24` KEY_VAULT default breaks
   without `NAME_SUFFIX`; parity harness (`parity-check.mjs`) and
   `reindex-all.sh` not ported; `cosmos-access-notes.md`/`blob-access-notes.md`
   defer the actual `firestore.rules`/`storage.rules` conditions to "git
   history" so the authorization spec to port isn't captured anywhere in the
   Azure tree.

### 1.6 General code-health items found along the way

- `gcsService.origFile()` is exported but unused (dead code from the removed
  server-side ZIP path).
- ~40 bespoke Firestore fakes across tests duplicate the same query surface —
  consolidating on one shared in-memory adapter fake pays for itself during
  the Cosmos port (AZ2).
- Known TODOs from `CLAUDE.md` worth folding in: move `SYNC_TRIGGER_TOKEN` to
  Secret Manager / Key Vault via `--set-secrets`-style refs; fix
  `provision-index-scan-scheduler.sh` header-flag-by-verb bug (GCP side);
  indexer incremental checkpointing (a killed run loses all progress).

---

## 1.7 Re-audit 2026-07-28 (10 days on) — what changed

A full re-read of both trees. **§1.3–1.5 counts below are corrected; where this
section and §1.3–1.4 disagree, this section wins.**

### 1.7.1 Milestone status, verified against the code

- **AZ1 credential module: really done.** `api/src/lib/googleCredentials.ts`
  (188 LOC) exists, `CLOUD_PROVIDER` is a real `z.enum(['gcp','azure'])` with the
  `superRefine` that makes `GCP_PROJECT_ID` + `GOOGLE_SA_KEY_JSON` required on
  Azure, `middleware/auth.ts` picks `cert(serviceAccountKey())` over
  `applicationDefault()`, and no stray `new GoogleAuth(...)` survives outside the
  module. `api/test/googleCredentials.test.ts` is present.
- **AZ1 remainder untouched:** `indexer/drive.py` still signs DWD JWTs via
  `iamcredentials.googleapis.com` with ADC (`drive.py:11,89`);
  `indexerJob.ts:35` still POSTs `run.googleapis.com/v2`;
  `uploadDispatch.ts:51` still POSTs `cloudtasks.googleapis.com/v2`; the logger
  still emits GCP `severity` only.
- ~~**AZ2 not started.** `lib/firestore.ts` is still the bare 22-line
  `new Firestore(...)` factory — no adapter seam. `gcsService.ts` is still raw
  `@google-cloud/storage`.~~ **Both seams have since landed** (2026-07-28 db,
  2026-07-29 storage) — see AZ2 below.
- **AZ3 not started.** All eight §1.5 defects re-confirmed verbatim, including
  `deploy-web.sh:33` `--sku Free` + `:47` `backends link`,
  `backfill-capture-time.sh:40` `az cosmosdb sql query`, and
  `provision-volunteer-uploads.sh:35` `cors clear`.

### 1.7.2 The fork rotted further — 118 commits, not ~90

| Subtree | Files (cloud-webapp) | New (missing from azure-webapp) | Modified |
|---|---|---|---|
| `api/src` | 84 | **46** (was 36) | 22 |
| `web/src` | 73 | **33** (was 26) | 26 |
| `shared/src` | 11 | 1 | 6 |
| `matcher` | 57 | **14** (was 3) | 10 |
| `indexer` | 11 | 0 | **4** (was 0 — no longer byte-identical) |
| `api/test` | 60 | **34** | — |

Still zero azure-only *source* files. Drift roughly doubled in five weeks,
which is the empirical case for D1 restated: **do not re-sync the fork.**

### 1.7.3 New GCP coupling landed since the audit — AZ2 is bigger than scoped

1. **Transactions: 7 → 12, across 2 → 4 files.** AZ2 names only
   `folderRebuildQueue.ts` (6) and `rateLimit.ts` (1). Add
   `duplicateRemovalQueue.ts` (4 — lease/claim/chunk-commit) and
   `uploadDedupService.ts:160` (1). **`uploadDedupService` is the highest-risk
   port in the whole migration**: its transaction returns
   `{ won, confirmedInDrive }` and honours `STALE_CLAIM_MS`, and those two
   properties are the fix for the 2026-07-27 photo loss. An ETag retry-loop that
   gets the unproven-duplicate case subtly wrong re-opens that path — port it
   with its existing tests, not by re-derivation.
2. **`db.batch()`: 1 → 2 files, and the new one can't be a TransactionalBatch.**
   `eventDeletionService.ts:166` batch-deletes across eight collections;
   Cosmos TransactionalBatch is single-partition, so this must become
   best-effort per-partition deletes — which is fine (every step is already
   documented idempotent) but is a behaviour note, not a mechanical swap.
3. ~~**Storage-touching files: 2 → 4.** Add `uploadRecoveryService.ts:175`
   (`getFiles` over the staging prefix) and `eventDeletionService.ts` (via
   `deleteEventDerivatives`). `gcsService.ts` has grown to 20 exports including
   two deadline-bounded sweeps (`countEventDerivatives`,
   `deleteEventDerivatives`) whose budget behaviour the Blob port must keep.~~
   **RESOLVED 2026-07-29** — all four ported onto `ObjectStore`; the sweeps'
   budget behaviour is unchanged (they now page through `store.list`).
4. ~~**`infra/firestore.indexes.json` now has 12 composite indexes**, three of
   which postdate the fork.~~ **RESOLVED 2026-07-28** — see §1.7.6.
5. **§1.5 defect 2 is now 4 of 6 schedulers missing, not 3 of 5** —
   `findme-duplicates-drain` (`*/2 * * * *`) is also absent from the Azure tree.
6. ~~§1.6 items still open: `gcsService.origFile()` remains exported-and-unused,
   and `api/test/download.test.ts:46` still mocks it (a stale fake that will
   outlive the function).~~ **RESOLVED 2026-07-29** — both deleted with the
   storage port.

### 1.7.4 Two things are *smaller* than scoped

- **D6's web-side change is one file.** All 69 `/api/...` call sites in
  `web/src` (23 files) go through the seven helpers in `web/src/lib/api.ts` —
  zero raw `fetch('/api…')` bypasses. A `VITE_API_BASE` prefix applied there
  covers the whole SPA.
- **The api already has CORS plumbing** (`server.ts:67-82`, `CORS_ORIGINS`) —
  but it is gated `if (!isProd && env.CORS_ORIGINS)` and deliberately ships no
  headers in prod. D6 needs that gate widened for the Azure origin, not new
  middleware.

### 1.7.5 One correction to D3

`web/src/lib/firebase.ts:25-37` tries `/__/firebase/init.json` **first** and
falls back to `VITE_FIREBASE_CONFIG` only inside `if (res.ok)` / `catch`. On SWA,
`staticwebapp.config.json`'s `navigationFallback` rewrites unknown paths to
`/index.html` and `responseOverrides.404` does the same — so that fetch is
likely to return **HTTP 200 with HTML**, `res.ok` is true, and `res.json()`
throws *outside* the try's fall-through intent. Fix by ordering
`VITE_FIREBASE_CONFIG` first when `CLOUD_PROVIDER`/build target is Azure, or by
adding `/__/*` to `navigationFallback.exclude`. Do not assume the fallback works
untested.

### 1.7.6 Cosmos index policy — regenerated, and now generated (2026-07-28)

`azure-webapp/infra/cosmos-indexes.json` is derived from
`cloud-webapp/infra/firestore.indexes.json` by
`azure-webapp/infra/scripts/generate-cosmos-indexes.mjs`, and CI fails on drift
(`--check`, wired into `ci.yml`; the workflow's path filter now includes
`azure-webapp/infra/**`). Hand-maintaining it is what produced the 3-vs-12 gap.

It went from **3 composite indexes on one container → 12 across seven**
(`photos`, `users`, `clubs`, `uploadLinks`, `auditLog`, `folderRebuildBatches`,
`duplicateRemovalBatches`).

**Two things a verbatim translation would have gotten wrong**, both now handled
by the generator:

1. **The `/id` tiebreak was missing entirely.** Firestore appends `__name__` to
   every composite index *implicitly*; Cosmos requires it spelled out. Our paged
   queries order by `(<field>, DOC_ID)` — that total order is what D8's keyset
   paging rests on — so every `photos` composite now ends in `/id`, matching the
   direction of the sort field it breaks ties for. The old file's
   `(eventId, takenAt)` would not have served a single gallery page.
2. **Cosmos indexes every path by default, including payload arrays.** The queue
   batch documents inline their work list (up to `ENQUEUE_CAP` = 1500 items) and
   a drain tick rewrites the doc *per chunk*, so indexing `pending` /
   `pendingSweep` / `inProgress` would burn write RU on precisely the containers
   that write most often. Those paths are excluded.

Direction variants needed no special handling: Firestore already enumerates
ascending and descending separately (same reverse-scan constraint), so the
declared set maps 1:1 onto the ORDER BY directions the app issues.

**Shape change for AZ3:** Cosmos indexing policies are **per container**, so the
file is now a `containers` map rather than one policy. `bootstrap-azure.sh` must
apply each container's policy separately (`jq .containers.<name>`), not pass the
file wholesale to `--idx`.

---

## 2. Strategy decisions

**D1 — One codebase, not a fork.** Retire `azure-webapp/`'s copied source
trees. Make `cloud-webapp/` itself cloud-portable behind three seams — a
**db adapter** (Firestore | Cosmos), a **storage adapter** (GCS | Blob), and a
**Google-credential provider** (metadata-server ADC | SA key / WIF) — selected
by env (`CLOUD_PROVIDER=gcp|azure`). `azure-webapp/` shrinks to `infra/` +
docs only. Rationale: drift measured in §1.2 is what a fork costs in one month;
the adapter surface measured in §1.3–1.4 is small and already half-shaped
(both Python services literally have dual backends today). This also keeps the
GCP deployment working throughout — no flag-day.

**D2 — Sequence after the GAS cutover.** Status as of 2026-07-18: Phases A–C
of `CUTOVER_RUNBOOK.md` are **complete** (parity signed off, gas-app writes
frozen, schedulers resumed); the Phase D 48-hour watch is running, then Phase
E retires gas-app. Do not switch clouds under a cutover: AZ1–AZ3 are pure
refactors/scripts that ship on GCP and can start now, but AZ4 (Azure pilot
deploy) waits until Phase D is stable. The Sheet stays SSOT through both
moves — that's the whole point of keeping it.

**D3 — Keep Firebase Auth for the migration; Entra External ID is a separate
later workstream.** `firebase-admin` verification needs only Google's public
keys — no GCP runtime dependency — and the free tier is unaffected. Fix the
web bootstrap to use `VITE_FIREBASE_CONFIG` instead of
`/__/firebase/init.json` — **and note §1.7.5: the existing fallback is not
safe on SWA, because the navigation fallback answers that path with HTML/200.**
Re-issuing ~50 admin identities mid-migration adds
risk for zero cost benefit.

**D4 — Google credentials on Azure: prefer Workload Identity Federation,
fall back to an SA key in Key Vault.** GCP Workload Identity Federation can
trust Azure managed-identity tokens, keeping the setup keyless end-to-end
(matches the current keyless-DWD posture). If WIF setup stalls, a
`GOOGLE_APPLICATION_CREDENTIALS` SA key JSON stored in Key Vault and mounted
into api + indexer is the documented, boring fallback
(`verify-drive-access.sh` already assumes this). Either way, build it as a
single credential-provider module both the api (7 `GoogleAuth` sites) and
`indexer/drive.py` consume.

**D5 — Cosmos: provisioned free tier first, serverless second.** The cost
model's "Under $100 Plan" is right: the lifetime free tier (1,000 RU/s +
25 GB, one per subscription) makes the DB line $0 with headroom to spare at
~10k reads/day; serverless has *no* free tier. Use free tier if the
subscription slot is unclaimed; otherwise serverless (scripts currently
provision serverless — parameterize it).

**D6 — Keep SWA Free; the SPA calls the api's Container App FQDN directly
with CORS.** Don't buy SWA Standard just for the linked backend. Direct calls
also avoid re-creating the GCP lesson where every api byte proxied through the
hosting layer bills twice. Work: widen the api's existing but prod-disabled CORS
gate (`server.ts:67`, `CORS_ORIGINS`) to allow the SWA origin in production, a
`VITE_API_BASE` in the web build — **one file, `web/src/lib/api.ts`, per
§1.7.4** — and drop the linked-backend step from `deploy-web.sh`. (If a single origin is
ever required — e.g. cookie needs — upgrade to Standard then; it's ~$9/mo.)

**D8 — Paginate by keyset, not by Cosmos continuation tokens** (added
2026-07-28, during AZ2). The `Query` adapter keeps Firestore's
`startAfter(...values)` and the Cosmos impl renders it as a keyset predicate
(`field > @v OR (field = @v AND c.id > @id)`), served by the same composite
index. Rationale: continuation tokens are single-use, forward-only and opaque,
whereas the gallery's existing base64url `{field, id}` cursor is value-based,
stable across deploys and page-size independent. Keyset keeps the HTTP cursor
contract byte-identical on both clouds, needs no rewrite of `gallery.ts`, and
**retires risk #2** (“continuation tokens behave differently from `startAfter`”)
rather than mitigating it. The cost is that every paged query needs its
composite index present on Cosmos — which `cosmos-indexes.json` owes anyway.

**D7 — Regenerate derived data; copy only what's primary.** Most of Firestore
is a derived cache: control-plane collections mirror the Sheet (reconcile
regenerates them), `photos`/`events.indexState` are rebuilt by the indexer
from Drive, `rate_limits`/`folderRebuild` are transient. **Copy** only:
`consents`, `match_feedback`, `match_runs` (small), and the derivatives bucket
(originals + web/thumb + `.npy` embeddings — `azcopy` supports GCS→Blob
directly; copying embeddings avoids re-paying the embedding compute for every
past event). Everything else is regenerated on Azure by running reconcile +
(if ever needed) reindex.

---

## 3. Milestones

Effort labels: S ≤ 2 days, M ≤ 1 week, L ≤ 3 weeks.

### AZ0 — Preconditions & subscription prep (S, ops)

- GAS cutover reaches Phase D — ✅ done 2026-07-18 (cloud-webapp is the
  writer, gas-app writes frozen, schedulers live; 48 h watch running, Phase E
  retire follows).
- Confirm Azure subscription, nonprofit grant status, and whether the Cosmos
  free-tier slot is unclaimed (D5).
- Pick region + globally-unique name suffix (ACR / storage / cosmos); record
  in `azure-webapp/infra/scripts/` defaults.
- Day-1 guardrails per the cost model: budget alert at $80/mo
  (50/80/100% thresholds), cost anomaly alert, Log Analytics 5 GB daily cap.
  `provision-budget-guardrails.sh` covers most of this — verify, don't trust.

### AZ1 — Credential provider + service-to-service unbinding (M, code, ships on GCP)

The pieces that break *silently* on Azure, done first because everything
downstream needs them:

- ✅ Extract one Google-credential module (api `lib/googleCredentials.ts`) with
  two modes: metadata-ADC (GCP, keyless) and explicit SA-key (Azure,
  `GOOGLE_SA_KEY_JSON`). Re-pointed all 7 `GoogleAuth` sites (`sheetsService`,
  `driveService`, `emailService`, `matcherClient`, `imageConvertClient`,
  `uploadDispatch`, `indexerJob`) + `firebase-admin` init to it. `CLOUD_PROVIDER`
  env (default `gcp`) selects the mode; a config `superRefine` makes
  `GCP_PROJECT_ID` + `GOOGLE_SA_KEY_JSON` required-explicit when
  `CLOUD_PROVIDER=azure`. The three duplicated DWD signJwt+exchange blocks
  collapse into one `mintDwdToken` with a shared (sa|subject|scope) cache.
- ✅ `matcherClient.ts` / `imageConvertClient.ts`: OIDC-ID-token minting now goes
  through `getIdTokenHeaders`, which returns `{}` on Azure (internal-ingress
  plain HTTP) and for `http://` local-dev URLs.
- ⬜ Indexer `drive.py` credential equivalent (Python side — separate follow-up
  PR within AZ1; the api side above is done and ships on GCP).
- ⬜ `indexerJob.ts`: introduce a job-trigger interface (Cloud Run Jobs API |
  Container Apps Jobs start via ARM + managed identity). *(Credentials are now
  provider-neutral; the job-start API surface is still GCP-specific.)*
- ⬜ `uploadDispatch.ts`: Cloud Tasks | Azure Storage Queue behind the same flag
  (note `UPLOAD_DISPATCH_TO_WORKER` defaults off — inline path needs nothing).
- ⬜ Logger: map pino `severity` fields for Azure Monitor ingestion.
- **Acceptance:** GCP deploy runs unchanged with `CLOUD_PROVIDER=gcp` (default);
  unit tests cover both credential modes (`api/test/googleCredentials.test.ts`,
  12 tests). ✅ for the credential module; the remaining ⬜ items above are the
  rest of AZ1.

### AZ2 — Data-layer adapters (L, code, ships on GCP)

**Landed 2026-07-28 — the db seam and its test harness:**

- ✅ `api/src/lib/db/types.ts` — the provider-neutral `DocumentStore` interface,
  scoped to the *measured* surface (only `==` filters; `orderBy` with a `DOC_ID`
  sentinel; `limit`/`startAfter`/`select`/`count`; `set|create|update|delete|add`;
  single-doc transactions; `delete`-only batches). What nothing uses is listed as
  deliberately absent so it does not creep back in.
- ✅ `api/src/lib/db/firestoreDb.ts` — the Firestore impl as pure delegation, and
  now the **only** file in the api allowed to import `@google-cloud/firestore`
  (verified: `grep -rn '@google-cloud/firestore' api/src` hits that file only).
- ✅ `lib/firestore.ts` re-points `firestore()` at the adapter, selected by
  `CLOUD_PROVIDER`, and throws a clear error on `azure` until the Cosmos impl
  lands. The name is unchanged, so all 31 consuming modules were untouched.
- ✅ The 6 direct SDK imports are gone (`rateLimit`, `gallery`, `feedback`,
  `metrics`, `userData`, `lib/firestore`).
- ✅ `api/test/helpers/fakeDb.ts` — ONE in-memory `DocumentStore`, pinned by 18
  contract tests in `api/test/fakeDb.test.ts`. Those tests are the Cosmos
  adapter's acceptance criteria. `rateLimit.test.ts` is migrated onto it.
- ✅ **`api/src/lib/db/cosmosDb.ts` + `cosmosSql.ts` — the Cosmos adapter.**
  SQL translation is split out and pure. Four Cosmos-specific hazards are handled
  explicitly, each with tests:
  - **`IS_DEFINED` on every `orderBy` field.** Firestore silently excludes
    documents missing the sort field; Cosmos sorts them as `undefined`. Without
    the guard, `gallery.ts`'s `addedAt`→`takenAt` fallback (which triggers on an
    empty first page) would never fire and the gallery would mis-order instead.
  - **Point reads without the partition key.** `photos` is partitioned by
    `/eventId`, but `collection('photos').doc(id).get()` has no event in hand, so
    a read falls back to a cross-partition `WHERE c.id = @id`. A wrong entry in
    `PARTITION_KEYS` therefore costs RU, never correctness.
  - **`id` is a reserved document property on Cosmos and outside the body on
    Firestore**, so `data()` strips it. Safe because no collection stores its own
    `id` — the queue services build it as `{ id: snap.id, ...snap.data() }`.
  - **Ids are percent-encoded** for the four characters Cosmos forbids (`/ \ ? #`)
    and decoded on read, so `snap.id` round-trips. No current id needs it; this
    exists so a future one cannot produce a baffling HTTP 400.
  - Transactions are ETag if-match retry loops. A read that found nothing commits
    via `create`, so a 409 re-runs the body — that is what preserves the claim
    semantics behind the 2026-07-27 upload-loss fix. A transaction writing two
    documents throws rather than silently losing atomicity.
- ✅ **One contract, both adapters.** `test/helpers/documentStoreContract.ts`
  holds 24 cases; `fakeDb.test.ts` and `cosmosDb.test.ts` each run all of them.
  The Cosmos side runs over `test/helpers/fakeCosmos.ts`, which **executes** the
  generated SQL in memory rather than stubbing results — so the keyset predicate
  and `IS_DEFINED` guards are actually exercised. Plus 13 golden-SQL cases in
  `cosmosSql.test.ts`.
  - This caught a real adapter bug: `data()` was a shallow spread, so a caller
    mutating a nested array corrupted the cached row. Firestore materializes a
    fresh object graph per `data()`; the adapter now deep-clones to match.
- ✅ Wiring: `COSMOS_ENDPOINT` / `COSMOS_DATABASE` / `COSMOS_KEY` config (endpoint
  required when `CLOUD_PROVIDER=azure`), and `initDb()` awaited in `index.ts`
  before listen. The Azure SDKs load only through `await import()`, so the GCP
  image never pulls them in.
  - Auth is the api's **managed identity** (Cosmos DB Built-in Data Contributor);
    `COSMOS_KEY` exists only for the local emulator, which has no Entra identity.
    Keyless on both clouds, matching the GCP posture.
- Verified: `tsc` clean (both `tsconfig.json` and `tsconfig.build.json`),
  **63 test files / 589 tests green**, GCP behaviour unchanged.
**Landed 2026-07-29 — the storage seam, both impls:**

- ✅ `api/src/lib/storage/types.ts` — the provider-neutral `ObjectStore`, scoped
  to the *measured* surface (`signReadUrl` · `read` (whole or an inclusive byte
  range) · `write` · `head` · `remove` · `list(prefix, limit)` ·
  `createUploadSession`). What nothing uses is listed as deliberately absent.
  Three normalizations the adapters own, because the providers really differ:
  **md5 is lowercase hex** (`''` = *unknown*, never *no match*), **a delete of a
  missing object is a no-op** (all 8 call sites passed `ignoreNotFound`), and
  **`head` returns `null`** instead of the old `exists()`-then-`getMetadata()`
  pair — one round trip per staged file instead of two.
- ✅ `api/src/lib/storage/gcsStore.ts` — the GCS impl as pure delegation, and now
  the **only** file in the api allowed to import `@google-cloud/storage`
  (verified; `lib/gaxiosNativeFetch.ts` mentions it in prose only).
  `lib/storage.ts` selects by `CLOUD_PROVIDER` with an `initStorage()` awaited in
  `index.ts`, exactly mirroring `lib/firestore.ts` / `initDb()`.
- ✅ `api/src/lib/storage/blobStore.ts` — the Blob impl, over a narrow `BlobOps`
  port with `sdkOps()` as the only untested strip. Auth is the api's managed
  identity (`Storage Blob Data Contributor` + **`Storage Blob Delegator`** for
  user-delegation SAS, which is a second role AZ3 has to grant); the delegation
  key is cached 6 of its 7 days because the gallery signs a URL per thumbnail.
  Buckets map to containers 1:1 by name. Three hazards handled explicitly:
  - **Azure stores no md5 for a browser-committed blob** — only a `Content-MD5`
    the writer supplied. So `md5Hex` is `''` for every volunteer upload there and
    the upload dedup falls back to its name+size key (the same fallback a file
    Drive didn't hash already takes). Fail-safe in the right direction — a
    surplus copy is recoverable, a skipped one is a lost photo — but it is
    strictly weaker than GCS. **Verify against a real account in AZ4.**
  - **`Put Block List` overwrites the blob's properties and metadata**, so the
    api cannot pin metadata on a staged object. `UploadSession.clientStampsMetadata`
    surfaces this rather than hiding it, and the client sends `x-ms-meta-*` at
    commit. Nothing server-side trusts it for authorization: event/club/tag come
    from the api-validated link, and the object *key* — api-chosen, and the only
    thing the SAS is scoped to — is what the batch id is read from.
  - **Deleting a missing blob is a 404**, where GCS takes `ignoreNotFound`;
    `deleteIfExists` restores the no-op the whole app assumes.
- ✅ **One contract, both adapters.** `test/helpers/objectStoreContract.ts` holds
  24 cases naming the caller each protects; `fakeObjectStore.test.ts` and
  `blobStore.test.ts` each run all of them, the latter over
  `test/helpers/fakeBlobService.ts` — which models the service in *Azure's* own
  vocabulary (`contentLength`, an md5 byte array, offset+count downloads, a 404
  on a missing blob) so the normalization is exercised rather than assumed.
  - The contract immediately caught the fake defaulting `contentType` where both
    real adapters do, which is the class of divergence it exists to find.
- ✅ **Services ported, GCS behaviour identical:** `gcsService.ts` (now the app's
  *key layout and policy*, not a client), `volunteerUploadService.ts`,
  `uploadRecoveryService.ts`, `eventDeletionService.ts` (via the two sweeps,
  whose deadline-bounded behaviour is unchanged). Two hand-rolled base64→hex md5
  helpers that had drifted apart (`gcsMd5ToHex`, `b64ToHex`) collapsed into the
  adapters. `origFile()` is **deleted** along with the stale
  `download.test.ts:46` fake that outlived it (§1.6).
- ✅ **The `Content-Disposition` is built once**, in `storage/disposition.ts`, and
  the routes pass a RAW filename. `routes/download.ts` used to
  `encodeURIComponent` it itself; with the adapter also encoding, a Chinese
  filename would have reached the volunteer as `%E6%B9%98…`. A test pins the raw
  contract in both directions.
- ✅ **The browser learns which protocol to speak.** `POST /session` returns
  `protocol` (`gcs-resumable` | `azure-block-blob`, defaulted in the Zod schema
  so a cached bundle mid-deploy keeps the path it implements) and
  `web/src/lib/blockBlobUpload.ts` implements the Azure one — named blocks, an
  explicit `comp=blocklist` commit, resume by listing uncommitted blocks. The
  session cache, fingerprint key, retry schedule and callbacks stay shared.
  See UPLOAD_RESUMABLE_NOTES.md for the protocol table.
- ✅ Wiring: `AZURE_STORAGE_ACCOUNT_URL` / `AZURE_STORAGE_CONNECTION_STRING`
  config (one of the two required when `CLOUD_PROVIDER=azure`, the connection
  string for Azurite only), `@azure/storage-blob` added and loaded solely through
  `await import()`.
- ✅ **Three more bespoke fakes retired** onto the shared one:
  `volunteerUploadService.test.ts` (the last `vi.mock('@google-cloud/storage')`
  in the repo), `uploadRecoveryService.test.ts`, `download.test.ts`.
- Verified: `tsc` clean (api + web + shared), `eslint` clean,
  **67 api test files / 691 tests and 22 web files / 163 tests green** (from
  65/627 and 21/143), GCP behaviour unchanged.

- ⬜ Remaining: the Python backends; the rules-spec port; migrating the other ~36
  bespoke test fakes.
  - **Not yet proven, and cannot be here:** real SAS validation, account-level
    CORS, per-transaction cost, and whether a browser's Put Block List behaves as
    documented. `fakeBlobService.ts` is a model of Blob Storage, not Blob
    Storage. Run the contract suite plus one real volunteer upload against
    Azurite or a dev account in AZ4 — treat that as the gate, not these tests.
  - **Not yet proven, and cannot be here:** RU cost, index requirements, and real
    cross-partition `ORDER BY`. `fakeCosmos.ts` is a model of Cosmos, not Cosmos.
    Run the contract suite against the emulator or a dev account in AZ4 —
    treat that as the gate, not these tests.
  - ✅ `cosmos-indexes.json` is regenerated and drift-guarded — §1.7.6.
  - **Test-fidelity finding:** `gallery.test.ts` hand-rolls ~60 lines
    reimplementing Firestore paging and orders with `localeCompare`, where
    Firestore orders by UTF-8 code point. With Chinese filenames in play that
    fake can pass while production pages differently — the same
    code-point-vs-locale trap CLAUDE.md documents for duplicate removal. Migrate
    it onto the shared fake (needs a fault-injection hook for the
    missing-composite-index case) before trusting its paging assertions.

- **Db adapter** behind `lib/firestore.ts`: minimal document-store interface
  covering the used subset (doc get/set/merge/delete; where/orderBy/limit +
  cursor; single-doc transaction). Firestore impl = today's behavior; Cosmos
  impl per `cosmos-access-notes.md` partition keys. The non-mechanical files get
  targeted rewrites — **6 of them, per §1.7.3, not 4**: `gallery.ts` paging →
  continuation tokens + composite index policy (regenerate
  `cosmos-indexes.json` from the current 12-entry `firestore.indexes.json`),
  `folderRebuildQueue.ts` (6) + `rateLimit.ts` (1) + `duplicateRemovalQueue.ts`
  (4) + `uploadDedupService.ts` (1) transactions → ETag if-match retry loops,
  `userData.ts` batch → per-partition TransactionalBatch, and
  `eventDeletionService.ts`'s cross-collection batch → best-effort
  per-partition deletes (it is already idempotent by design).
  **Port `uploadDedupService.ts` against its existing tests** — its
  `{ won, confirmedInDrive }` + `STALE_CLAIM_MS` semantics are the 2026-07-27
  photo-loss fix and must not be re-derived.
- ~~**Storage adapter** behind `gcsService.ts` + `volunteerUploadService.ts`
  (+ `uploadRecoveryService.ts` and `eventDeletionService.ts` — see §1.7.3;
  keep the deadline-bounded sweep behaviour of `countEventDerivatives` /
  `deleteEventDerivatives`):
  signed URL ↔ user-delegation SAS (keep TTL cap + content-disposition);
  volunteer resumable session → block-blob SAS upload (browser client change
  in `web/src` upload path). Delete dead `origFile()`.~~ **DONE 2026-07-29** —
  see the storage-seam entry above.
- **Python:** Blob backend in `matcher/store.py` + `indexer/blobs.py`
  (`https://…blob.core.windows.net/...` or `az://` prefix beside `gs://` and
  local); Cosmos impl of `FirestoreMeta` in `indexer/job.py`.
- **Port the rules spec:** recover `firestore.rules`/`storage.rules` from git
  history, embed the conditions verbatim in the two `infra/*-notes.md` files,
  and verify each condition exists as api middleware (most already do —
  `requireAuth`/`requireAdmin`/`rbac.ts`); add tests for any gaps.
- **Tests:** build ONE shared in-memory fake of the adapter interface; migrate
  the ~40 bespoke Firestore fakes onto it as files get touched.
- **Acceptance:** full vitest + pytest suites green against both impls
  (Cosmos emulator or a dev Cosmos account); GCP prod unaffected.

### AZ3 — Fix the Azure infra layer (M, scripts)

Work down §1.5 in order:

- `deploy-web.sh`: drop the backend link; build with `VITE_API_BASE`; add api
  CORS env. Restore `X-Robots-Tag` in `staticwebapp.config.json`.
- Write the **4** missing scheduler scripts (email-daily `0 7 * * *`,
  deleted-purge `30 3 * * *`, folder-rebuild `*/2 * * * *`, duplicates-drain
  `*/2 * * * *` — §1.7.3 item 5) as Container Apps
  scheduled Jobs, fixing the `--command/--args` quoting pattern in all 6; keep
  them create-or-update idempotent (the folder-rebuild GCP script is the model).
- One `provision-blob-cors.sh` that owns the account-wide ruleset (SWA origin +
  staging-upload origin in a single merged rule set — never `cors clear` from
  two places).
- `provision-runtime-identities.sh`: actually grant the api identity the job-
  start role on the indexer job; remove the `|| true`s or echo failures.
- `bootstrap-azure.sh`: grant the operator Storage Blob Data Contributor +
  retry container creation after RBAC propagation; apply
  `cosmos-indexes.json`; parameterize serverless vs free-tier (D5); make the
  name suffix a required arg.
- Fix `backfill-capture-time.sh` enumeration (query via the api or a small
  Node script using the Cosmos SDK — not the az CLI); fix
  `verify-drive-access.sh` KEY_VAULT default; port `reindex-all.sh` and
  `parity-check.mjs`.
- Add `.github/workflows/` for ACR build + deploy with Entra federated
  credentials (still missing entirely).
- **Acceptance:** `bootstrap → identities → deploys → schedulers →
  guardrails` runs top-to-bottom on a scratch RG with zero swallowed errors;
  `az containerapp list` shows every app `minReplicas=0` (zero-idle-cost rule
  carries over verbatim).

### AZ4 — Pilot deploy (M, ops + fixes)

- Run the AZ3 sequence against the real subscription; seed Key Vault
  (SYNC-TRIGGER-TOKEN, RECAPTCHA-KEY, CONSENT-POLICY-VERSION, DRIVE-SA-JSON or
  WIF config).
- Deploy all four components with `CLOUD_PROVIDER=azure`.
- `azcopy` the derivatives bucket (originals, web, thumb, embeddings) GCS →
  Blob; copy `consents`/`match_feedback`/`match_runs`; run reconcile to
  populate the Cosmos mirrors from the Sheet (D7).
- Smoke: `/api/health`; sign-in; gallery paging on all three sort orders
  (exercises the composite indexes); Find-Me search on a copied event
  (matcher loads `.npy` from Blob); Save-to-Photos + ZIP (proves blob CORS);
  volunteer upload end-to-end (block-blob path); trigger indexer job on one
  test event via the admin UI (proves job-start RBAC + Drive DWD from Azure);
  send a test digest email (proves Gmail DWD).
- Keep all Azure schedulers **paused** except when testing — the GCP stack is
  still live and `findme-drive-sync` writes the SSOT Sheet.

### AZ5 — Parity run + cutover (M, ops)

Mirror `CUTOVER_RUNBOOK.md`'s shape:

- Run the ported `parity-check.mjs` GCP-vs-Azure (both read the same Sheet
  SSOT, so control-plane parity is mostly free; diff gallery/photos responses
  for a sample of events).
- One full event cycle on Azure (upload → index → gallery → Find-Me →
  digest) while GCP remains primary.
- Cut DNS/entry-point, resume Azure schedulers, pause GCP schedulers.
  Rollback = point DNS back and resume GCP schedulers (the Sheet SSOT makes
  this cheap — that design decision is doing a lot of work here; protect it).
- Watch the budget alert + egress line through the first live event day.

### AZ6 — Decommission GCP + follow-ups (S–M)

- After N stable weeks: delete Cloud Run services/jobs, Firestore, buckets
  (after final azcopy verify), scheduler jobs; keep the Firebase Auth project
  (still the IdP) and the Google Workspace side (Sheet/Drive/Gmail — permanent).
- Follow-up backlog (not gating): Entra External ID evaluation (D3), indexer
  incremental checkpointing, moving originals to Cool tier after 30 days
  (lifecycle rule from the cost model), delete `azure-webapp/`'s stale source
  copies once D1 lands.

---

## 4. Effort & sequencing summary

| Milestone | Size | Depends on | Can overlap GAS cutover? |
|---|---|---|---|
| AZ0 prep | S | — | yes |
| AZ1 credential provider | M | — | yes (ships on GCP) |
| AZ2 data adapters | L (the long pole, ~2–4 wks) | AZ1 | yes (ships on GCP) |
| AZ3 infra fixes | M | — | yes (parallel with AZ2) |
| AZ4 pilot deploy | M | AZ1–AZ3 | no — after the Phase D watch clears |
| AZ5 parity + cutover | M | AZ4 | no |
| AZ6 decommission | S–M | AZ5 | no |

Total: roughly **6–9 working weeks** of focused effort, with AZ1–AZ3
parallelizable and deployable to GCP incrementally (no long-lived branch).

## 5. Top risks

1. **DWD from Azure** (D4) — the one integration that can't be tested without
   touching the real Workspace tenant. De-risk first: run
   `verify-drive-access.sh` from a scratch Container App in AZ0/AZ1, before
   any data-layer work.
2. **Gallery paging semantics on Cosmos** — continuation tokens behave
   differently from `startAfter` cursors (no bidirectional index reuse).
   Golden-file tests comparing page sequences GCP-vs-Azure in AZ2.
3. **Cosmos RU burn** — serverless/free-tier RU per query is unknown until
   measured; the reconcile job's upsert fan-out is the likely hotspot. Measure
   in AZ4 with Cost Management before AZ5.
4. **Volunteer upload rewrite** — the only user-facing protocol change; test
   on real phones (the in-app-browser cases the web code already warns about).
5. **Grant/subscription assumptions** — confirm the $2,000/yr grant applies to
   this subscription and the free-tier Cosmos slot is free *before* AZ2's
   Cosmos-impl choices harden (AZ0).
