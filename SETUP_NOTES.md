# Find Me — Setup Values & Progress

**Project:** mmr-data-pipeline (489676654863) · **Updated:** 2026-06-09 (Phase E complete)

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
- [ ] **E2** Runtime SAs (api-runtime, matcher-runtime, indexer-runtime)
- [ ] **F** Cloud SQL + pgvector, buckets, Pub/Sub
- [ ] **G** Drive access, secrets, reCAPTCHA
- [ ] **H/I** Deploy + GitHub Actions

## Gotchas encountered

- `firebase projects:addfirebase` returned generic 403 despite Owner + firebase.admin. Cause: Firebase ToS never accepted by admin@mmrunners.org. Fix: add the project via console.firebase.google.com once.
- Org enforces `iam.allowedPolicyMemberDomains` (domain restricted sharing). `add-firebase.sh` temporarily overrides it at project level and restores on exit — reuse if IAM bindings fail with that constraint.
- No deny policies at project or org level (verified 2026-06-09 via roles/iam.denyReviewer, since removed? — remove binding when done: `gcloud organizations remove-iam-policy-binding 838436601528 --member="user:admin@mmrunners.org" --role="roles/iam.denyReviewer"`).
- `firebase` CLI commands must run from `cloud-webapp/infra/` (where firebase.json lives) or use `--project mmr-data-pipeline`.
