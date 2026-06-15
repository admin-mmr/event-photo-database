#!/usr/bin/env bash
#
# deploy-matcher.sh — build and deploy the matcher Cloud Run service (M2).
#
# Usage:
#   ./infra/scripts/deploy-matcher.sh <project-id> [region]
#
# Prereqs:
#   - Model files (~184 MB) staged in GCS *once*, so they don't have to be
#     re-uploaded from your laptop on every deploy. Cloud Build pulls them
#     in-cloud during the build (fast, same-region, free egress):
#       cd matcher && python3 scripts/fetch_models.py --dir model_files
#       (OSNet needs the one-time ONNX export — scripts/export_osnet.py)
#       gsutil mb -l <region> gs://<project-id>-models           # one time
#       gsutil -m rsync -r model_files gs://<project-id>-models/model_files
#     Override the location with MODELS_GCS=gs://bucket/path if you stage
#     them elsewhere. Re-run the rsync only when the model files change.
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

# Where the ONNX model files live in GCS. Cloud Build syncs these into the
# build context in-cloud, so they are NOT part of the laptop upload (which
# stays at ~1 MB of code). model_files/ is therefore listed in
# matcher/.gcloudignore. Override with MODELS_GCS=gs://bucket/path if needed.
MODELS_GCS="${MODELS_GCS:-gs://${PROJECT_ID}-models/model_files}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Preflight: confirm the models exist in GCS, otherwise the in-cloud sync
# (and the COPY model_files/ build step) will produce an empty dir and the
# container fails to load models at runtime.
if ! gcloud storage ls "$MODELS_GCS/" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "ERROR: no model files found at $MODELS_GCS" >&2
  echo "  Stage them once (from cloud-webapp/matcher/):" >&2
  echo "    python3 scripts/fetch_models.py --dir model_files   # if not fetched yet" >&2
  echo "    gcloud storage cp -r model_files/* $MODELS_GCS/" >&2
  exit 1
fi

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}:$(date +%Y%m%d-%H%M%S)"

echo "==> Building image $IMAGE (context: cloud-webapp/matcher/, models from $MODELS_GCS)"
CLOUDBUILD_CONFIG="$(mktemp -t cloudbuild-XXXXXX.yaml)"
trap 'rm -f "$CLOUDBUILD_CONFIG"' EXIT
# Step 1 pulls the model files from GCS into the build context (in-cloud, so
# they never travel from the laptop). We use `cp -r` rather than `rsync`
# because the local model_files/ dir is excluded from the upload and does not
# exist yet — cp creates it, rsync would error on a missing destination.
# Step 2 builds; the Dockerfile's `COPY model_files/` then finds them.
cat > "$CLOUDBUILD_CONFIG" <<EOF
steps:
  - name: gcr.io/cloud-builders/gsutil
    args: ['-m', 'cp', '-r', '$MODELS_GCS', '.']
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
READY="$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" \
  --format='value(status.conditions.filter("type:Ready").extract(status).flatten())' 2>/dev/null || echo '?')"
echo
echo "==> Deployed:  $URL   (Ready=$READY)"
echo
# The service is private (--no-allow-unauthenticated), so a plain curl returns
# a Google Front End 404 *by design* — that is NOT a failure and does not mean
# /healthz is missing. The real health signal is Ready=True above. A user
# account can't mint a service-URL-scoped token (gcloud's --audiences requires
# a service account), so to smoke-test /healthz yourself use the authed proxy:
echo "Smoke test (optional): the matcher is private, so curl it through an authed proxy —"
echo "    gcloud run services proxy $SERVICE --region=$REGION --project=$PROJECT_ID"
echo "    # then in another terminal:  curl http://localhost:8080/healthz"
echo
echo "Next steps:"
echo "  1. Grant the api permission to call the matcher (one-time):"
echo "       gcloud run services add-iam-policy-binding $SERVICE --region=$REGION \\"
echo "         --member=\"serviceAccount:api-runtime@${PROJECT_ID}.iam.gserviceaccount.com\" \\"
echo "         --role=\"roles/run.invoker\""
echo "  2. Set GitHub repo variable MATCHER_URL=$URL"
echo "     (Settings -> Secrets and variables -> Actions -> Variables), then re-run deploy-api."
