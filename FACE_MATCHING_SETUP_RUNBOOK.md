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
- [ ] All five tools present. Missing gcloud → install Google Cloud CLI; missing firebase → `npm i -g firebase-tools`.

### A2. Authenticate as a project Owner 🟡
```bash
gcloud auth login
gcloud auth application-default login
firebase login
```
- [ ] `gcloud auth list` shows your account as ACTIVE.

### A3. Nonprofit billing + $10k credit ⚠️
The credit is **separate** from Workspace for Nonprofits (see `UX_AND_GCP_ASSESSMENT.md` §2.1 and `GCP_Nonprofit_Credit_Application_Guide.md`).
- [ ] Org verified via Goodstack/TechSoup.
- [ ] Cloud credit requested at the Google for Nonprofits Cloud credit page.
- [ ] A **Billing Account** exists and you can link projects to it.

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
- [ ] Project exists and `billingEnabled = True`.

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
- [ ] All core + feature APIs appear in the output.

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
- [x] `cloud-webapp/infra/firebase.json` exists and `.firebaserc` points at `$PROJECT_ID` (mmr-data-pipeline).

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

## Phase F — Data plane (Cloud SQL + pgvector, buckets, eventing)

> These will live in `infra/scripts/provision-data-plane.sh` (dev plan §2.4). Until that script lands, run the inline commands. 🟡

### F1. Cloud SQL Postgres + pgvector
```bash
gcloud sql instances create findme-pg \
  --database-version=POSTGRES_16 \
  --tier=db-custom-1-3840 \
  --region="$REGION" \
  --storage-auto-increase \
  --backup --enable-point-in-time-recovery

gcloud sql databases create findme --instance=findme-pg
gcloud sql users set-password postgres --instance=findme-pg --password="$(openssl rand -base64 24)"
# Enable extension + schema (or paste infra/sql/0001_init.sql into Cloud SQL Studio):
#   CREATE EXTENSION IF NOT EXISTS vector;   (then the embeddings table from dev plan §4.3)
```
**Verify:**
```bash
gcloud sql instances describe findme-pg --format='value(state)'   # → RUNNABLE
```
- [ ] Instance RUNNABLE; `vector` extension + `embeddings` table created (dev plan §4.3).
- ⚠️ Use a dedicated tier (not shared-core `db-f1-micro`) for prod — shared-core has no SLA (`STORAGE_AND_DATABASE_OPTIONS.md`).

### F2. Cloud Storage buckets
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
gcloud storage buckets describe "gs://${PROJECT_ID}-uploads" --format='value(lifecycle)'
```
- [ ] Both buckets exist; uploads bucket has the 7-day delete rule.

### F3. Pub/Sub + Scheduler (indexing + retention)
```bash
gcloud pubsub topics create photo-index-requests
gcloud pubsub topics create photo-index-deadletter
# Scheduled jobs are created in M1/M5 once the api endpoints exist; topics are the prerequisite.
```
- [ ] Both topics created.

---

## Phase G — Drive access, secrets, reCAPTCHA

### G1. Drive read/write service account ⚠️
Indexing reads event photos from Drive; the app writes user uploads back to Drive (PRD D6). Decide the access model in dev plan task 0.4:
- [ ] **Option A (recommended):** Workspace **domain-wide delegation** — admin grants the `indexer-runtime` SA the Drive scopes in the Workspace Admin console (Security → API controls → Domain-wide delegation), client ID = the SA's unique ID, scope = `https://www.googleapis.com/auth/drive`.
- [ ] **Option B:** a dedicated Workspace user shares the event folders + the `_find_me_uploads` folder with the SA's email.
- [ ] Confirm the SA can list the test event folder and write to `_find_me_uploads`.

### G2. Secret Manager (dev plan §2.2)
```bash
printf '%s' "postgres://USER:PASS@/findme?host=/cloudsql/${PROJECT_ID}:${REGION}:findme-pg" \
  | gcloud secrets create DB_CONNECTION --data-file=-
printf '%s' "v1-2026-06" | gcloud secrets create CONSENT_POLICY_VERSION --data-file=-
# Add RECAPTCHA_KEY after G3; add DRIVE creds if using a key file (prefer WIF/DWD over keys).
```
- [ ] `DB_CONNECTION` and `CONSENT_POLICY_VERSION` secrets created; mounted into services later via `--set-secrets`.

### G3. reCAPTCHA Enterprise key (PRD §9)
```bash
gcloud recaptcha keys create --display-name="findme-web" \
  --web --integration-type=SCORE --domains="photos.mmrunners.org"
gcloud recaptcha keys list   # copy the key id → store as RECAPTCHA_KEY secret + web env
```
- [ ] Web key created; id stored in Secret Manager and the SPA config.

---

## Phase H — First deploy & smoke test

### H1. Deploy the api (existing) 🟢
```bash
cd cloud-webapp
./infra/scripts/deploy-api.sh        # builds image, pushes to Artifact Registry, gcloud run deploy
```
Add `--service-account api-runtime@…`, `--add-cloudsql-instances ${PROJECT_ID}:${REGION}:findme-pg`, and `--set-secrets` for the secrets above (per dev plan; update the script).
**Verify:**
```bash
gcloud run services describe event-photo-api --region="$REGION" --format='value(status.url)'
curl -s "$(gcloud run services describe event-photo-api --region=$REGION --format='value(status.url)')/api/health"
```
- [ ] `/api/health` returns OK.

### H2. Deploy hosting (web) 🟢
```bash
cd cloud-webapp/web && npm ci && npm run build && cd ..
firebase deploy --only hosting     # uses infra/firebase.json
```
- [ ] Hosting URL loads the SPA; `/api/health` works through the same origin (rewrite to Cloud Run).

### H3. Matcher + indexer (added during M1/M2)
Deploy with `infra/scripts/deploy-matcher.sh` / `deploy-indexer.sh` once those services exist. Matcher is **private** (no `--allow-unauthenticated`); only `api-runtime` may invoke it.
- [ ] Deferred to dev-plan M1/M2.

---

## Phase I — CI/CD wiring

### I1. GitHub repo secrets (from E1 output) ⚠️
In GitHub → Settings → Secrets and variables → Actions, add:
- [ ] `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_SERVICE_ACCOUNT`, `GCP_WORKLOAD_IDP` (printed by `bootstrap-gcp.sh`).
- [ ] Confirm `.github/workflows/` (`ci.yml`, `deploy-api.yml`, `deploy-web.yml`) authenticate via Workload Identity Federation — **no service-account JSON keys** in GitHub.

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
- [ ] $50/mo budget with 50/90/100% alerts.

### J2. Cloud Run max-instances caps 🟡
Set `--max-instances=10` on api and matcher at deploy time; keep matcher `--min-instances=0` off-peak (raise to 1–2 before event weekends).
- [ ] Caps set; egress watched (Cloud Storage egress is the historic surprise — `STORAGE_AND_DATABASE_OPTIONS.md`).

### J3. Vector-store cost check ⚠️
Confirm you're on **Cloud SQL + pgvector**, not Vertex Vector Search (PRD §10.1: a Vertex node bills 24/7 and eats ~30–40% of the monthly credit; pgvector is ~$7–15/mo).
- [ ] Vector store = pgvector confirmed.

---

## Master checklist (one-glance)

- [ ] **A** Tools, auth, nonprofit billing + credit
- [ ] **B** Project created, billing linked
- [ ] **C** All core + feature APIs enabled
- [x] **D** Firebase added, Google sign-in on, web SDK config captured *(2026-06-09)*
- [x] **E** `bootstrap-gcp.sh` run; deployer SA + Firestore + Artifact Registry + WIF; 3 runtime SAs *(2026-06-09)*
- [ ] **F** Cloud SQL+pgvector, 2 buckets (uploads 7-day lifecycle), Pub/Sub topics
- [ ] **G** Drive SA access, Secret Manager secrets, reCAPTCHA key
- [ ] **H** api `/api/health` OK; hosting live; matcher/indexer deferred to M1/M2
- [ ] **I** GitHub WIF secrets set; no JSON keys
- [ ] **J** $50 budget alert, max-instances caps, pgvector confirmed

When every box is checked, the platform is ready for the M1 indexing build in `FACE_MATCHING_DEV_PLAN.md`.

---

## References
- `FACE_MATCHING_DEV_PLAN.md` §2 — service list this runbook provisions.
- `cloud-webapp/infra/scripts/bootstrap-gcp.sh` — the core provisioning script (Phase E).
- `cloud-webapp/infra/firebase.json` — Hosting rewrites (Phase D/H).
- `UX_AND_GCP_ASSESSMENT.md` §2.1 / `GCP_Nonprofit_Credit_Application_Guide.md` — nonprofit credit.
- `STORAGE_AND_DATABASE_OPTIONS.md` — pgvector + egress guidance.
