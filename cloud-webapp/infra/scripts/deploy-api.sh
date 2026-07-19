#!/usr/bin/env bash
#
# deploy-api.sh — build and deploy the api to Cloud Run.
#
# Usage:
#   ./infra/scripts/deploy-api.sh <project-id> [region]
#
# This is the manual fallback. CI/CD does the same thing on push to main.

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
SERVICE="event-photo-api"
REPO="cloud-webapp"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Usage: $0 <project-id> [region]" >&2
  exit 1
fi

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}:$(date +%Y%m%d-%H%M%S)"

# Build context is the repo root (one level up from infra/), so the Dockerfile
# can copy the shared/ workspace too.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "==> Building image $IMAGE"
CLOUDBUILD_CONFIG="$(mktemp -t cloudbuild-XXXXXX.yaml)"
trap 'rm -f "$CLOUDBUILD_CONFIG"' EXIT
cat > "$CLOUDBUILD_CONFIG" <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-f', 'api/Dockerfile', '-t', '$IMAGE', '.']
images: ['$IMAGE']
EOF
gcloud builds submit "$REPO_ROOT" \
  --project="$PROJECT_ID" \
  --gcs-log-dir="gs://${PROJECT_ID}_cloudbuild/logs" \
  --config="$CLOUDBUILD_CONFIG"

echo "==> Deploying revision to Cloud Run service $SERVICE"
# Build the env-var list. We use --update-env-vars (MERGE), not --set-env-vars
# (REPLACE): the latter wipes every var not re-listed. With merge, unspecified
# vars are preserved. MATCHER_URL is auto-resolved from the matcher service
# below (no shell var needed). MASTER_SPREADSHEET_ID is only included when set,
# so an empty shell var can never blank a live value. SYNC_TRIGGER_TOKEN is NOT
# here — it's a Secret Manager secret (see --set-secrets below), so every deploy
# gets it automatically and it can't be wiped by a shell/CI env that lacks it.
ENV_VARS="NODE_ENV=production,GCP_PROJECT_ID=${PROJECT_ID},FIREBASE_PROJECT_ID=${PROJECT_ID},GIT_COMMIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

# MATCHER_URL: don't rely on a shell var that might be missing. Prefer an
# explicit override, else auto-resolve from the deployed matcher service so the
# value is always correct and can never drift or go empty across deploys.
MATCHER_SERVICE="${MATCHER_SERVICE:-matcher}"
MATCHER_URL="${MATCHER_URL:-$(gcloud run services describe "$MATCHER_SERVICE" \
  --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)' 2>/dev/null || true)}"
if [[ -n "$MATCHER_URL" ]]; then
  ENV_VARS="${ENV_VARS},MATCHER_URL=${MATCHER_URL}"
else
  echo "WARN: could not resolve the '$MATCHER_SERVICE' service URL; leaving MATCHER_URL unchanged (merge preserves any existing value)." >&2
fi

if [[ -n "${MASTER_SPREADSHEET_ID:-}" ]]; then ENV_VARS="${ENV_VARS},MASTER_SPREADSHEET_ID=${MASTER_SPREADSHEET_ID}"; fi

# Rate limits (dev plan §5B C2). Set EXPLICITLY so behaviour isn't an accident
# of the schema defaults in config.ts (these were unset on the live service,
# which is how the "Save individually" path quietly burned the daily download
# budget). Override any of them by exporting the matching shell var.
#   FINDME_SEARCH_LIMIT / _WINDOW_SEC  searches per window, keyed by uid.
#   DOWNLOAD_LIMIT_PER_DAY             bulk ZIP downloads/day (one ZIP = one).
#   ORIGINAL_FETCH_LIMIT               single-photo fetches/day — its OWN bucket
#                                      because one save fans out into N of them.
ENV_VARS="${ENV_VARS},FINDME_SEARCH_LIMIT=${FINDME_SEARCH_LIMIT:-20}"
ENV_VARS="${ENV_VARS},FINDME_SEARCH_WINDOW_SEC=${FINDME_SEARCH_WINDOW_SEC:-60}"
ENV_VARS="${ENV_VARS},DOWNLOAD_LIMIT_PER_DAY=${DOWNLOAD_LIMIT_PER_DAY:-50}"
ENV_VARS="${ENV_VARS},ORIGINAL_FETCH_LIMIT=${ORIGINAL_FETCH_LIMIT:-500}"

# reCAPTCHA Enterprise (services/recaptcha.ts). The gate runs only when all of
# RECAPTCHA_PROJECT_ID + _SITE_KEY + _API_KEY are non-empty. PROJECT_ID and the
# SITE_KEY are NOT secret (the site key ships in the client bundle), so they live
# as plain env vars; the API_KEY is sensitive and comes from Secret Manager (see
# --set-secrets below). RECAPTCHA_SITE_KEY must equal the web build's
# VITE_RECAPTCHA_SITE_KEY. SITE_KEY is only added when exported, so an empty
# shell var can't blank a live value (merge preserves it).
ENV_VARS="${ENV_VARS},RECAPTCHA_PROJECT_ID=${RECAPTCHA_PROJECT_ID:-${PROJECT_ID}}"
if [[ -n "${RECAPTCHA_SITE_KEY:-}" ]]; then ENV_VARS="${ENV_VARS},RECAPTCHA_SITE_KEY=${RECAPTCHA_SITE_KEY}"; fi
ENV_VARS="${ENV_VARS},RECAPTCHA_MIN_SCORE=${RECAPTCHA_MIN_SCORE:-0.5}"

# Volunteer upload background worker (UPLOAD_ASYNC_QUEUE_DESIGN.md step 3).
# Dispatch is OFF unless the flag is 'true' AND the queue + worker URL are set
# (see UPLOAD_WORKER_RUNBOOK.md for one-time provisioning). The flag is set
# explicitly so its state isn't an accident of the schema default; QUEUE and
# WORKER_URL are only added when exported so an empty shell var can't blank a
# live value (merge preserves it). LOCATION defaults to the deploy region.
ENV_VARS="${ENV_VARS},UPLOAD_DISPATCH_TO_WORKER=${UPLOAD_DISPATCH_TO_WORKER:-false}"
if [[ -n "${UPLOAD_TASKS_QUEUE:-}" ]]; then ENV_VARS="${ENV_VARS},UPLOAD_TASKS_QUEUE=${UPLOAD_TASKS_QUEUE}"; fi
ENV_VARS="${ENV_VARS},UPLOAD_TASKS_LOCATION=${UPLOAD_TASKS_LOCATION:-${REGION}}"
if [[ -n "${UPLOAD_WORKER_URL:-}" ]]; then ENV_VARS="${ENV_VARS},UPLOAD_WORKER_URL=${UPLOAD_WORKER_URL}"; fi

# Managed folders (gas-app migration). OFF by default — the post-upload Photos /
# Videos / Album rebuild + public folder index only run when MANAGED_FOLDERS_ENABLED
# is "true". PUBLIC_FOLDER_INDEX_SHEET_ID and IMAGE_CONVERT_URL are only added when
# exported (merge preserves a live value). Without IMAGE_CONVERT_URL, non-JPEG
# photos fall back to shortcuts (JPEGs are always shortcuts). DRIVE_MIN_INTERVAL_MS
# paces all Drive calls (default 120ms ≈ 8 req/s) to stay under the per-user quota.
ENV_VARS="${ENV_VARS},MANAGED_FOLDERS_ENABLED=${MANAGED_FOLDERS_ENABLED:-false}"
if [[ -n "${PUBLIC_FOLDER_INDEX_SHEET_ID:-}" ]]; then ENV_VARS="${ENV_VARS},PUBLIC_FOLDER_INDEX_SHEET_ID=${PUBLIC_FOLDER_INDEX_SHEET_ID}"; fi
if [[ -n "${IMAGE_CONVERT_URL:-}" ]]; then ENV_VARS="${ENV_VARS},IMAGE_CONVERT_URL=${IMAGE_CONVERT_URL}"; fi
if [[ -n "${DRIVE_MIN_INTERVAL_MS:-}" ]]; then ENV_VARS="${ENV_VARS},DRIVE_MIN_INTERVAL_MS=${DRIVE_MIN_INTERVAL_MS}"; fi

echo "==> Setting env vars: ${ENV_VARS}"

# --timeout=300 (not 60): the machine-triggered folder-rebuild drain
# (/admin/folders/rebuild-drain) processes one event per claim, and a single
# large event's migrate-shortcuts / photo rebuild can legitimately run past 60s
# (per-shortcut image-convert calls). A 60s request timeout killed the drain
# mid-event → HTTP 504 with zero progress. Hosting-routed user paths still cap at
# 60s (Firebase Hosting max), so this only lengthens the direct run.app machine
# calls; it does not affect idle cost (scale-to-zero is unchanged).
gcloud run deploy "$SERVICE" \
  --image="$IMAGE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --platform=managed \
  --service-account="api-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  --port=8080 \
  --memory=512Mi \
  --cpu=1 \
  --max-instances=10 \
  --min-instances=0 \
  --concurrency=80 \
  --timeout=300 \
  --update-env-vars="$ENV_VARS" \
  --set-secrets="SYNC_TRIGGER_TOKEN=SYNC_TRIGGER_TOKEN:latest,CONSENT_POLICY_VERSION=CONSENT_POLICY_VERSION:latest,RECAPTCHA_API_KEY=RECAPTCHA_KEY:latest"
# Auth: we deliberately pass NEITHER --allow-unauthenticated nor
#   --no-allow-unauthenticated, so deploy leaves the service's IAM policy
#   untouched. Classic Firebase Hosting → Cloud Run rewrites require the service
#   to be publicly invokable (allUsers/run.invoker); the app does its own auth
#   (requireAuth/requireAdmin/X-Sync-Token), so public *invocation* is by design.
#   Passing --no-allow-unauthenticated here previously STRIPPED the allUsers
#   binding on every deploy, which broke the web app (Cloud Run IAM then rejected
#   the browser's Firebase token with an HTML 401 before it reached the app).
#   The allUsers binding requires a DRS org-policy exception to (re)create.
# MASTER_SPREADSHEET_ID = the gas-app master Sheet id ("Sync with Drive", dev plan §8);
#   empty = POST /api/admin/sync 503s. MERGED in (see above), so it persists
#   across deploys even if you don't re-export it.
# SYNC_TRIGGER_TOKEN = shared secret for the Cloud Scheduler + gas-app indexing
#   triggers. Sourced from Secret Manager (--set-secrets), so every deploy —
#   manual or CI — gets it automatically and it can never be blanked by a shell
#   that doesn't have it. One-time setup (see runbook §0a): create the secret and
#   grant api-runtime@ secretAccessor:
#     printf '%s' "<token>" | gcloud secrets create SYNC_TRIGGER_TOKEN --data-file=- --project=mmr-data-pipeline
#     gcloud secrets add-iam-policy-binding SYNC_TRIGGER_TOKEN --project=mmr-data-pipeline \
#       --member="serviceAccount:api-runtime@mmr-data-pipeline.iam.gserviceaccount.com" \
#       --role="roles/secretmanager.secretAccessor"
# Note: no --add-cloudsql-instances — Cloud SQL was dropped (zero-cost design, runbook Phase F).
# Runtime SA is api-runtime (least privilege), never the deployer SA (runbook E2).

URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')"
echo "==> Deployed:  $URL"
echo "==> Smoke test (GET /api/health):"
# The org's Domain Restricted Sharing policy blocks public (allUsers) access, so
# the service requires authentication. We send a Google-signed identity token
# for the active account (which must hold roles/run.invoker) — but the *deploy*
# must not be gated on the caller's invoke permission. A 200 is a healthy
# container; a 401/403 still proves the service is up and enforcing auth (common
# in CI, where the deployer SA can't mint a usable ID token); only a 5xx or an
# unreachable endpoint is a genuine failure.
HEALTH_CODE="$(curl -s -o /tmp/api_health.json -w '%{http_code}' \
  -H "Authorization: Bearer $(gcloud auth print-identity-token 2>/dev/null || true)" \
  "$URL/api/health" || echo 000)"
cat /tmp/api_health.json 2>/dev/null; echo
case "$HEALTH_CODE" in
  200)     echo "==> Smoke test OK (200).";;
  401|403) echo "==> Service is up and auth-gated (HTTP $HEALTH_CODE); smoke-test identity lacks run.invoker — skipping health assertion.";;
  *)       echo "ERROR: /api/health returned HTTP $HEALTH_CODE — deploy may be unhealthy." >&2; exit 1;;
esac
