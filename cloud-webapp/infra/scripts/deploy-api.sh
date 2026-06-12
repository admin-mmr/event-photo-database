#!/usr/bin/env bash
#
# deploy-api.sh — build and deploy the api to Cloud Run.
#
# Usage:
#   ./infra/scripts/deploy-api.sh <project-id> [region]
#
# This is the manual fallback. CI/CD does the same thing on push to main.

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
SERVICE="event-photo-api"
REPO="cloud-webapp"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Usage: $0 <project-id> [region]" >&2
  exit 1
fi

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}:$(date +%Y%m%d-%H%M%S)"

# Build context is the repo root (one level up from infra/), so the Dockerfile
# can copy the shared/ workspace too.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "==> Building image $IMAGE"
CLOUDBUILD_CONFIG="$(mktemp -t cloudbuild-XXXXXX.yaml)"
trap 'rm -f "$CLOUDBUILD_CONFIG"' EXIT
cat > "$CLOUDBUILD_CONFIG" <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-f', 'api/Dockerfile', '-t', '$IMAGE', '.']
images: ['$IMAGE']
EOF
gcloud builds submit "$REPO_ROOT" \
  --project="$PROJECT_ID" \
  --gcs-log-dir="gs://${PROJECT_ID}_cloudbuild/logs" \
  --config="$CLOUDBUILD_CONFIG"

echo "==> Deploying revision to Cloud Run service $SERVICE"
gcloud run deploy "$SERVICE" \
  --image="$IMAGE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --platform=managed \
  --service-account="api-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  --no-allow-unauthenticated \
  --port=8080 \
  --memory=512Mi \
  --cpu=1 \
  --max-instances=10 \
  --min-instances=0 \
  --concurrency=80 \
  --timeout=60 \
  --set-env-vars="NODE_ENV=production,GCP_PROJECT_ID=${PROJECT_ID},FIREBASE_PROJECT_ID=${PROJECT_ID},GIT_COMMIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown),MATCHER_URL=${MATCHER_URL:-}" \
  --set-secrets="CONSENT_POLICY_VERSION=CONSENT_POLICY_VERSION:latest,RECAPTCHA_KEY=RECAPTCHA_KEY:latest"
# Note: no --add-cloudsql-instances — Cloud SQL was dropped (zero-cost design, runbook Phase F).
# Runtime SA is api-runtime (least privilege), never the deployer SA (runbook E2).

URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')"
echo "==> Deployed:  $URL"
echo "==> Smoke test:"
# The org's Domain Restricted Sharing policy blocks public (allUsers) access,
# so the service requires authentication. Send a Google-signed identity token
# for the active gcloud account (which must hold roles/run.invoker).
curl -fsS \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "$URL/api/health" && echo
