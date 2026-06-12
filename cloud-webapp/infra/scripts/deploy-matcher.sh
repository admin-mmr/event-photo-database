#!/usr/bin/env bash
#
# deploy-matcher.sh — build and deploy the matcher Cloud Run service (M2).
#
# Usage:
#   ./infra/scripts/deploy-matcher.sh <project-id> [region]
#
# Prereqs:
#   - Model files baked into the build context:
#       cd matcher && python3 scripts/fetch_models.py --dir model_files
#     (OSNet needs the one-time ONNX export — scripts/export_osnet.py)
#   - matcher-runtime@ SA exists (provision-runtime-sas.sh)
#   - For the api to call the matcher (one-time, after first deploy):
#       gcloud run services add-iam-policy-binding matcher --region=<region> \
#         --member="serviceAccount:api-runtime@<project>.iam.gserviceaccount.com" \
#         --role="roles/run.invoker"
#   - Then point the api at it: set repo variable MATCHER_URL (GitHub →
#     Settings → Secrets and variables → Actions → Variables) to the service
#     URL printed below and re-run deploy-api.yml (or export MATCHER_URL and
#     run deploy-api.sh).
#
# The service deploys WITHOUT --allow-unauthenticated: Cloud Run IAM verifies
# the api's ID token before requests reach the app (matcher/main.py header).

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
SERVICE="matcher"
REPO="cloud-webapp"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Usage: $0 <project-id> [region]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ ! -d "$REPO_ROOT/matcher/model_files" ]]; then
  echo "WARNING: matcher/model_files/ missing — image will fail at runtime." >&2
  echo "  cd matcher && python3 scripts/fetch_models.py --dir model_files" >&2
fi

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}:$(date +%Y%m%d-%H%M%S)"

echo "==> Building image $IMAGE (context: cloud-webapp/matcher/)"
CLOUDBUILD_CONFIG="$(mktemp -t cloudbuild-XXXXXX.yaml)"
trap 'rm -f "$CLOUDBUILD_CONFIG"' EXIT
cat > "$CLOUDBUILD_CONFIG" <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-f', 'Dockerfile', '-t', '$IMAGE', '.']
images: ['$IMAGE']
EOF
gcloud builds submit "$REPO_ROOT/matcher" \
  --project="$PROJECT_ID" \
  --gcs-log-dir="gs://${PROJECT_ID}_cloudbuild/logs" \
  --config="$CLOUDBUILD_CONFIG"

echo "==> Deploying Cloud Run service $SERVICE"
gcloud run deploy "$SERVICE" \
  --image="$IMAGE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --platform=managed \
  --service-account="matcher-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  --no-allow-unauthenticated \
  --port=8080 \
  --memory=2Gi \
  --cpu=2 \
  --max-instances=3 \
  --min-instances=0 \
  --concurrency=4 \
  --timeout=120 \
  --set-env-vars="EMBEDDINGS_ROOT=gs://${PROJECT_ID}-derivatives"
# min-instances=0 keeps steady-state cost at $0; raise to 1 before event
# weekends / demos to avoid the model-load cold start (dev plan §8).

URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')"
echo "==> Deployed:  $URL"
echo "==> Smoke test:"
curl -fsS \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "$URL/healthz" && echo
echo
echo "Next: grant api-runtime invoker (see header) and set MATCHER_URL=$URL for the api."
