#!/usr/bin/env bash
#
# deploy-indexer.sh — build and deploy the photo-indexer Cloud Run Job.
#
# Mirrors deploy-matcher.sh: the ~184 MB ONNX model weights are staged in GCS
# once and pulled into the build context IN-CLOUD by Cloud Build, so they never
# travel from a laptop on every deploy. The repo-root cloud-webapp/.gcloudignore
# keeps the uploaded context to code only.
#
# Usage:
#   ./infra/scripts/deploy-indexer.sh <project-id> [region]
#
# Prereqs:
#   - Model files staged in GCS *once* (same bucket the matcher uses):
#       cd matcher && python3 scripts/fetch_models.py --dir model_files
#       (OSNet needs the one-time ONNX export — scripts/export_osnet.py)
#       gsutil mb -l <region> gs://<project-id>-models           # one time
#       gsutil -m rsync -r model_files gs://<project-id>-models/model_files
#     Override with MODELS_GCS=gs://bucket/path if staged elsewhere.
#   - indexer-runtime@ SA exists (provision-runtime-sas.sh) with DWD (runbook §G1).
#   - One-time IAM so the api can trigger the job and both SAs can sign DWD JWTs:
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

# Where the ONNX model files live in GCS (same default as deploy-matcher.sh).
# Cloud Build syncs these into the context in-cloud, so they are NOT part of the
# laptop upload (matcher/model_files/ is listed in cloud-webapp/.gcloudignore).
MODELS_GCS="${MODELS_GCS:-gs://${PROJECT_ID}-models/model_files}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Preflight: confirm the models exist in GCS, otherwise the in-cloud sync (and
# the Dockerfile's `COPY matcher/model_file[s]/`) yields an empty dir and the
# job fails to load models at runtime.
if ! gcloud storage ls "$MODELS_GCS/" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "ERROR: no model files found at $MODELS_GCS" >&2
  echo "  Stage them once (from cloud-webapp/matcher/):" >&2
  echo "    python3 scripts/fetch_models.py --dir model_files   # if not fetched yet" >&2
  echo "    gcloud storage cp -r model_files/* $MODELS_GCS/" >&2
  exit 1
fi

# Service account the in-cloud build RUNS AS. We set this explicitly instead of
# relying on Cloud Build's implicit default (which is the legacy
# <projectNumber>@cloudbuild SA on older projects, but the Compute Engine
# default SA on projects created after the 2024 Cloud Build change — a silent,
# project-dependent difference). Override with BUILD_SA=<email> if you stand up
# a dedicated, least-privilege build SA. This SA needs, on $PROJECT_ID:
#   roles/storage.objectViewer on gs://${PROJECT_ID}-models  (gsutil step)
#   roles/artifactregistry.writer                            (docker push)
#   roles/logging.logWriter + write to the logs bucket below (build logs)
# And the CALLER submitting the build (the GitHub Actions deployer SA) needs
# roles/iam.serviceAccountUser on this SA to run a build as it.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
BUILD_SA="${BUILD_SA:-${PROJECT_NUMBER}-compute@developer.gserviceaccount.com}"

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${JOB}:$(date +%Y%m%d-%H%M%S)"

echo "==> Building image $IMAGE (context: cloud-webapp/, models from $MODELS_GCS)"
echo "    build runs as: $BUILD_SA"
CLOUDBUILD_CONFIG="$(mktemp -t cloudbuild-XXXXXX.yaml)"
trap 'rm -f "$CLOUDBUILD_CONFIG"' EXIT
# Step 1 pulls the model files from GCS into matcher/model_files/ within the
# build context (in-cloud — never travels from the laptop). The indexer
# Dockerfile's `COPY matcher/model_file[s]/` then finds them. Step 2 builds.
cat > "$CLOUDBUILD_CONFIG" <<EOF
steps:
  - name: gcr.io/cloud-builders/gsutil
    args: ['-m', 'cp', '-r', '$MODELS_GCS', 'matcher/']
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-f', 'indexer/Dockerfile', '-t', '$IMAGE', '.']
images: ['$IMAGE']
EOF
gcloud builds submit "$REPO_ROOT" \
  --project="$PROJECT_ID" \
  --service-account="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}" \
  --gcs-log-dir="gs://${PROJECT_ID}_cloudbuild/logs" \
  --config="$CLOUDBUILD_CONFIG"

echo "==> Deploying Cloud Run Job $JOB"
gcloud run jobs deploy "$JOB" \
  --image="$IMAGE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --service-account="indexer-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  --memory=12Gi \
  --cpu=8 \
  --task-timeout=7200 \
  --max-retries=1 \
  --parallelism=1 \
  --set-env-vars="DERIVATIVES_ROOT=gs://${PROJECT_ID}-derivatives,DWD_SA=indexer-runtime@${PROJECT_ID}.iam.gserviceaccount.com,INDEX_CONCURRENCY=8"

echo
echo "==> Deployed. Index one event (writes photos + embeddings, updates indexState):"
echo "    gcloud run jobs execute $JOB --region=$REGION --project=$PROJECT_ID \\"
echo "      --update-env-vars=EVENT_ID=<eventId>"
echo
echo "Then watch progress on the event doc's indexState in Firestore, or:"
echo "    gcloud run jobs executions list --job=$JOB --region=$REGION --project=$PROJECT_ID"
echo
echo "Prereq reminder: the event must have a driveFolderId. Either run a"
echo "'Sync with Drive' (POST /api/admin/sync) to import it from the master Sheet,"
echo "or pass DRIVE_FOLDER_ID=<id> in --update-env-vars for a one-off."
