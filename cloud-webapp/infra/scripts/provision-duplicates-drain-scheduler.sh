#!/usr/bin/env bash
#
# provision-duplicates-drain-scheduler.sh — drain the duplicate-removal queue.
#
# Creates/updates a Cloud Scheduler job that POSTs /api/admin/duplicates/drain on
# the api every couple of minutes, authorized with the shared SYNC_TRIGGER_TOKEN
# header (the machine path in middleware/cronAuth.ts).
#
# Why the queue exists: removing an event's duplicate files is minutes of
# rate-paced Drive work (~3.5 paced calls per file once its managed shortcuts are
# retired), so it cannot run inside one request — Firebase Hosting caps at 60s and
# Cloud Run is deployed with --timeout=60. The apply POST enqueues a batch
# (duplicateRemovalQueue.ts) and returns 202; bounded drain ticks do the work. The
# admin UI drives ticks itself while the page is open, so this job is the BACKSTOP
# that finishes a batch after the admin navigates away. A drain with nothing
# queued is a cheap one-query no-op, so a frequent tick costs effectively nothing
# while idle (the zero-idle-cost policy).
#
# Usage:
#   SYNC_TRIGGER_TOKEN=<secret> ./infra/scripts/provision-duplicates-drain-scheduler.sh <project-id> [region]
#
# Tunables (env):
#   DRAIN_SCHEDULE   cron (default "*/2 * * * *" — every 2 minutes)
#   DRAIN_TZ         time zone (default America/New_York)
#
# Prereqs (same as provision-folder-rebuild-scheduler.sh):
#   - cloudscheduler.googleapis.com enabled.
#   - api deployed WITH the same SYNC_TRIGGER_TOKEN env var, and the composite
#     index on duplicateRemovalBatches (status ASC + createdAt ASC) deployed from
#     infra/firestore.indexes.json — without it every tick 500s with
#     FAILED_PRECONDITION.
#
# Idempotent: re-running updates the existing job in place (verb-aware header
# flag — see CLAUDE.md).

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
JOB="findme-duplicates-drain"
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
URI="${API_URL}/api/admin/duplicates/drain"

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
  --message-body='{}' \
  --oidc-service-account-email="$OIDC_SA" \
  --oidc-token-audience="$API_URL" \
  --attempt-deadline=320s

echo "==> Done. Trigger a one-off drain with:"
echo "    gcloud scheduler jobs run $JOB --location=$REGION --project=$PROJECT_ID"
