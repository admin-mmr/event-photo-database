#!/usr/bin/env bash
#
# provision-index-scan-scheduler.sh — safety-net "index on arrival" trigger.
#
# Creates/updates a Cloud Scheduler job that POSTs /api/admin/index-scan on the
# api every few minutes, authorized with the shared SYNC_TRIGGER_TOKEN header
# (the machine path in middleware/cronAuth.ts). The endpoint triggers the
# photo-indexer for every active event that has new files in Drive; the indexer
# is idempotent so events with nothing new are a cheap no-op.
#
# This is the backstop for the primary, event-driven trigger (the gas-app fires
# POST /api/events/:id/index at the end of each upload batch). The scan catches
# anything the end-of-batch call missed, plus files added straight to Drive.
#
# Usage:
#   SYNC_TRIGGER_TOKEN=<secret> ./infra/scripts/provision-index-scan-scheduler.sh <project-id> [region]
#
# Tunables (env):
#   SCAN_SCHEDULE   cron (default "*/10 * * * *" — every 10 minutes)
#   SCAN_TZ         time zone (default America/New_York)
#
# Prereqs (same as provision-sync-scheduler.sh):
#   - cloudscheduler.googleapis.com enabled.
#   - api deployed WITH the same SYNC_TRIGGER_TOKEN env var.
#   - api-runtime@ has roles/run.invoker on the photo-indexer job (so the
#     scan can launch executions) — see services/indexerJob.ts header.
#
# Idempotent: re-running updates the existing job in place.

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
JOB="findme-index-scan"
SCHEDULE="${SCAN_SCHEDULE:-*/10 * * * *}"   # every 10 minutes
TZ="${SCAN_TZ:-America/New_York}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Usage: $0 <project-id> [region]" >&2
  exit 1
fi
if [[ -z "${SYNC_TRIGGER_TOKEN:-}" ]]; then
  echo "ERROR: export SYNC_TRIGGER_TOKEN (must match the value deployed on the api)." >&2
  exit 1
fi

SERVICE="event-photo-api"
API_URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')"
if [[ -z "$API_URL" ]]; then
  echo "ERROR: could not resolve $SERVICE URL — is it deployed?" >&2
  exit 1
fi
URI="${API_URL}/api/admin/index-scan"

if gcloud scheduler jobs describe "$JOB" --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  VERB="update http"
else
  VERB="create http"
fi

echo "==> ${VERB%% *}-ing scheduler job '$JOB' → POST $URI ($SCHEDULE $TZ)"
# shellcheck disable=SC2086
gcloud scheduler jobs $VERB "$JOB" \
  --location="$REGION" \
  --project="$PROJECT_ID" \
  --schedule="$SCHEDULE" \
  --time-zone="$TZ" \
  --uri="$URI" \
  --http-method=POST \
  --headers="X-Sync-Token=${SYNC_TRIGGER_TOKEN},Content-Type=application/json" \
  --message-body='{}' \
  --attempt-deadline=320s

echo "==> Done. Trigger a one-off scan with:"
echo "    gcloud scheduler jobs run $JOB --location=$REGION --project=$PROJECT_ID"
