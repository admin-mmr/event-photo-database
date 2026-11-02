#!/usr/bin/env bash
#
# provision-upload-sweep-scheduler.sh — file volunteer uploads that never
# reached /complete.
#
# Creates/updates a Cloud Scheduler job that POSTs
# /api/admin/upload-recovery/sweep with {"apply": true} on the api every hour,
# authorized with the shared SYNC_TRIGGER_TOKEN header (the machine path in
# middleware/cronAuth.ts) plus an OIDC token for Cloud Run IAM.
#
# Why it exists: the browser calls /complete once, after its last file, and
# /complete is the only thing that dispatches the copy to Drive. A volunteer who
# closes the tab mid-session strands every finished file in the staging bucket
# until an admin runs recover-staged-uploads.sh — 5 sessions / 1,550 photos on
# NYC Marathon night (2026-11-01/02) — and the bucket's lifecycle rule deletes
# them eventually. The sweep (services/uploadSweepService.ts) files any batch
# whose NEWEST staged file is over 2h old and that has no upload_batches record,
# through the same Cloud Tasks re-dispatch the recovery tool uses.
#
# Zero idle cost: a tick with nothing owed is one staging-bucket listing (a
# healthy bucket is near-empty — the worker deletes each object after copying).
# Hourly, not every few minutes: the 2h age guard makes a faster tick pointless,
# and the sweep caps each tick at ~50 min of staggered work so one tick's chunks
# never overlap the next's.
#
# Usage:
#   SYNC_TRIGGER_TOKEN=<secret> ./infra/scripts/provision-upload-sweep-scheduler.sh <project-id> [region]
#
# Tunables (env):
#   SWEEP_SCHEDULE   cron (default "17 * * * *" — hourly, off the top of the hour)
#   SWEEP_TZ         time zone (default America/New_York)
#   OIDC_SA          service account for the OIDC token (default: borrowed from
#                    an existing scheduler job)
#
# Prereqs:
#   - cloudscheduler.googleapis.com enabled.
#   - api deployed WITH the same SYNC_TRIGGER_TOKEN, with background dispatch
#     configured (UPLOAD_DISPATCH_TO_WORKER etc.) — otherwise every tick reports
#     "not configured" and does nothing — and with --timeout=1800 (the worker
#     copying the swept files needs it; see CLAUDE.md).
#
# Dry-run the endpoint first to see what the first tick would file:
#   curl -sS -X POST "$API_URL/api/admin/upload-recovery/sweep" \
#     -H "X-Sync-Token: $SYNC_TRIGGER_TOKEN" -H "Content-Type: application/json" -d '{}'
#
# Idempotent: re-running updates the existing job in place (verb-aware header
# flag — see CLAUDE.md).

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
JOB="findme-upload-sweep"
SCHEDULE="${SWEEP_SCHEDULE:-17 * * * *}"
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
URI="${API_URL}/api/admin/upload-recovery/sweep"

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
  --format='value(name)' \
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
  --attempt-deadline=600s

echo "==> Done. Trigger a one-off sweep with:"
echo "    gcloud scheduler jobs run $JOB --location=$REGION --project=$PROJECT_ID"
