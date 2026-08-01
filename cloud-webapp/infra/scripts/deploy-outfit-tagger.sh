#!/usr/bin/env bash
#
# deploy-outfit-tagger.sh — build and deploy the outfit-tagger service + its
# prepare job. Both come from ONE image (cloud-webapp/outfit-tagger/Dockerfile);
# the job just overrides the command to `python job.py`.
#
# Usage:
#   ./infra/scripts/deploy-outfit-tagger.sh <project-id> [region]
#
# This is a SEPARATE deployable from the matcher on purpose: its own service, its
# own URL, its own build context, its own vector store under <eventId>/outfit/.
# Deploying or rolling it back cannot affect a Find-Me search.
#
# Prereqs:
#   - Model files staged in GCS *once*, so they aren't re-uploaded from your
#     laptop on every deploy (Cloud Build pulls them in-cloud, same region):
#       cd outfit-tagger
#       python3 scripts/export_siglip.py --dir model_files
#       gcloud storage cp -r model_files gs://<project-id>-models/outfit/
#     Override the location with MODELS_GCS=gs://bucket/path.
#     NOTE: export_siglip.py verifies tokenizer + graph-shape + embedding parity
#     before it writes anything usable — do not hand-assemble this directory.
#     NOTE: the .onnx files are NOT self-contained — torch writes the weights to
#     sibling siglip_*.onnx.data files (~780 MB total) that onnxruntime resolves
#     by relative path. Copy model_files/ WHOLE; a `cp *.onnx` yields a runtime
#     load error, and the `cp -r` below is what keeps them together.
#   - outfit-runtime@ SA exists. It needs objectViewer on the derivatives bucket
#     for the service (read-only) and objectAdmin for the job (it writes
#     <eventId>/outfit/). Create it if this is the first deploy:
#       gcloud iam service-accounts create outfit-runtime --project=<project-id>
#       gcloud storage buckets add-iam-policy-binding gs://<project-id>-derivatives \
#         --member="serviceAccount:outfit-runtime@<project-id>.iam.gserviceaccount.com" \
#         --role=roles/storage.objectAdmin
#   - For the api to call the service (one-time, after the first deploy):
#       gcloud run services add-iam-policy-binding outfit-tagger --region=<region> \
#         --member="serviceAccount:api-runtime@<project>.iam.gserviceaccount.com" \
#         --role="roles/run.invoker"
#   - Then point the api at it: set repo variable OUTFIT_URL (GitHub → Settings →
#     Secrets and variables → Actions → Variables) to the URL printed below and
#     re-run deploy-api.yml (or export OUTFIT_URL and run deploy-api.sh).
#     Until OUTFIT_URL is set the api's /admin/outfit routes 503 with a clear
#     message and nothing else changes.
#
# The service deploys WITHOUT --allow-unauthenticated: Cloud Run IAM verifies the
# api's ID token before requests reach the app, same as the matcher.

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
SERVICE="outfit-tagger"
JOB="outfit-prepare"
REPO="cloud-webapp"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Usage: $0 <project-id> [region]" >&2
  exit 1
fi

# The LAST PATH SEGMENT MUST BE `model_files`. The Cloud Build step below does
# `gsutil cp -r $MODELS_GCS .`, which creates a directory named after that
# segment — and the Dockerfile then does `COPY model_files/`. Point this at
# `.../outfit_model_files` and the build context gets `./outfit_model_files/`
# while COPY looks for `./model_files/`, failing the build. Hence the `outfit/`
# prefix rather than a renamed leaf.
MODELS_GCS="${MODELS_GCS:-gs://${PROJECT_ID}-models/outfit/model_files}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Preflight: without the weights in the build context the `COPY model_files/`
# produces an empty dir and the container fails to load models at RUNTIME — long
# after the deploy reports success.
if ! gcloud storage ls "$MODELS_GCS/" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "ERROR: no model files found at $MODELS_GCS" >&2
  echo "  Stage them once (from cloud-webapp/outfit-tagger/):" >&2
  echo "    python3 scripts/export_siglip.py --dir model_files" >&2
  echo "    gcloud storage cp -r model_files $(dirname "$MODELS_GCS")/" >&2
  exit 1
fi

# Preflight: the runtime SA must exist and be able to read the derivatives bucket
# (service) and write <eventId>/outfit/ (job). Checked rather than created, so a
# deploy never silently mints identities or grants storage access.
SA="outfit-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "ERROR: service account $SA does not exist." >&2
  echo "  Create it and grant bucket access (one time):" >&2
  echo "    gcloud iam service-accounts create outfit-runtime --project=$PROJECT_ID \\" >&2
  echo "      --display-name='outfit-tagger runtime'" >&2
  echo "    gcloud storage buckets add-iam-policy-binding gs://${PROJECT_ID}-derivatives \\" >&2
  echo "      --member=\"serviceAccount:$SA\" --role=roles/storage.objectAdmin" >&2
  exit 1
fi

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}:$(date +%Y%m%d-%H%M%S)"

echo "==> Building image $IMAGE (context: cloud-webapp/outfit-tagger/, models from $MODELS_GCS)"
CLOUDBUILD_CONFIG="$(mktemp -t cloudbuild-XXXXXX.yaml)"
trap 'rm -f "$CLOUDBUILD_CONFIG"' EXIT
# Step 1 pulls the weights into the build context in-cloud (they are excluded
# from the laptop upload by .gcloudignore); step 2 builds. `cp -r` rather than
# rsync because the local model_files/ dir does not exist in the uploaded
# context — cp creates it, rsync errors on a missing destination.
cat > "$CLOUDBUILD_CONFIG" <<EOF
steps:
  - name: gcr.io/cloud-builders/gsutil
    args: ['-m', 'cp', '-r', '$MODELS_GCS', '.']
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-f', 'Dockerfile', '-t', '$IMAGE', '.']
images: ['$IMAGE']
EOF
gcloud builds submit "$REPO_ROOT/outfit-tagger" \
  --project="$PROJECT_ID" \
  --gcs-log-dir="gs://${PROJECT_ID}_cloudbuild/logs" \
  --config="$CLOUDBUILD_CONFIG"

echo "==> Deploying Cloud Run service $SERVICE"
# min-instances=0 per the zero-idle-cost policy in CLAUDE.md: this service is
# used interactively by an admin, in bursts, so a warm instance would bill memory
# + CPU around the clock for nothing. The tradeoff is a cold start (~model load)
# on the first query after idle.
gcloud run deploy "$SERVICE" \
  --image="$IMAGE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --platform=managed \
  --service-account="outfit-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  --no-allow-unauthenticated \
  --port=8080 \
  --memory=2Gi \
  --cpu=2 \
  --max-instances=3 \
  --min-instances=0 \
  --concurrency=4 \
  --timeout=120 \
  --set-env-vars="EMBEDDINGS_ROOT=gs://${PROJECT_ID}-derivatives"

echo "==> Deploying Cloud Run Job $JOB (same image, command → job.py)"
# A JOB, not an endpoint: a full-event prepare is minutes of CPU-ONNX work and
# cannot fit the 60s Hosting / Cloud Run request ceiling (CLAUDE.md has three
# scars from exactly this). Memory is the binding constraint, not CPU — each
# in-flight photo holds a decoded full-resolution array (~72 MB for 24 MP), so
# 4Gi at OUTFIT_CONCURRENCY=4 leaves headroom.
gcloud run jobs deploy "$JOB" \
  --image="$IMAGE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --service-account="outfit-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  --command="python" \
  --args="job.py" \
  --memory=4Gi \
  --cpu=4 \
  --task-timeout=7200 \
  --max-retries=1 \
  --parallelism=1 \
  --set-env-vars="DERIVATIVES_ROOT=gs://${PROJECT_ID}-derivatives,OUTFIT_CONCURRENCY=4"

URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')"
READY="$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" \
  --format='value(status.conditions.filter("type:Ready").extract(status).flatten())' 2>/dev/null || echo '?')"
echo
echo "==> Deployed:  $URL   (Ready=$READY)"
echo
# The service is private, so a plain curl returns a Google Front End 404 BY
# DESIGN — that is not a failure and does not mean /healthz is missing. The real
# health signal is Ready=True above.
echo "Smoke test (optional): the service is private, so curl it through an authed proxy —"
echo "    gcloud run services proxy $SERVICE --region=$REGION --project=$PROJECT_ID"
echo "    # then in another terminal:  curl http://localhost:8080/healthz"
echo
echo "Next steps:"
echo "  1. Prepare an event (one execution per event; re-runs are idempotent):"
echo "       gcloud run jobs execute $JOB --region=$REGION --project=$PROJECT_ID \\"
echo "         --update-env-vars=EVENT_ID=<eventId>"
echo "     Add FORCE=1 to re-embed an already-prepared event."
echo "  2. Grant the api permission to call the service (one-time):"
echo "       gcloud run services add-iam-policy-binding $SERVICE --region=$REGION \\"
echo "         --member=\"serviceAccount:api-runtime@${PROJECT_ID}.iam.gserviceaccount.com\" \\"
echo "         --role=\"roles/run.invoker\""
echo "  3. Set GitHub repo variable OUTFIT_URL=$URL, then re-run deploy-api."
