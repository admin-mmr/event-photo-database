# Setup Runbook — Google Cloud + Firebase for "Find Me"

**Project:** 湘舍动公益文件系统 (Event Photo Database)
**Implements setup for:** `FACE_MATCHING_FEATURE_PRD.md` + `FACE_MATCHING_DEV_PLAN.md`
**Prepared for:** IT Department, Youth4AM / mmrunners
**Date:** June 8, 2026

This is a do-it-in-order checklist to stand up the Google Cloud project, Firebase, and every service the feature needs. Work top to bottom; each step has the **commands**, a **verify** check, and a **checkbox**. Where the existing repo already has a script, the runbook points at it instead of duplicating commands.

> Legend: 🟢 = a repo script already does this · 🟡 = run the inline commands (script to be added per dev plan §2.4) · ⚠️ = decision or human action required.

---

## Conventions (set these once per shell)

```bash
export PROJECT_ID="mmr-data-pipeline"         # actual project (number 489676654863)
export REGION="us-central1"                   # match firebase.json (us-central1)
export GITHUB_REPO="admin-mmr/event-photo-database"   # owner/name of the repo (must match WIF binding)
gcloud config set project "$PROJECT_ID"
gcloud config set run/region "$REGION"
```

Keep `REGION=us-central1` unless you change `cloud-webapp/infra/firebase.json` (its rewrite hardcodes `us-central1`).

---

## Phase A — Accounts, tooling, billing

### A1. Tools installed 🟡
```bash
gcloud version          # Google Cloud CLI
firebase --version      # Firebase CLI  (npm i -g firebase-tools)
node --version          # Node 20 LTS (matches cloud-webapp/.nvmrc)
docker --version        # for building api/matcher/indexer images
psql --version          # to run SQL migrations (optional, can use Cloud SQL Studio)
```
- [x] All five tools present. Missing gcloud → install Google Cloud CLI; missing firebase → `npm i -g firebase-tools`.

### A2. Authenticate as a project Owner 🟡
```bash
gcloud auth login
gcloud auth application-default login
firebase login
```
- [x] `gcloud auth list` shows your account as ACTIVE.

### A3. Nonprofit billing + $10k credit ⚠️
The credit is **separate** from Workspace for Nonprofits (see `UX_AND_GCP_ASSESSMENT.md` §2.1 and `GCP_Nonprofit_Credit_Application_Guide.md`).
- [x] Org verified via Goodstack/TechSoup.
- [x] Cloud credit requested at the Google for Nonprofits Cloud credit page.
- [x] A **Billing Account** exists and you can link projects to it.

---

## Phase B — Create the Google Cloud project

### B1. Create (or select) the project 🟡
```bash
# Create new (skip if it already exists):
gcloud projects create "$PROJECT_ID" --name="Youth4AM Event Photos"

# Link billing (find your billing account id first):
gcloud billing accounts list
gcloud billing projects link "$PROJECT_ID" \
  --billing-account="XXXXXX-XXXXXX-XXXXXX"
```
**Verify:**
```bash
gcloud projects describe "$PROJECT_ID" --format='value(projectId,projectNumber)'
gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)'   # → True
```
- [x] Project exists and `billingEnabled = True`.

---

## Phase C — Enable all required APIs

### C1. Core APIs (covered by bootstrap script) 🟢
`cloud-webapp/infra/scripts/bootstrap-gcp.sh` already enables: `run`, `cloudbuild`, `artifactregistry`, `firestore`, `firebase`, `firebasehosting`, `iam`, `iamcredentials`, `secretmanager`, `storage`. You'll run that script in Phase E.

### C2. Feature-specific APIs (dev plan §2.1) 🟡
```bash
gcloud services enable \
  sqladmin.googleapis.com \
  pubsub.googleapis.com \
  eventarc.googleapis.com \
  cloudscheduler.googleapis.com \
  drive.googleapis.com \
  recaptchaenterprise.googleapis.com \
  --quiet
# Optional, only if policy requires customer-managed encryption keys:
# gcloud services enable cloudkms.googleapis.com --quiet
```
**Verify (should list every API above):**
```bash
gcloud services list --enabled \
  --filter="config.name:(run firestore firebase firebasehosting secretmanager storage sqladmin pubsub eventarc cloudscheduler drive recaptchaenterprise)" \
  --format='value(config.name)'
```
- [x] All core + feature APIs appear in the output.

---

## Phase D — Firebase setup

### D1. Add Firebase to the GCP project 🟡
A Firebase project is the same GCP project with Firebase features turned on.
```bash
firebase projects:addfirebase "$PROJECT_ID"     # no-op if already added
firebase use "$PROJECT_ID"
```
**Verify:**
```bash
firebase projects:list   # your project shows "added" / resource state ✓
```
- [x] Project listed by `firebase projects:list`. *(2026-06-09)*

> ⚠️ Gotcha: `addfirebase` returns a generic 403 (despite Owner + firebase.admin) if the account has never accepted the Firebase Terms of Service. Fix: log into console.firebase.google.com once and add the project there. Also: `firebase use` must run from `cloud-webapp/infra/` (where firebase.json lives), or pass `--project`. See `SETUP_NOTES.md`.

### D2. Enable Firebase Authentication ⚠️ (console step)
Auth providers can't be fully enabled from CLI.
- [x] Firebase Console → **Authentication** → Get started.
- [x] Enable **Google** sign-in provider (matches PRD D3: member login).
- [x] Add authorized domains: `photos.mmrunners.org` (or your custom domain) and your Firebase Hosting domain.

### D3. Firebase Hosting target 🟢/🟡
Hosting config already lives in `cloud-webapp/infra/firebase.json` (rewrites `/api/**` → Cloud Run service `event-photo-api`, SPA fallback to `index.html`). You deploy it in Phase H. Nothing to create now; just confirm the file is present.
- [x] `cloud-webapp/firebase.json` exists and `.firebaserc` points at `$PROJECT_ID` (mmr-data-pipeline). *(Moved from `infra/` to `cloud-webapp/` root 2026-06-10 — the CLI requires the hosting public dir `web/dist` inside the project directory; rules paths now `infra/…`.)*

### D4. Web app config for the SPA 🟡
```bash
firebase apps:create WEB "event-photo-web" 2>/dev/null || true
firebase apps:sdkconfig WEB    # copy these values into web/ env (apiKey, authDomain, projectId…)
```
- [x] SDK config captured for the React app's Firebase init.

---

## Phase E — Core provisioning (run the bootstrap script)

### E1. Run bootstrap-gcp.sh 🟢
This creates the **deployer service account**, grants IAM, creates **Firestore (Native mode)**, creates the **Artifact Registry** repo, and configures **Workload Identity Federation** for GitHub Actions.
```bash
cd cloud-webapp
GITHUB_REPO="$GITHUB_REPO" ./infra/scripts/bootstrap-gcp.sh "$PROJECT_ID" "$REGION"
```
**Verify:**
```bash
gcloud iam service-accounts list --filter="cloud-webapp-deployer"        # SA exists
gcloud firestore databases describe --database='(default)' --format='value(type)'   # → FIRESTORE_NATIVE
gcloud artifacts repositories describe cloud-webapp --location="$REGION" --format='value(name)'
gcloud iam workload-identity-pools describe github-actions --location=global --format='value(state)'
```
- [x] Deployer SA, Firestore (native), Artifact Registry repo, and WIF pool all exist. *(verified 2026-06-09)*
- [x] The script printed `GCP_PROJECT_ID / GCP_REGION / GCP_SERVICE_ACCOUNT / GCP_WORKLOAD_IDP` — saved in `SETUP_NOTES.md` for Phase I.

### E2. Extend IAM for the new runtime SAs 🟢
Dev plan §2.3 calls for **separate least-privilege runtime service accounts** per service. Now scripted (idempotent):
```bash
./infra/scripts/provision-runtime-sas.sh "$PROJECT_ID"
```
The commands below are what the script runs, kept for reference:
```bash
for SA in api-runtime matcher-runtime indexer-runtime; do
  gcloud iam service-accounts create "$SA" \
    --display-name="Find Me $SA" 2>/dev/null || true
done
PNUM=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

# api-runtime: Firestore, Cloud SQL, Storage, Secrets, invoke matcher, publish Pub/Sub
for ROLE in roles/datastore.user roles/cloudsql.client roles/storage.objectAdmin \
            roles/secretmanager.secretAccessor roles/run.invoker roles/pubsub.publisher; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:api-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="$ROLE" --condition=None --quiet >/dev/null
done

# matcher-runtime: Cloud SQL, read uploads, secrets
for ROLE in roles/cloudsql.client roles/storage.objectViewer roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:matcher-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="$ROLE" --condition=None --quiet >/dev/null
done

# indexer-runtime: Cloud SQL, write derivatives, Firestore
for ROLE in roles/cloudsql.client roles/storage.objectAdmin roles/datastore.user; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:indexer-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="$ROLE" --condition=None --quiet >/dev/null
done
```
- [x] Three runtime SAs created with the roles above (deploy services with `--service-account` set to these, never the deployer SA). *(verified 2026-06-09)*

---

## Phase F — Data plane (buckets, eventing) — ZERO-COST DESIGN

> **Decision update (2026-06-09): Cloud SQL/pgvector is SKIPPED.** Cloud SQL has no free tier (~$50–58/mo for the planned tier). At our scale (searches are scoped to one event = a few thousand photos, PRD §5), a vector database is unnecessary: per-event embeddings live as a single flat file in Cloud Storage and the matcher does in-memory cosine similarity (NumPy, milliseconds at this scale). pgvector can be added later without changing the matcher's API if an event ever approaches ~100k photos. See `STORAGE_AND_DATABASE_OPTIONS.md` ("if budget is literally zero") and dev plan decision note.

### F1. Vector store — flat-file embeddings on Cloud Storage 🟢 ($0)
Nothing to provision. Layout (replaces dev plan §4.3 Postgres schema):
```
gs://${PROJECT_ID}-derivatives/<eventId>/embeddings/faces.npy      # float32 [N, dim]
gs://${PROJECT_ID}-derivatives/<eventId>/embeddings/persons.npy
gs://${PROJECT_ID}-derivatives/<eventId>/embeddings/manifest.json  # row→photoId/cropBox/model+version
```
- Indexer writes/rewrites these files per event; matcher lazy-loads an event's file into memory on first query and caches for the instance lifetime.
- Firestore keeps `photos` + `photo_embeddings_meta` exactly as planned (free tier: 50k reads/day — ~10× expected traffic).
- [ ] Layout agreed; dev plan §4.3 superseded.
- Cleanup from the abandoned Cloud SQL attempt (no instance was created, nothing billed): `gcloud services disable sqladmin.googleapis.com --project="$PROJECT_ID"` (optional); the `roles/cloudsql.client` grants on the runtime SAs are unused — strip or ignore.

### F2. Cloud Storage buckets 🟡 ($0 within free tier)
GCS always-free tier: 5 GB-months regional storage **in us-central1** (also us-east1/us-west1) — derivatives + embeddings for our event sizes fit comfortably. Watch egress (1 GB/mo free to most regions); the CDN/serving design in `STORAGE_AND_DATABASE_OPTIONS.md` covers this.
```bash
gcloud storage buckets create "gs://${PROJECT_ID}-derivatives" \
  --location="$REGION" --uniform-bucket-level-access
gcloud storage buckets create "gs://${PROJECT_ID}-uploads" \
  --location="$REGION" --uniform-bucket-level-access

# 7-day lifecycle on the uploads working-copy bucket (PRD §8.4):
cat > /tmp/uploads-lifecycle.json <<'JSON'
{"rule":[{"action":{"type":"Delete"},"condition":{"age":7}}]}
JSON
gcloud storage buckets update "gs://${PROJECT_ID}-uploads" --lifecycle-file=/tmp/uploads-lifecycle.json
```
**Verify:**
```bash
gcloud storage buckets describe "gs://${PROJECT_ID}-uploads" --format='value(lifecycle_config)'
```
- [x] Both buckets exist; uploads bucket has the 7-day delete rule.

### F3. Pub/Sub + Scheduler (indexing + retention) 🟡 ($0 — free tier: 10 GB/mo messages, 3 Scheduler jobs)
```bash
gcloud pubsub topics create photo-index-requests
gcloud pubsub topics create photo-index-deadletter
# Scheduled jobs are created in M1/M5 once the api endpoints exist; topics are the prerequisite.
```
- [x] Both topics created.

---

## Phase G — Drive access, secrets, reCAPTCHA

### G1. Drive read/write service account ⚠️
Indexing reads event photos from Drive; the app writes user uploads back to Drive (PRD D6). Decide the access model in dev plan task 0.4:
- [x] **Option A (recommended, CHOSEN 2026-06-10):** Workspace **domain-wide delegation** — admin grants the `indexer-runtime` SA the Drive scopes in the Workspace Admin console (Security → API controls → Domain-wide delegation), client ID = the SA's unique ID, scope = `https://www.googleapis.com/auth/drive`.
- [ ] ~~**Option B:** a dedicated Workspace user shares the event folders + the `_find_me_uploads` folder with the SA's email.~~ (not used)
- [x] Confirm the SA can list the test event folder and write to `_find_me_uploads`. *(verified 2026-06-10 via `cloud-webapp/infra/scripts/verify-g1-dwd.sh` — read + write OK)*

**Completed setup (2026-06-10):**
```bash
# SA unique ID (used as the DWD client ID):
gcloud iam service-accounts describe \
  indexer-runtime@mmr-data-pipeline.iam.gserviceaccount.com \
  --format='value(uniqueId)'
# → 106562625333715022810

# Drive API enabled on the project:
gcloud services enable drive.googleapis.com --project=mmr-data-pipeline
```
- DWD grant added in Admin console (Security → API Controls → Domain-wide Delegation), name **"MMR WebApp"**, client ID `106562625333715022810`, scope `https://www.googleapis.com/auth/drive`.
- Note: only `mmr-data-pipeline` exists as a GCP project; there is no `mmr-webapp` project.

**DWD usage notes:**
- The SA never accesses Drive as itself — every Drive API call must impersonate a Workspace user via the JWT `sub` claim (e.g. `admin@mmrunners.org`); the SA then sees that user's Drive, no folder sharing required.
- Keyless pattern (preferred, per G2): from Cloud Run as `indexer-runtime`, sign the assertion via IAM Credentials `signJwt`, then exchange it at Google's OAuth token endpoint. Requires `roles/iam.serviceAccountTokenCreator` on the SA itself.
- DWD changes can take minutes–1 hour to propagate; an immediate 403 isn't necessarily a misconfiguration.

### G2. Secret Manager (dev plan §2.2) — ($0 — free tier: 6 active secret versions)
`DB_CONNECTION` is **no longer needed** (no Cloud SQL — see Phase F).
```bash
printf '%s' "v1-2026-06" | gcloud secrets create CONSENT_POLICY_VERSION --data-file=-
# Add RECAPTCHA_KEY after G3; add DRIVE creds if using a key file (prefer WIF/DWD over keys).
```
- [x] `CONSENT_POLICY_VERSION` secret created; mounted into services later via `--set-secrets`. *(2026-06-10, value `v1-2026-06`)*

### G3. reCAPTCHA Enterprise key (PRD §9)
```bash
gcloud recaptcha keys create --display-name="findme-web" \
  --web --integration-type=SCORE --domains="photos.mmrunners.org"
gcloud recaptcha keys list   # copy the key id → store as RECAPTCHA_KEY secret + web env
```
- [x] Web key created *(2026-06-10)*: `6Ld_cxgtAAAAAGJ2nH2TvvFhP745x41RqPPHki6r`, stored as `RECAPTCHA_KEY` secret (v1 had a paste error with placeholder text — destroyed; real id in v2).
- [ ] Add the key id to the SPA config (web env) when wiring the find-me upload form.

---

## Phase H — First deploy & smoke test

### H1. Deploy the api (existing) 🟢
```bash
cd cloud-webapp
./infra/scripts/deploy-api.sh        # builds image, pushes to Artifact Registry, gcloud run deploy
```
~~Add `--service-account api-runtime@…`, `--add-cloudsql-instances ${PROJECT_ID}:${REGION}:findme-pg`, and `--set-secrets` for the secrets above (per dev plan; update the script).~~ **Done 2026-06-10:** script now sets `--service-account api-runtime@…` and `--set-secrets CONSENT_POLICY_VERSION,RECAPTCHA_KEY`; the Cloud SQL flag was stale (no Cloud SQL — Phase F) and is intentionally omitted. Usage: `./infra/scripts/deploy-api.sh "$PROJECT_ID" "$REGION"`.
**Verify:**
```bash
gcloud run services describe event-photo-api --region="$REGION" --format='value(status.url)'
curl -s "$(gcloud run services describe event-photo-api --region=$REGION --format='value(status.url)')/api/health"
```
- [x] `/api/health` returns OK. *(2026-06-10: revision `event-photo-api-00002-wdt`, URL `https://event-photo-api-emi5arbbea-uc.a.run.app`, health `{"ok":true,"version":"0.1.0","commit":"1db13d0"}`. Service requires auth (org domain-restricted sharing) — smoke test uses an identity token.)*

### H2. Deploy hosting (web) 🟢
```bash
cd cloud-webapp/web && npm ci && npm run build && cd ..
firebase deploy --only hosting --project mmr-data-pipeline   # run from cloud-webapp/ (firebase.json is there)
```
- [x] Hosting URL loads the SPA; `/api/health` works through the same origin (rewrite to Cloud Run). *(2026-06-10: `https://mmr-data-pipeline.web.app`. Hosting rewrites invoke Cloud Run anonymously, so the api needed `allUsers` `roles/run.invoker` — granted via a temporary project-level `iam.allowedPolicyMemberDomains` allowAll override, then the override was deleted (binding survives). Auth is now app-level: the api must verify Firebase ID tokens on protected routes.)*

### H3. Matcher + indexer (added during M1/M2)
Deploy with `infra/scripts/deploy-matcher.sh` / `deploy-indexer.sh` once those services exist. Matcher is **private** (no `--allow-unauthenticated`); only `api-runtime` may invoke it.
- [ ] Deferred to dev-plan M1/M2.

---

## Phase I — CI/CD wiring

### I1. GitHub repo secrets (from E1 output) ⚠️
In GitHub → Settings → Secrets and variables → Actions, add:
- [x] `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_SERVICE_ACCOUNT`, `GCP_WORKLOAD_IDP` (printed by `bootstrap-gcp.sh`). *(2026-06-10, added as repository **secrets**)*
- [x] Confirm `.github/workflows/` (`ci.yml`, `deploy-api.yml`, `deploy-web.yml`) authenticate via Workload Identity Federation — **no service-account JSON keys** in GitHub. *(2026-06-10: workflows moved to repo root, shared-build fix applied; CI deployed commit `4a81145` to both Cloud Run and Hosting, verified live on mmr-data-pipeline.web.app.)*

---

## Phase J — Cost guardrails & safety (do not skip)

### J1. Budget alert 🟡 (PRD §9, §10)
```bash
gcloud billing budgets create \
  --billing-account="XXXXXX-XXXXXX-XXXXXX" \
  --display-name="findme-monthly-cap" \
  --budget-amount=50USD \
  --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
```
- [ ] Budget with 50/90/100% alerts. With the zero-cost design the expected steady-state spend is **$0** (everything sits in free tiers), so set `--budget-amount=10USD` — any alert means something drifted out of free tier (likely Artifact Registry image storage >0.5 GB free, or GCS egress).

### J2. Cloud Run max-instances caps 🟡
Set `--max-instances=10` on api and matcher at deploy time; keep matcher `--min-instances=0` off-peak (raise to 1–2 before event weekends).
- [ ] Caps set; egress watched (Cloud Storage egress is the historic surprise — `STORAGE_AND_DATABASE_OPTIONS.md`).

### J3. Vector-store cost check ⚠️
Confirm you're on **flat-file embeddings in GCS + in-memory matching** ($0), not Cloud SQL/pgvector (~$50/mo, no free tier) and not Vertex Vector Search (a node bills 24/7; PRD §10.1).
- [x] Vector store = GCS flat files confirmed *(decision 2026-06-09)*.

---

## Master checklist (one-glance)

- [ ] **A** Tools, auth, nonprofit billing + credit
- [ ] **B** Project created, billing linked
- [ ] **C** All core + feature APIs enabled
- [x] **D** Firebase added, Google sign-in on, web SDK config captured *(2026-06-09)*
- [x] **E** `bootstrap-gcp.sh` run; deployer SA + Firestore + Artifact Registry + WIF; 3 runtime SAs *(2026-06-09)*
- [ ] **F** 2 buckets (uploads 7-day lifecycle), Pub/Sub topics — Cloud SQL skipped (zero-cost design)
- [x] **G** Drive SA access (DWD, verified), `CONSENT_POLICY_VERSION` + `RECAPTCHA_KEY` secrets, reCAPTCHA key *(2026-06-10; SPA config wiring deferred to dev)*
- [x] **H** api `/api/health` OK; hosting live (`mmr-data-pipeline.web.app`); matcher/indexer deferred to M1/M2 *(2026-06-10)*
- [x] **I** GitHub WIF secrets set; no JSON keys; CI deploys verified end-to-end *(2026-06-10)*
- [ ] **J** $50 budget alert, max-instances caps, pgvector confirmed

When every box is checked, the platform is ready for the M1 indexing build in `FACE_MATCHING_DEV_PLAN.md`.

---

## References
- `FACE_MATCHING_DEV_PLAN.md` §2 — service list this runbook provisions.
- `cloud-webapp/infra/scripts/bootstrap-gcp.sh` — the core provisioning script (Phase E).
- `cloud-webapp/infra/firebase.json` — Hosting rewrites (Phase D/H).
- `UX_AND_GCP_ASSESSMENT.md` §2.1 / `GCP_Nonprofit_Credit_Application_Guide.md` — nonprofit credit.
- `STORAGE_AND_DATABASE_OPTIONS.md` — pgvector + egress guidance.
