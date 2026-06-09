# Upload Prep — Cloud Run Deployment Runbook

Paste-ready commands to deploy the `image-convert` service that converts non-JPG
photos in Google Drive to JPG. Run these in **your own terminal** (with `gcloud`
installed and logged in) — they can't be run from the Cowork sandbox because they
need your real Google/GCP credentials.

Source of truth: `UPLOAD_PREP_FEATURE_SPEC.md` §5–6.

---

## 0. Prerequisites

- A Google account with permission to create a GCP project.
- `gcloud` CLI installed: https://cloud.google.com/sdk/docs/install
- A billing account (Cloud Run requires billing enabled, but this workload is tiny
  and typically stays within free tier).

---

## 1. One-time project setup

```bash
# Auth (skip if already done)
gcloud auth login
gcloud auth application-default login

# Project + region
export PROJECT_ID=mmrunners-photo-prep      # must be globally unique
export REGION=us-east4                       # pairs with America/New_York
gcloud projects create "$PROJECT_ID" --name="MMRunners Photo Prep"
gcloud config set project "$PROJECT_ID"

# Link billing
gcloud billing accounts list
export BILLING_ACCOUNT_ID=XXXXXX-XXXXXX-XXXXXX
gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT_ID"

# Enable APIs
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  drive.googleapis.com \
  iamcredentials.googleapis.com
```

## 2. Runtime service account

```bash
gcloud iam service-accounts create photo-prep-runner \
  --display-name="Photo Prep Cloud Run runtime"

export RUNNER_SA="photo-prep-runner@${PROJECT_ID}.iam.gserviceaccount.com"
```

## 3. Deploy the service

```bash
cd cloud-run     # the folder containing main.py, requirements.txt, Dockerfile

gcloud run deploy image-convert \
  --source . \
  --region "$REGION" \
  --service-account "$RUNNER_SA" \
  --no-allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --timeout 300 \
  --max-instances 5 \
  --concurrency 4 \
  --set-env-vars="PYTHONUNBUFFERED=1"
```

Save the printed URL (e.g. `https://image-convert-<hash>-uc.a.run.app`) as
`CLOUD_RUN_URL` — Apps Script needs it.

## 4. Grant invoke permission to each super admin

```bash
# Repeat per super-admin email, or use a Google Group.
gcloud run services add-iam-policy-binding image-convert \
  --region "$REGION" \
  --member="user:cathy.lin@mmrunners.org" \
  --role="roles/run.invoker"

# Group alternative:
# --member="group:photo-prep-admins@mmrunners.org"
```

## 5. Smoke test the deployment

```bash
# Liveness (no auth) — should return {"ok": true, ...}
curl -s "$CLOUD_RUN_URL/healthz" \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)"
```

Then continue with the Apps Script manifest steps in spec §5.5.

---

## Supported input formats

`main.py` registers both the HEIF and AVIF openers (`register_heif_opener()` and
`register_avif_opener()`), so all formats in spec D12 are supported. Verified
locally: PNG (with transparency), TIFF, WEBP, BMP, GIF, HEIC, AVIF, and RAW
(`.dng`, `.cr2`, etc.) convert correctly. JPEGs are copied directly by Apps
Script and are intentionally rejected by `/convert`.
