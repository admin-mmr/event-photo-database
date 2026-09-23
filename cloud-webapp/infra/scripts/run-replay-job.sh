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
#   ./infra/scripts/run-replay-job.sh <project-id> <event-id>[,<event-id>…] [region]
#
# Several comma-separated events share ONE image build and run as sequential
# executions of the same job; a failed event is reported and the rest still run.
#
# Pick events whose voters still HAVE a selfie: the uploads bucket deletes
# objects 90 days after upload, so an event searched months ago has lost most of
# its queries. run_eval refuses to report (exit 2) below 50% query coverage.
#
# Env overrides:
#   EVAL_ARGS      run_eval.py analyses after --judged-only (default "--tnorm --prf"),
#                  e.g. "--tnorm --anchor-promotion --face-quality-weight 0.25;0.5;1.0"
#   REPORT_GCS     gs:// path to save the JSON report (optional; with several
#                  events each gets <path-without-.json>-<event-id-prefix>.json)
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
EVENT_LIST="${2:-}"
REGION="${3:-us-central1}"
REPO="cloud-webapp"
JOB="${JOB:-findme-replay-tune}"

if [[ -z "$PROJECT_ID" || -z "$EVENT_LIST" ]]; then
  echo "Usage: $0 <project-id> <event-id>[,<event-id>…] [region]" >&2
  exit 1
fi
IFS=',' read -r -a EVENT_IDS <<< "$EVENT_LIST"

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

# '^##^' switches gcloud's env-var separator from ',' to '##', so EVAL_ARGS may
# hold commas (e.g. --face-quality-weight 0.25,0.5).
BASE_ENV="^##^PROJECT=${PROJECT_ID}##DERIVATIVES=gs://${PROJECT_ID}-derivatives##UPLOADS_BUCKET=${PROJECT_ID}-uploads##K=${K:-20}##REFS_PER_USER=${REFS_PER_USER:-1}##EVAL_ARGS=${EVAL_ARGS:---tnorm --prf}"

echo "==> Deploying job $JOB"
gcloud run jobs deploy "$JOB" \
  --image="$IMAGE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --service-account="api-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  --cpu=4 \
  --memory=8Gi \
  --max-retries=0 \
  --task-timeout=3600 \
  --set-env-vars="${BASE_ENV}##EVENT_ID=${EVENT_IDS[0]}"

FAILED=()
for EVENT_ID in "${EVENT_IDS[@]}"; do
  RUN_ENV="^##^EVENT_ID=${EVENT_ID}##REPORT_GCS="
  if [[ -n "${REPORT_GCS:-}" ]]; then
    if (( ${#EVENT_IDS[@]} > 1 )); then
      RUN_ENV="^##^EVENT_ID=${EVENT_ID}##REPORT_GCS=${REPORT_GCS%.json}-${EVENT_ID:0:8}.json"
    else
      RUN_ENV="^##^EVENT_ID=${EVENT_ID}##REPORT_GCS=${REPORT_GCS}"
    fi
  fi
  echo "==> Replaying $EVENT_ID"
  if ! gcloud run jobs execute "$JOB" \
      --region="$REGION" \
      --project="$PROJECT_ID" \
      --update-env-vars="$RUN_ENV" \
      --wait; then
    FAILED+=("$EVENT_ID")
  fi
done

echo
echo "==> Replay finished. Read each sweep from its execution's logs:"
echo "    gcloud run jobs executions list --job=$JOB --region=$REGION --project=$PROJECT_ID --limit=${#EVENT_IDS[@]}"
echo "    gcloud logging read 'resource.type=\"cloud_run_job\" AND labels.\"run.googleapis.com/execution_name\"=\"<execution>\"' \\"
echo "      --project=$PROJECT_ID --limit=500 --freshness=3h --order=asc --format='value(textPayload)'"
[[ -n "${REPORT_GCS:-}" ]] && echo "    report JSON: $REPORT_GCS"
echo
echo "T-norm is already live (MATCHER_NORM_THRESHOLD default in matcher/main.py). The operating-point table scores it at"
echo "each fusion weight. A change is a human decision, checked on more than one event."
if (( ${#FAILED[@]} )); then
  echo "!! ${#FAILED[@]} replay(s) failed: ${FAILED[*]} — an exit 2 from run_eval means too few voters still have a selfie." >&2
  exit 1
fi
