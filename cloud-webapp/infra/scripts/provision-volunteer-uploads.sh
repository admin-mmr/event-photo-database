#!/usr/bin/env bash
#
# provision-volunteer-uploads.sh — one-time infra for the GCS-first resumable
# volunteer upload flow (UPLOAD_RESUMABLE_NOTES).
#
# Idempotent. Safe to re-run. Creates a DEDICATED staging bucket (kept separate
# from the Find Me uploads bucket so the 7-day purge lifecycle never touches
# reference selfies), applies the browser CORS config, grants the api runtime
# SA write access, and sets a lifecycle rule that deletes staged objects and
# aborts abandoned resumable sessions after 7 days.
#
# Usage:
#   ./infra/scripts/provision-volunteer-uploads.sh <project-id> <web-origin> [region] [bucket]
#
# Example:
#   ./infra/scripts/provision-volunteer-uploads.sh mmr-data-pipeline \
#     https://mmr-data-pipeline.web.app
#
# After running this script you STILL must (these are not gcloud-scriptable):
#   1. Add the Drive write scope to the DWD client in the Workspace Admin
#      console (see the banner this script prints at the end).
#   2. Point the api service at the bucket + origin via env vars (also printed).

set -euo pipefail

PROJECT_ID="${1:-}"
WEB_ORIGIN="${2:-}"
REGION="${3:-us-central1}"
BUCKET="${4:-${PROJECT_ID}-uploads-staging}"

if [[ -z "$PROJECT_ID" || -z "$WEB_ORIGIN" ]]; then
  echo "Usage: $0 <project-id> <web-origin> [region] [bucket]" >&2
  echo "  e.g. $0 mmr-data-pipeline https://mmr-data-pipeline.web.app" >&2
  exit 1
fi

API_SA="api-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
BUCKET_URL="gs://${BUCKET}"

echo "==> Project: $PROJECT_ID  region: $REGION  bucket: $BUCKET"
echo "==> Web origin (must match the page that PUTs chunks): $WEB_ORIGIN"
gcloud config set project "$PROJECT_ID" >/dev/null

# 1. Staging bucket (uniform bucket-level access; no public access).
if gcloud storage buckets describe "$BUCKET_URL" >/dev/null 2>&1; then
  echo "==> Bucket $BUCKET_URL already exists, skipping create"
else
  echo "==> Creating bucket $BUCKET_URL"
  gcloud storage buckets create "$BUCKET_URL" \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --uniform-bucket-level-access \
    --public-access-prevention
fi

# 2. CORS — the browser PUTs cross-origin to storage.googleapis.com and must be
#    able to READ the Range response header to learn the committed offset on
#    resume. maxAgeSeconds caps the preflight cache.
CORS_FILE="$(mktemp)"
cat >"$CORS_FILE" <<JSON
[
  {
    "origin": ["${WEB_ORIGIN}"],
    "method": ["PUT", "POST", "GET", "HEAD"],
    "responseHeader": ["Content-Type", "Range", "Location", "x-goog-resumable"],
    "maxAgeSeconds": 3600
  }
]
JSON
echo "==> Applying CORS for origin $WEB_ORIGIN"
gcloud storage buckets update "$BUCKET_URL" --cors-file="$CORS_FILE"
rm -f "$CORS_FILE"

# 3. IAM — createResumableUpload + offset queries + cleanup deletes need
#    object admin on the bucket for the api runtime SA. ADC means no key file.
echo "==> Granting roles/storage.objectAdmin on $BUCKET to $API_SA"
gcloud storage buckets add-iam-policy-binding "$BUCKET_URL" \
  --member="serviceAccount:${API_SA}" \
  --role="roles/storage.objectAdmin"

# 4. Lifecycle — purge staged objects (and abort half-finished resumable
#    sessions, which GCS otherwise retains ~7 days) so abandoned uploads can't
#    accumulate cost.
LIFECYCLE_FILE="$(mktemp)"
cat >"$LIFECYCLE_FILE" <<JSON
{
  "rule": [
    { "action": {"type": "Delete"}, "condition": {"age": 7} },
    { "action": {"type": "AbortIncompleteMultipartUpload"}, "condition": {"age": 7} }
  ]
}
JSON
echo "==> Setting 7-day delete + abort-incomplete lifecycle on $BUCKET"
gcloud storage buckets update "$BUCKET_URL" --lifecycle-file="$LIFECYCLE_FILE"
rm -f "$LIFECYCLE_FILE"

cat <<BANNER

==================================================================
 DONE — bucket provisioned. Two MANUAL steps remain:
==================================================================

 A) Workspace Admin console — add the Drive WRITE scope to the DWD client.
    The api copies staged originals INTO the event Drive folder, which needs
    the read-write Drive scope (the read path uses drive.readonly):

      Admin console > Security > API controls > Domain-wide delegation
      Edit the existing client id (same one the indexer uses) and ADD:

        https://www.googleapis.com/auth/drive

      (keep the existing https://www.googleapis.com/auth/drive.readonly entry)

 B) Point the api service at this bucket + origin (merge env, do NOT --set):

      gcloud run services update event-photo-api --region=${REGION} \\
        --update-env-vars=VOLUNTEER_STAGING_BUCKET=${BUCKET},VOLUNTEER_UPLOAD_ORIGIN=${WEB_ORIGIN}

    Leave VOLUNTEER_STAGING_PREFIX at its default (volunteer_uploads) unless
    you have a reason to change it.
==================================================================
BANNER
