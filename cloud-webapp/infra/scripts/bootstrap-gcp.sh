#!/usr/bin/env bash
#
# bootstrap-gcp.sh — one-time GCP setup for the cloud-webapp.
#
# Idempotent. Safe to re-run. Each step checks before creating.
#
# Usage:
#   ./infra/scripts/bootstrap-gcp.sh <project-id> [region]
#
# What it does:
#   1. Sets the active project for gcloud.
#   2. Enables required APIs (run, firestore, secretmanager, etc).
#   3. Creates the deploy service account.
#   4. Grants minimum IAM roles to that service account, plus the Cloud Build
#      roles the default compute service account needs to run `builds submit`.
#   5. Creates the Firestore database in Native mode.
#   6. Creates an Artifact Registry Docker repo for the api image.
#   7. Configures Workload Identity Federation for GitHub Actions
#      and prints the values to paste into GitHub repo secrets.
#
# Pre-reqs: you ran `gcloud auth login` with an Owner of the project.

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Usage: $0 <project-id> [region]" >&2
  exit 1
fi

# GitHub repo in owner/name form. Set via env var or hardcode here when you
# create the repo. Leave empty to skip the Workload Identity step.
GITHUB_REPO="${GITHUB_REPO:-}"

echo "==> Using project: $PROJECT_ID  region: $REGION"
gcloud config set project "$PROJECT_ID"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
echo "==> Project number: $PROJECT_NUMBER"

# ── 1. Enable APIs ───────────────────────────────────────────────────────────
echo "==> Enabling APIs (this can take a couple of minutes the first time)"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  firebase.googleapis.com \
  firebasehosting.googleapis.com \
  firebasestorage.googleapis.com \
  firebaserules.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  --quiet

# ── 2. Deploy service account ────────────────────────────────────────────────
SA_NAME="cloud-webapp-deployer"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

if ! gcloud iam service-accounts describe "$SA_EMAIL" --quiet >/dev/null 2>&1; then
  echo "==> Creating service account $SA_EMAIL"
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="Cloud Webapp Deployer (used by GitHub Actions)"
else
  echo "==> Service account $SA_EMAIL already exists"
fi

# ── 3. IAM roles for the deployer service account ───────────────────────────
echo "==> Granting IAM roles"
for ROLE in \
  roles/run.admin \
  roles/iam.serviceAccountUser \
  roles/artifactregistry.writer \
  roles/storage.admin \
  roles/firebasehosting.admin \
  roles/datastore.user \
  roles/secretmanager.secretAccessor
do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="$ROLE" \
    --condition=None \
    --quiet >/dev/null
done

# ── 3b. Cloud Build permissions for the default compute service account ──────
# `gcloud builds submit` runs as the project's default Compute Engine service
# account. On recently-created projects this account is NOT granted the build
# role automatically, so the first build fails with a 403 reading the source
# tarball from the *_cloudbuild bucket. Grant it the builder + Artifact
# Registry writer roles so deploy-api.sh works out of the box.
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
echo "==> Granting Cloud Build roles to default compute SA: $COMPUTE_SA"
for ROLE in \
  roles/cloudbuild.builds.builder \
  roles/artifactregistry.writer
do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${COMPUTE_SA}" \
    --role="$ROLE" \
    --condition=None \
    --quiet >/dev/null
done

# ── 4. Firestore (Native mode) ───────────────────────────────────────────────
if ! gcloud firestore databases describe --database='(default)' --quiet >/dev/null 2>&1; then
  echo "==> Creating Firestore database in $REGION"
  gcloud firestore databases create --location="$REGION" --type=firestore-native --quiet
else
  echo "==> Firestore database already exists"
fi

# ── 5. Artifact Registry for the api Docker image ────────────────────────────
REPO_NAME="cloud-webapp"
if ! gcloud artifacts repositories describe "$REPO_NAME" --location="$REGION" --quiet >/dev/null 2>&1; then
  echo "==> Creating Artifact Registry repo: $REPO_NAME"
  gcloud artifacts repositories create "$REPO_NAME" \
    --repository-format=docker \
    --location="$REGION" \
    --description="Container images for cloud-webapp api"
else
  echo "==> Artifact Registry repo $REPO_NAME already exists"
fi

# ── 6. Workload Identity Federation for GitHub Actions ───────────────────────
if [[ -n "$GITHUB_REPO" ]]; then
  POOL_ID="github-actions"
  PROVIDER_ID="github"

  if ! gcloud iam workload-identity-pools describe "$POOL_ID" --location=global --quiet >/dev/null 2>&1; then
    echo "==> Creating Workload Identity Pool: $POOL_ID"
    gcloud iam workload-identity-pools create "$POOL_ID" \
      --location=global \
      --display-name="GitHub Actions"
  else
    echo "==> Workload Identity Pool $POOL_ID already exists"
  fi

  if ! gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
      --workload-identity-pool="$POOL_ID" --location=global --quiet >/dev/null 2>&1; then
    echo "==> Creating Workload Identity Provider: $PROVIDER_ID"
    gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
      --workload-identity-pool="$POOL_ID" \
      --location=global \
      --issuer-uri="https://token.actions.githubusercontent.com" \
      --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
      --attribute-condition="assertion.repository=='${GITHUB_REPO}'"
  else
    echo "==> Workload Identity Provider $PROVIDER_ID already exists"
  fi

  # Allow only the configured GitHub repo to impersonate the deployer SA.
  gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${GITHUB_REPO}" \
    --quiet >/dev/null

  WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"

  echo
  echo "============================================================"
  echo "Paste these into GitHub repo Settings → Secrets and variables → Actions:"
  echo
  echo "  GCP_PROJECT_ID            = $PROJECT_ID"
  echo "  GCP_REGION                = $REGION"
  echo "  GCP_SERVICE_ACCOUNT       = $SA_EMAIL"
  echo "  GCP_WORKLOAD_IDP          = $WIF_PROVIDER"
  echo "============================================================"
else
  echo
  echo "Skipped Workload Identity Federation (no GITHUB_REPO env var set)."
  echo "Re-run with:  GITHUB_REPO=owner/name $0 $PROJECT_ID $REGION"
fi

echo
echo "==> bootstrap-gcp.sh complete"
