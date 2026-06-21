#!/usr/bin/env bash
#
# provision-derivatives-cors.sh — one-time browser CORS for the derivatives
# bucket so the web app can fetch SIGNED original-photo URLs cross-origin as a
# Blob (gallery "Save to Photos" + full-res lightbox + Find Me originals).
#
# Why this exists: GET /api/events/:id/photos/:photoId/original now 302-redirects
# to a signed GCS URL instead of streaming the bytes through Cloud Run + the
# Firebase Hosting /api/** rewrite. That moves the heavy photo transfer off the
# Hosting egress line (which a single live event day spiked) and onto plain GCS
# egress. But the client reads the redirected response with fetch(...).blob(),
# which is a cross-origin read of storage.googleapis.com — so the bucket must
# return Access-Control-Allow-Origin for the web origin. <img>/thumbnail loads
# never needed this; blob reads do.
#
# Idempotent. Safe to re-run.
#
# Usage:
#   ./infra/scripts/provision-derivatives-cors.sh <project-id> <web-origin> [bucket]
#
# Example:
#   ./infra/scripts/provision-derivatives-cors.sh mmr-data-pipeline \
#     https://mmr-data-pipeline.web.app

set -euo pipefail

PROJECT_ID="${1:-}"
WEB_ORIGIN="${2:-}"
BUCKET="${3:-${PROJECT_ID}-derivatives}"

if [[ -z "$PROJECT_ID" || -z "$WEB_ORIGIN" ]]; then
  echo "Usage: $0 <project-id> <web-origin> [bucket]" >&2
  echo "  e.g. $0 mmr-data-pipeline https://mmr-data-pipeline.web.app" >&2
  exit 1
fi

BUCKET_URL="gs://${BUCKET}"

echo "==> Project: $PROJECT_ID  bucket: $BUCKET"
echo "==> Web origin (must match the page that fetches originals): $WEB_ORIGIN"
gcloud config set project "$PROJECT_ID" >/dev/null

if ! gcloud storage buckets describe "$BUCKET_URL" >/dev/null 2>&1; then
  echo "!!! Bucket $BUCKET_URL not found. Check the bucket name / DERIVATIVES_BUCKET." >&2
  exit 1
fi

ORIGINS="\"${WEB_ORIGIN}\", \"https://${PROJECT_ID}.web.app\", \"https://${PROJECT_ID}.firebaseapp.com\""

CORS_FILE="$(mktemp)"
cat >"$CORS_FILE" <<JSON
[
  {
    "origin": [${ORIGINS}],
    "method": ["GET", "HEAD"],
    "responseHeader": ["Content-Type", "Content-Length", "Content-Disposition"],
    "maxAgeSeconds": 3600
  }
]
JSON
echo "==> Applying CORS for origins: ${ORIGINS}"
gcloud storage buckets update "$BUCKET_URL" --cors-file="$CORS_FILE"
rm -f "$CORS_FILE"

echo "==> Done. Verify with:"
echo "    gcloud storage buckets describe $BUCKET_URL --format='value(cors_config)'"
echo
echo "NOTE: the web app's deployed origins must each be listed. If you also serve"
echo "      from https://${PROJECT_ID}.firebaseapp.com or a custom domain, re-run"
echo "      this script with that origin (CORS replaces, so add all origins in one"
echo "      run by editing the file, or apply the broadest origin you need)."
