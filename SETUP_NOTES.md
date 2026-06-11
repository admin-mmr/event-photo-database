# Find Me — Setup Values & Progress

**Project:** mmr-data-pipeline (489676654863) · **Updated:** 2026-06-10 (Phases F–G complete)

## GitHub Actions configuration (Phase I)

Paste into GitHub repo `admin-mmr/event-photo-database` → Settings → Secrets and variables → Actions:

```
GCP_PROJECT_ID      = mmr-data-pipeline
GCP_REGION          = us-central1
GCP_SERVICE_ACCOUNT = cloud-webapp-deployer@mmr-data-pipeline.iam.gserviceaccount.com
GCP_WORKLOAD_IDP    = projects/489676654863/locations/global/workloadIdentityPools/github-actions/providers/github
```

## Runbook progress (FACE_MATCHING_SETUP_RUNBOOK.md)

- [x] **D1** Firebase added to project (`firebase projects:addfirebase` — required accepting Firebase ToS in console first; CLI 403s until then)
- [x] **D2** Firebase Authentication enabled (Google sign-in)
- [x] **D3** `cloud-webapp/infra/firebase.json` + `.firebaserc` → mmr-data-pipeline
- [x] **D4** Web app `event-photo-web` registered, SDK config captured
- [x] **E1** bootstrap-gcp.sh complete — verified: deployer SA active, Firestore NATIVE, Artifact Registry repo, WIF pool ACTIVE
- [x] **E2** Runtime SAs created via `infra/scripts/provision-runtime-sas.sh` (verified 2026-06-09)
- [x] **F** Buckets + Pub/Sub topics (verified) — **Cloud SQL SKIPPED** (zero-cost decision, see below)
- [x] **G1** Drive access via **domain-wide delegation** (2026-06-10): `indexer-runtime` SA, DWD client ID `106562625333715022810`, scope `https://www.googleapis.com/auth/drive`, Admin console entry shows as "MMR WebApp" (name comes from the project's OAuth consent screen). Drive API enabled. Verified read (event folder) + write (`_find_me_uploads`) with `cloud-webapp/infra/scripts/verify-g1-dwd.sh`. DWD calls must impersonate a Workspace user (`sub=admin@mmrunners.org`); keyless via IAM `signJwt` — needs `roles/iam.serviceAccountTokenCreator`.
- [x] **G2** `CONSENT_POLICY_VERSION` secret = `v1-2026-06`
- [x] **G3** reCAPTCHA key `6Ld_cxgtAAAAAGJ2nH2TvvFhP745x41RqPPHki6r` → `RECAPTCHA_KEY` secret (v2; v1 was a paste error, destroyed). Still to do: put key id in SPA config.
- [x] **H1** API deployed 2026-06-10: revision `event-photo-api-00002-wdt`, `https://event-photo-api-emi5arbbea-uc.a.run.app`, `/api/health` OK (`v0.1.0`, commit `1db13d0`)
- [x] **H2** Hosting live 2026-06-10: `https://mmr-data-pipeline.web.app`, `/api/health` OK through the rewrite. Required `allUsers` invoker on `event-photo-api` (Hosting rewrites are anonymous): temporary project-level DRS override → `add-iam-policy-binding --member=allUsers --role=roles/run.invoker` → override deleted (binding persists). ⚠️ API is now publicly invokable — protected routes must verify Firebase ID tokens.
- [ ] **I** GitHub Actions WIF secrets

## Decision (2026-06-09): zero-cost architecture — no Cloud SQL

Cloud SQL has no free tier (~$50–58/mo for db-custom-1-3840 Enterprise). Replaced pgvector with **flat-file embeddings in GCS** (`gs://mmr-data-pipeline-derivatives/<eventId>/embeddings/`) + in-memory cosine similarity in the matcher. Everything now targets free tiers: Firestore, GCS (5 GB regional, us-central1), Cloud Run, Pub/Sub, Secret Manager, Firebase Auth/Hosting. Expected steady-state spend: **$0** (watch Artifact Registry >0.5 GB and GCS egress). Details: runbook Phase F + dev plan decision-update banner.

⚠️ A `findme-pg` instance was briefly created on 2026-06-10 before this decision — **deleted same day** (`gcloud sql instances delete findme-pg`); cost a few cents at most. Confirm it's gone: `gcloud sql instances list`.

## Gotchas encountered

- `firebase projects:addfirebase` returned generic 403 despite Owner + firebase.admin. Cause: Firebase ToS never accepted by admin@mmrunners.org. Fix: add the project via console.firebase.google.com once.
- Org enforces `iam.allowedPolicyMemberDomains` (domain restricted sharing). `add-firebase.sh` temporarily overrides it at project level and restores on exit — reuse if IAM bindings fail with that constraint.
- No deny policies at project or org level (verified 2026-06-09 via roles/iam.denyReviewer, since removed? — remove binding when done: `gcloud organizations remove-iam-policy-binding 838436601528 --member="user:admin@mmrunners.org" --role="roles/iam.denyReviewer"`).
- ~~`firebase` CLI commands must run from `cloud-webapp/infra/`~~ **2026-06-10:** `firebase.json` + `.firebaserc` moved to `cloud-webapp/` root — the CLI errors with "outside of project directory" if the hosting public dir (`web/dist`) isn't under the dir containing firebase.json. Run firebase commands from `cloud-webapp/`. Rules files stayed in `infra/` (paths updated in firebase.json); `deploy-web.sh` + `deploy-web.yml` updated.
- Firebase CLI auth expires periodically → `firebase login --reauth`. The "no site name or target name" assertion error is a symptom of expired auth, not a config problem.
- **2026-06-10:** Workflows were in `cloud-webapp/.github/workflows/` where GitHub never registers them (404 on `gh workflow run`). Moved to repo-root `.github/workflows/` — their paths were already repo-root-relative, no content changes. Both deploy workflows support `workflow_dispatch`.
