#!/usr/bin/env bash
#
# provision-email-daily-scheduler.sh — daily admin digest email.
#
# Creates/updates a Cloud Scheduler job that POSTs /api/admin/email/daily on the
# api once a day, authorized with the shared SYNC_TRIGGER_TOKEN header (the
# machine path in middleware/cronAuth.ts). The endpoint reads the last 24h of the
# Audit_Log, finds active admins opted in to the daily report (Email_Preferences),
# and sends each a digest via the Gmail API. It is a no-op when EMAIL_ENABLED is
# not "true", and never fails on a mail error (logged, non-fatal).
#
# Replaces the gas-app `dailyReportTrigger` time-based trigger
# (routes/reportHandlers.ts). gas-app's hourly email-retry queue is NOT ported —
# a transient send failure is logged once, not retried.
#
# Usage:
#   SYNC_TRIGGER_TOKEN=<secret> ./infra/scripts/provision-email-daily-scheduler.sh <project-id> [region]
#
# Tunables (env):
#   EMAIL_SCHEDULE   cron (default "0 7 * * *" — 07:00 daily)
#   EMAIL_TZ         time zone (default America/New_York)
#
# Prereqs:
#   - cloudscheduler.googleapis.com enabled.
#   - api deployed WITH the same SYNC_TRIGGER_TOKEN, EMAIL_ENABLED=true,
#     EMAIL_FROM, and the gmail.send DWD scope authorized (CUTOVER_RUNBOOK A1).
#
# Idempotent: re-running updates the existing job in place (verb-aware header
# flag — `--headers` on create, `--update-headers` on update).

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
JOB="findme-email-daily"
SCHEDULE="${EMAIL_SCHEDULE:-0 7 * * *}"
TZ="${EMAIL_TZ:-America/New_York}"

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
URI="${API_URL}/api/admin/email/daily"

# Cloud Run IAM runs before the app's X-Sync-Token gate, so the job must also
# attach a Google OIDC token. Default to the SA the existing daily-sync job uses.
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

echo "==> Done. Trigger a one-off digest with:"
echo "    gcloud scheduler jobs run $JOB --location=$REGION --project=$PROJECT_ID"
