#!/usr/bin/env bash
#
# provision-reference-retention-scheduler.sh — daily Find-Me selfie retention.
#
# Creates/updates a Cloud Scheduler job that POSTs
# /api/admin/findme/retention/sweep with {"apply":true} once a day, authorized
# with the shared SYNC_TRIGGER_TOKEN header (the machine path in
# middleware/cronAuth.ts). The endpoint deletes every stored reference selfie past
# its PRD §8.4 tier (90 days adult / 30 minor) — object first, then record. A run
# with nothing overdue is one Firestore read, so the daily tick is ~free.
#
# This is the ONLY thing that enforces the 30-day minor tier: the uploads
# bucket's lifecycle rule is a flat 90 days. Do not replace it with a Firestore
# TTL on find_me_uploads — a TTL deletes the record and strands the selfie.
#
# Usage:
#   SYNC_TRIGGER_TOKEN=<secret> ./infra/scripts/provision-reference-retention-scheduler.sh <project-id> [region]
#
# Tunables (env):
#   RETENTION_SCHEDULE   cron (default "15 4 * * *" — 04:15 daily, off-peak)
#   RETENTION_TZ         time zone (default America/New_York)
#
# Prereqs:
#   - cloudscheduler.googleapis.com enabled.
#   - api deployed WITH the same SYNC_TRIGGER_TOKEN (its runtime SA already holds
#     storage.objectAdmin on the uploads bucket).
#
# Idempotent: re-running updates the existing job in place (verb-aware header
# flag — `--headers` on create, `--update-headers` on update).

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
JOB="findme-reference-retention"
SCHEDULE="${RETENTION_SCHEDULE:-15 4 * * *}"
TZ="${RETENTION_TZ:-America/New_York}"

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
URI="${API_URL}/api/admin/findme/retention/sweep"

# Cloud Run IAM runs before the app's X-Sync-Token gate, so the job must also
# attach a Google OIDC token. Default to the SA the existing daily-sync job uses.
if [[ -z "${OIDC_SA:-}" ]]; then
  OIDC_SA="$(gcloud scheduler jobs describe findme-drive-sync \
    --location="$REGION" --project="$PROJECT_ID" \
    --format='value(httpTarget.oidcToken.serviceAccountEmail)' 2>/dev/null || true)"
fi
# findme-drive-sync predates OIDC and carries none (it still works: the api is
# publicly invokable), so fall back to the api's own runtime SA, which every
# other scheduler job uses and which holds run.invoker on the service.
if [[ -z "$OIDC_SA" ]]; then
  OIDC_SA="api-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
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
  --message-body='{"apply":true}' \
  --oidc-service-account-email="$OIDC_SA" \
  --oidc-token-audience="$API_URL" \
  --attempt-deadline=320s

echo "==> Done. Trigger a one-off sweep with:"
echo "    gcloud scheduler jobs run $JOB --location=$REGION --project=$PROJECT_ID"
