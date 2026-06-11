#!/usr/bin/env bash
#
# deploy-indexer.sh — build and deploy the photo-indexer Cloud Run Job.
#
# Usage:
#   ./infra/scripts/deploy-indexer.sh <project-id> [region]
#
# Prereqs:
#   - Model files baked into the build context:
#       cd matcher && python scripts/fetch_models.py --dir model_files
#   - indexer-runtime@ SA exists (provision-runtime-sas.sh) with DWD (runbook G1)
#   - For the api to trigger the job + sign DWD JWTs (one-time):
#       gcloud run jobs add-iam-policy-binding photo-indexer --region=<region> \
#         --member="serviceAccount:api-runtime@<project>.iam.gserviceaccount.com" \
#         --role="roles/run.invoker"
#       gcloud iam service-accounts add-iam-policy-binding \
#         indexer-runtime@<project>.iam.gserviceaccount.com \
#         --member="serviceAccount:api-runtime@<project>.iam.gserviceaccount.com" \
#         --role="roles/iam.serviceAccountTokenCreator"
#       # indexer signs DWD JWTs as itself on Cloud Run:
#       gcloud iam service-accounts add-iam-policy-binding \
#         indexer-runtime@<project>.iam.gserviceaccount.com \
#         --member="serviceAccount:indexer-runtime@<project>.iam.gserviceaccount.com" \
#         --role="roles/iam.serviceAccountTokenCreator"
#
# Run an indexing execution manually:
#   gcloud run jobs execute photo-indexer --region=<region> \
#     --update-env-vars=EVENT_ID=<eventId>

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
JOB="photo-indexer"
REPO="cloud-webapp"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Usage: $0 <project-id> [region]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ ! -d "$REPO_ROOT/matcher/model_files" ]]; then
  echo "WARNING: matcher/model_files/ missing — image will fail at runtime." >&2
  echo "  cd matcher && python scripts/fetch_models.py --dir model_files" >&2
fi

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${JOB}:$(date +%Y%m%d-%H%M%S)"

echo "==> Building image $IMAGE (context: cloud-webapp/, includes matcher modules)"
CLOUDBUILD_CONFIG="$(mktemp -t cloudbuild-XXXXXX.yaml)"
trap 'rm -f "$CLOUDBUILD_CONFIG"' EXIT
cat > "$CLOUDBUILD_CONFIG" <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-f', 'indexer/Dockerfile', '-t', '$IMAGE', '.']
images: ['$IMAGE']
EOF
gcloud builds submit "$REPO_ROOT" \
  --project="$PROJECT_ID" \
  --gcs-log-dir="gs://${PROJECT_ID}_cloudbuild/logs" \
  --config="$CLOUDBUILD_CONFIG"

echo "==> Deploying Cloud Run Job $JOB"
gcloud run jobs deploy "$JOB" \
  --image="$IMAGE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --service-account="indexer-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  --memory=2Gi \
  --cpu=2 \
  --task-timeout=3600 \
  --max-retries=1 \
  --parallelism=1 \
  --set-env-vars="DERIVATIVES_ROOT=gs://${PROJECT_ID}-derivatives,DWD_SA=indexer-runtime@${PROJECT_ID}.iam.gserviceaccount.com"

echo "==> Deployed. Execute with:"
echo "    gcloud run jobs execute $JOB --region=$REGION --update-env-vars=EVENT_ID=<eventId>"
