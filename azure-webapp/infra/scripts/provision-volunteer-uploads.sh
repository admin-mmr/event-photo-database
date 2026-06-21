#!/usr/bin/env bash
#
# provision-volunteer-uploads.sh — one-time infra for the Blob-first resumable
# volunteer upload flow (UPLOAD_RESUMABLE_NOTES). Azure port of the GCS staging
# bucket setup.
#
# Idempotent. Creates/uses the DEDICATED 'staging' Blob container (kept separate
# from the photos/derivatives containers so the 7-day purge lifecycle never
# touches anything permanent), applies a browser CORS rule for resumable PUTs,
# and sets a lifecycle rule that deletes staged blobs after 7 days.
#
# Usage:
#   ./infra/scripts/provision-volunteer-uploads.sh [resource-group] <web-origin>
#
# Example:
#   ./infra/scripts/provision-volunteer-uploads.sh mmr-photos-rg https://swa-mmr-photos.azurestaticapps.net

set -euo pipefail

RESOURCE_GROUP="${1:-${RESOURCE_GROUP:-mmr-photos-rg}}"
WEB_ORIGIN="${2:-${WEB_ORIGIN:-}}"
SUFFIX="${NAME_SUFFIX:-$(echo "$RESOURCE_GROUP" | tr -cd 'a-z0-9' | cut -c1-12)}"
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-mmrphotos${SUFFIX}}"
CONTAINER="${STAGING_CONTAINER:-staging}"

if [[ -z "$WEB_ORIGIN" ]]; then
  echo "Usage: $0 [resource-group] <web-origin>" >&2; exit 1
fi

echo "==> Ensuring staging container '$CONTAINER' exists"
az storage container create --account-name "$STORAGE_ACCOUNT" --name "$CONTAINER" \
  --auth-mode login -o none 2>/dev/null || true

echo "==> Applying Blob CORS rule for resumable uploads from $WEB_ORIGIN"
az storage cors clear --account-name "$STORAGE_ACCOUNT" --services b --auth-mode login -o none 2>/dev/null || true
az storage cors add --account-name "$STORAGE_ACCOUNT" --services b --auth-mode login \
  --methods PUT GET HEAD OPTIONS \
  --origins "$WEB_ORIGIN" \
  --allowed-headers '*' --exposed-headers '*' --max-age 3600 -o none

echo "==> Setting 7-day delete lifecycle on '$CONTAINER/' blobs"
POLICY_FILE="$(mktemp -t blob-lifecycle-XXXXXX.json)"
trap 'rm -f "$POLICY_FILE"' EXIT
cat > "$POLICY_FILE" <<EOF
{
  "rules": [
    {
      "enabled": true,
      "name": "purge-staging-7d",
      "type": "Lifecycle",
      "definition": {
        "filters": { "blobTypes": ["blockBlob"], "prefixMatch": ["${CONTAINER}/"] },
        "actions": { "baseBlob": { "delete": { "daysAfterModificationGreaterThan": 7 } } }
      }
    }
  ]
}
EOF
az storage account management-policy create \
  --account-name "$STORAGE_ACCOUNT" -g "$RESOURCE_GROUP" \
  --policy @"$POLICY_FILE" -o none 2>/dev/null || \
  az storage account management-policy update \
    --account-name "$STORAGE_ACCOUNT" -g "$RESOURCE_GROUP" \
    --policy @"$POLICY_FILE" -o none

echo "==> Volunteer upload staging ready on $STORAGE_ACCOUNT/$CONTAINER"
echo "    The api mints user-delegation SAS URLs for resumable PUTs (see AZURE.md)."
