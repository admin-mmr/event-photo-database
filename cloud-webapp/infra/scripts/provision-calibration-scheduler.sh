#!/usr/bin/env bash
#
# provision-calibration-scheduler.sh — run the `findme-calibration` job monthly.
#
# Creates/updates a Cloud Scheduler job that starts the Cloud Run job through the
# Run Admin API (jobs:run) on the 1st of each month. Unlike the other scheduler
# jobs this targets a JOB, not the api, so it authenticates with an OAuth token
# (Google API) rather than OIDC (Cloud Run service), and the caller needs
# run.jobs.run on that job — granted here as roles/run.invoker on the job only.
#
# Usage:
#   ./infra/scripts/provision-calibration-scheduler.sh <project-id> [region]
#
# Tunables (env):
#   CALIBRATION_SCHEDULE   cron (default "0 6 1 * *" — 06:00 on the 1st)
#   CALIBRATION_TZ         time zone (default America/New_York)
#   CALLER_SA              who starts the job (default api-runtime@<project>)
#
# Prereq: deploy-calibration-job.sh has created the job.
# Idempotent: re-running updates the scheduler job in place.

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
JOB="findme-calibration"
SCHED="findme-calibration-monthly"
SCHEDULE="${CALIBRATION_SCHEDULE:-0 6 1 * *}"
TZ="${CALIBRATION_TZ:-America/New_York}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Usage: $0 <project-id> [region]" >&2
  exit 1
fi
CALLER_SA="${CALLER_SA:-api-runtime@${PROJECT_ID}.iam.gserviceaccount.com}"

if ! gcloud run jobs describe "$JOB" --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "ERROR: job $JOB not found — run deploy-calibration-job.sh first." >&2
  exit 1
fi

echo "==> Granting $CALLER_SA run.invoker on job $JOB (lets it start this job, nothing else)"
gcloud run jobs add-iam-policy-binding "$JOB" \
  --region="$REGION" --project="$PROJECT_ID" \
  --member="serviceAccount:${CALLER_SA}" --role="roles/run.invoker" >/dev/null

URI="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB}:run"

if gcloud scheduler jobs describe "$SCHED" --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  VERB="update http"
else
  VERB="create http"
fi

echo "==> ${VERB%% *}-ing scheduler job '$SCHED' → POST $URI ($SCHEDULE $TZ)"
# shellcheck disable=SC2086
gcloud scheduler jobs $VERB "$SCHED" \
  --location="$REGION" \
  --project="$PROJECT_ID" \
  --schedule="$SCHEDULE" \
  --time-zone="$TZ" \
  --uri="$URI" \
  --http-method=POST \
  --message-body='{}' \
  --oauth-service-account-email="$CALLER_SA" \
  --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" \
  --attempt-deadline=60s

echo "==> Done. Reports land in gs://${PROJECT_ID}-derivatives/eval/calibration/. Trigger one now with:"
echo "    gcloud scheduler jobs run $SCHED --location=$REGION --project=$PROJECT_ID"
