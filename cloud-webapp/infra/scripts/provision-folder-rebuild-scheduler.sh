#!/usr/bin/env bash
#
# provision-folder-rebuild-scheduler.sh — drain the managed-folder rebuild queue.
#
# Creates/updates a Cloud Scheduler job that POSTs /api/admin/folders/rebuild-drain
# on the api every couple of minutes, authorized with the shared
# SYNC_TRIGGER_TOKEN header (the machine path in middleware/cronAuth.ts).
#
# The "All events" Photos / Videos+Albums / Migrate buttons enqueue a batch
# (folderRebuildQueue.ts) and return 202 instead of running the Drive-heavy loop
# inline — which used to 502 at the 60s Hosting/Cloud Run cap. This drain claims
# pending events a few at a time (transactionally, so overlapping ticks never
# double-process) until a batch is empty, then refreshes the public folder index
# once. A drain with nothing queued is a cheap one-query no-op, so a frequent
# tick costs effectively nothing while idle.
#
# Usage:
#   SYNC_TRIGGER_TOKEN=<secret> ./infra/scripts/provision-folder-rebuild-scheduler.sh <project-id> [region]
#
# Tunables (env):
#   DRAIN_SCHEDULE   cron (default "*/2 * * * *" — every 2 minutes)
#   DRAIN_TZ         time zone (default America/New_York)
#
# Prereqs (same as provision-index-scan-scheduler.sh):
#   - cloudscheduler.googleapis.com enabled.
#   - api deployed WITH the same SYNC_TRIGGER_TOKEN env var and
#     MANAGED_FOLDERS_ENABLED=true.
#
# Idempotent: re-running updates the existing job in place (verb-aware header
# flag, unlike provision-index-scan-scheduler.sh — see CLAUDE.md).

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
JOB="findme-folder-rebuild"
SCHEDULE="${DRAIN_SCHEDULE:-*/2 * * * *}"
TZ="${DRAIN_TZ:-America/New_York}"

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
URI="${API_URL}/api/admin/folders/rebuild-drain"

if [[ -z "${OIDC_SA:-}" ]]; then
  OIDC_SA="$(gcloud scheduler jobs describe findme-drive-sync \
    --location="$REGION" --project="$PROJECT_ID" \
    --format='value(httpTarget.oidcToken.serviceAccountEmail)' 2>/dev/null || true)"
fi
if [[ -z "$OIDC_SA" ]]; then
  echo "ERROR: no OIDC service account found." >&2
  echo "  Export OIDC_SA=<sa-email> (a SA with roles/run.invoker on $SERVICE) and re-run." >&2
  exit 1
fi
echo "==> Using OIDC service account: $OIDC_SA (audience $API_URL)"

if gcloud scheduler jobs describe "$JOB" --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  VERB="update http"
  HEADER_FLAG="--update-headers"
else
  VERB="create http"
  HEADER_FLAG="--headers"
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
  "$HEADER_FLAG=X-Sync-Token=${SYNC_TRIGGER_TOKEN},Content-Type=application/json" \
  --message-body='{}' \
  --oidc-service-account-email="$OIDC_SA" \
  --oidc-token-audience="$API_URL" \
  --attempt-deadline=320s

echo "==> Done. Trigger a one-off drain with:"
echo "    gcloud scheduler jobs run $JOB --location=$REGION --project=$PROJECT_ID"
