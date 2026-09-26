#!/usr/bin/env bash
#
# deploy-calibration-job.sh — build and deploy the `findme-calibration` Cloud Run
# job (quality plan Item 17: the monthly calibration report).
#
# The job reads match_runs / match_feedback (logs only — no selfies, no models)
# and writes gs://<project>-derivatives/eval/calibration/<date>.{json,md}: the
# month's feedback numbers, judged precision per event, a badge re-fit and a
# cutoff re-score, each with a PROPOSED change when the evidence supports one.
# It applies nothing; a person reads the report and decides.
#
# Usage:
#   ./infra/scripts/deploy-calibration-job.sh <project-id> [region]
#
# Then schedule it monthly with provision-calibration-scheduler.sh, or run it now:
#   gcloud run jobs execute findme-calibration --region=us-central1 --project=<project-id> --wait
#
# A job bills only while it runs (about a minute a month), so it is zero-idle.

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
REPO="cloud-webapp"
JOB="findme-calibration"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Usage: $0 <project-id> [region]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${JOB}:$(date +%Y%m%d-%H%M%S)"

echo "==> Building $IMAGE (context: cloud-webapp/matcher/)"
CLOUDBUILD_CONFIG="$(mktemp -t cloudbuild-calibration-XXXXXX.yaml)"
trap 'rm -f "$CLOUDBUILD_CONFIG"' EXIT
cat > "$CLOUDBUILD_CONFIG" <<YAML
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-f', 'eval/Dockerfile.calibration', '-t', '$IMAGE', '.']
images: ['$IMAGE']
YAML
gcloud builds submit "$REPO_ROOT/matcher" \
  --project="$PROJECT_ID" \
  --gcs-log-dir="gs://${PROJECT_ID}_cloudbuild/logs" \
  --config="$CLOUDBUILD_CONFIG"

echo "==> Deploying job $JOB"
gcloud run jobs deploy "$JOB" \
  --image="$IMAGE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --service-account="api-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  --cpu=1 \
  --memory=1Gi \
  --max-retries=0 \
  --task-timeout=900 \
  --set-env-vars="PROJECT=${PROJECT_ID}"

echo "==> Done. Run it now with:"
echo "    gcloud run jobs execute $JOB --region=$REGION --project=$PROJECT_ID --wait"
