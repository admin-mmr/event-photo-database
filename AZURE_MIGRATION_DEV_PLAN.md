# Azure Migration Dev Plan — audit findings & phased plan

**Date:** 2026-07-18
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
`/__/firebase/init.json`. Re-issuing ~50 admin identities mid-migration adds
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
hosting layer bills twice. Work: CORS middleware on the api (allow the SWA
origin, `Authorization` header), a `VITE_API_BASE` in the web build,
and drop the linked-backend step from `deploy-web.sh`. (If a single origin is
ever required — e.g. cookie needs — upgrade to Standard then; it's ~$9/mo.)

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

- Extract one Google-credential module (api `lib/googleCredentials.ts`,
  indexer equivalent in `drive.py`) with two modes: metadata-ADC (GCP) and
  WIF/SA-key (Azure). Re-point all 7 `GoogleAuth` sites + `firebase-admin`
  init. Make `GCP_PROJECT_ID`/`FIREBASE_PROJECT_ID` required-explicit env when
  not on GCP.
- `matcherClient.ts` / `imageConvertClient.ts`: make OIDC-ID-token minting
  conditional on provider (internal-ingress plain HTTP on Azure — the
  `http://` branch already exists).
- `indexerJob.ts`: introduce a job-trigger interface (Cloud Run Jobs API |
  Container Apps Jobs start via ARM + managed identity).
- `uploadDispatch.ts`: Cloud Tasks | Azure Storage Queue behind the same flag
  (note `UPLOAD_DISPATCH_TO_WORKER` defaults off — inline path needs nothing).
- Logger: map pino `severity` fields for Azure Monitor ingestion.
- **Acceptance:** GCP deploy runs unchanged with `CLOUD_PROVIDER=gcp`; unit
  tests cover both credential modes.

### AZ2 — Data-layer adapters (L, code, ships on GCP)

- **Db adapter** behind `lib/firestore.ts`: minimal document-store interface
  covering the used subset (doc get/set/merge/delete; where/orderBy/limit +
  cursor; single-doc transaction). Firestore impl = today's behavior; Cosmos
  impl per `cosmos-access-notes.md` partition keys. The 4 non-mechanical files
  get targeted rewrites: `gallery.ts` paging → continuation tokens + composite
  index policy (apply `cosmos-indexes.json`), `folderRebuildQueue.ts` +
  `rateLimit.ts` transactions → ETag if-match retry loops, `userData.ts`
  batch → per-partition TransactionalBatch.
- **Storage adapter** behind `gcsService.ts` + `volunteerUploadService.ts`:
  signed URL ↔ user-delegation SAS (keep TTL cap + content-disposition);
  volunteer resumable session → block-blob SAS upload (browser client change
  in `web/src` upload path). Delete dead `origFile()`.
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
- Write the 3 missing scheduler scripts (email-daily `0 7 * * *`,
  deleted-purge `30 3 * * *`, folder-rebuild `*/2 * * * *`) as Container Apps
  scheduled Jobs, fixing the `--command/--args` quoting pattern in all 5; keep
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
