#!/usr/bin/env bash
#
# provision-upload-recovery-scheduler.sh — the hourly backstop for volunteer
# photos stranded in the staging bucket.
#
# Creates/updates a Cloud Scheduler job that POSTs /api/admin/upload-recovery-sweep
# with `{"apply":true}` every hour, authorized with the shared SYNC_TRIGGER_TOKEN
# header (the machine path in middleware/cronAuth.ts).
#
# Why it exists: the copy path deliberately keeps a photo in staging whenever it
# cannot PROVE the photo reached Drive (a failed copy, or an "unconfirmed
# duplicate" left by a worker killed mid-copy). Before this job nothing came back
# for those: they reached the gallery only if an admin ran upload-recovery by
# hand, before the bucket's lifecycle rule deleted them. The sweep re-dispatches
# them through the existing recovery tool, leaves any batch still being worked on
# alone, and emails ADMIN_EMAILS if photos stay stranded past a day. The rules
# are in api/src/services/uploadRecoverySweep.ts.
#
# An idle hour is cheap: one staging listing plus one photo-index read per event
# that still has staged objects, and no Drive work at all. The job itself is one
# of the account's Cloud Scheduler jobs ($0.10/month beyond the 3 free ones).
#
# Kill switch: `gcloud scheduler jobs pause upload-recovery-sweep --location=<region>`.
#
# Usage:
#   SYNC_TRIGGER_TOKEN=<secret> ./infra/scripts/provision-upload-recovery-scheduler.sh <project-id> [region]
#
# Tunables (env):
#   SWEEP_SCHEDULE   cron (default "20 * * * *" — hourly, off the top of the hour
#                    so it does not coincide with the other schedulers)
#   SWEEP_TZ         time zone (default America/New_York)
#
# Idempotent: re-running updates the existing job in place (verb-aware header
# flag — see CLAUDE.md).

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
JOB="upload-recovery-sweep"
SCHEDULE="${SWEEP_SCHEDULE:-20 * * * *}"
TZ="${SWEEP_TZ:-America/New_York}"

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
URI="${API_URL}/api/admin/upload-recovery-sweep"

# Borrow the OIDC service account from whichever existing job already has one.
#
# Do NOT key this off a single hard-coded job name: it used to read
# findme-drive-sync, which is the ONE job of the five with no OIDC token at all
# (it predates the convention and works only because the api is publicly
# invokable). So the probe always came back empty and the script died with
# "no OIDC service account found" even on a perfectly configured project.
# Scanning every job in the region finds the first one that does carry an SA.
if [[ -z "${OIDC_SA:-}" ]]; then
  OIDC_SA="$(gcloud scheduler jobs list \
    --location="$REGION" --project="$PROJECT_ID" \
    --format='value(httpTarget.oidcToken.serviceAccountEmail)' 2>/dev/null \
    | awk 'NF { print; exit }' || true)"
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
