#!/usr/bin/env bash
#
# run-replay-job.sh — build + run the one-off T-norm/PRF replay as a Cloud Run
# JOB (FACE_RECOGNITION_IMPROVEMENT_ANALYSIS §1.2/§1.3).
#
# Why a job: the replay must embed each judged searcher's reference selfie with
# the ONNX models. Running it in-cloud on the matcher-family image (models
# baked in) keeps the biometric selfies inside an ephemeral container — they
# never touch a laptop (PRD §8). Jobs also scale to zero: this costs money only
# while the single run executes, then nothing (CLAUDE.md zero-idle policy).
#
# Usage:
#   ./infra/scripts/run-replay-job.sh <project-id> <event-id> [region]
#
# Env overrides:
#   REPORT_GCS     gs:// path to save the JSON report (optional)
#   K              P@K (default 20)
#   REFS_PER_USER  selfies folded per searcher (default 1)
#   MODELS_GCS     model-weights location (default gs://<project>-models/model_files)
#   JOB            job name (default findme-replay-tune)
#
# Prereqs:
#   - Models staged in GCS (same as deploy-matcher.sh).
#   - api-runtime@ SA can read Firestore (match_feedback / find_me_uploads),
#     the uploads bucket (reference selfies) and the derivatives bucket
#     (event vectors). The api runtime already reads all three in prod.
set -euo pipefail

PROJECT_ID="${1:-}"
EVENT_ID="${2:-}"
REGION="${3:-us-central1}"
REPO="cloud-webapp"
JOB="${JOB:-findme-replay-tune}"

if [[ -z "$PROJECT_ID" || -z "$EVENT_ID" ]]; then
  echo "Usage: $0 <project-id> <event-id> [region]" >&2
  exit 1
fi

MODELS_GCS="${MODELS_GCS:-gs://${PROJECT_ID}-models/model_files}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if ! gcloud storage ls "$MODELS_GCS/" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "ERROR: no model files at $MODELS_GCS (stage them as in deploy-matcher.sh)" >&2
  exit 1
fi

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/findme-replay:$(date +%Y%m%d-%H%M%S)"

echo "==> Building replay image $IMAGE (context: cloud-webapp/matcher/, models from $MODELS_GCS)"
CLOUDBUILD_CONFIG="$(mktemp -t cloudbuild-replay-XXXXXX.yaml)"
trap 'rm -f "$CLOUDBUILD_CONFIG"' EXIT
cat > "$CLOUDBUILD_CONFIG" <<EOF
steps:
  - name: gcr.io/cloud-builders/gsutil
    args: ['-m', 'cp', '-r', '$MODELS_GCS', '.']
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-f', 'eval/Dockerfile.replay', '-t', '$IMAGE', '.']
images: ['$IMAGE']
EOF
gcloud builds submit "$REPO_ROOT/matcher" \
  --project="$PROJECT_ID" \
  --gcs-log-dir="gs://${PROJECT_ID}_cloudbuild/logs" \
  --config="$CLOUDBUILD_CONFIG"

ENV_VARS="PROJECT=${PROJECT_ID},EVENT_ID=${EVENT_ID},DERIVATIVES=gs://${PROJECT_ID}-derivatives,UPLOADS_BUCKET=${PROJECT_ID}-uploads,K=${K:-20},REFS_PER_USER=${REFS_PER_USER:-1}"
if [[ -n "${REPORT_GCS:-}" ]]; then
  ENV_VARS="${ENV_VARS},REPORT_GCS=${REPORT_GCS}"
fi

echo "==> Deploying + running job $JOB"
gcloud run jobs deploy "$JOB" \
  --image="$IMAGE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --service-account="api-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  --cpu=4 \
  --memory=8Gi \
  --max-retries=0 \
  --task-timeout=3600 \
  --set-env-vars="$ENV_VARS" \
  --execute-now --wait

echo
echo "==> Replay finished. Read the sweep from the execution logs:"
echo "    gcloud run jobs executions list --job=$JOB --region=$REGION --project=$PROJECT_ID --limit=1"
echo "    gcloud logging read 'resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$JOB\"' \\"
echo "      --project=$PROJECT_ID --limit=200 --freshness=1h --format='value(textPayload)'"
[[ -n "${REPORT_GCS:-}" ]] && echo "    report JSON: $REPORT_GCS"
echo
echo "Pick MATCHER_NORM_THRESHOLD from the tnorm sweep row that beats P@20=0.684 with the most recall,"
echo "then set FINDME_TNORM=1 + MATCHER_NORM_THRESHOLD on the api/matcher."
