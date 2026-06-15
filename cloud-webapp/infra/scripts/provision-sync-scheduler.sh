#!/usr/bin/env bash
#
# provision-sync-scheduler.sh — daily "Sync with Drive" reconcile trigger
# (dev plan §8). Creates/updates a Cloud Scheduler job that POSTs
# /api/admin/sync on the api, authorized with the shared SYNC_TRIGGER_TOKEN
# header (the machine path in routes/sync.ts).
#
# Usage:
#   SYNC_TRIGGER_TOKEN=<secret> ./infra/scripts/provision-sync-scheduler.sh <project-id> [region]
#
# Prereqs:
#   - cloudscheduler.googleapis.com enabled (bootstrap-gcp.sh §2.1).
#   - The api is deployed WITH the same SYNC_TRIGGER_TOKEN env var
#     (deploy-api.sh / deploy-api.yml). The token here must match.
#   - MASTER_SPREADSHEET_ID set on the api, and the Sheets scope authorized on
#     the DWD client (runbook §G1 + config.ts note).
#
# Idempotent: re-running updates the existing job in place.
#
# Why a header token and not OIDC: the api gates admin routes on Firebase ID
# tokens (human admins). A scheduler can't mint one, so the sync route also
# accepts a shared-secret header for machine callers. Keep the token in Secret
# Manager / repo secrets, never in the job definition in plaintext beyond this
# one-time create.

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
JOB="findme-drive-sync"
SCHEDULE="${SYNC_SCHEDULE:-0 6 * * *}"   # 06:00 daily, project default TZ
TZ="${SYNC_TZ:-America/New_York}"

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
URI="${API_URL}/api/admin/sync"

# Create or update.
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

echo "==> Done. Trigger a one-off run with:"
echo "    gcloud scheduler jobs run $JOB --location=$REGION --project=$PROJECT_ID"
