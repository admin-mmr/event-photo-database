#!/usr/bin/env bash
#
# deploy-web.sh — build the React SPA and deploy to Azure Static Web Apps.
# Azure counterpart of the GCP Firebase Hosting deploy.
#
# Usage:
#   ./infra/scripts/deploy-web.sh [resource-group]
#
# Static Web Apps (Free tier): free hosting + free managed TLS + free custom
# domain (photos.mmrunners.org). Routing/rewrites live in
# web/staticwebapp.config.json (the Azure analog of firebase.json's rewrites).
# /api/** is served by the api Container App via a *linked backend*, so the SPA
# and api share an origin — no CORS, same as the Firebase Hosting -> Cloud Run
# rewrite.

set -euo pipefail

RESOURCE_GROUP="${1:-${RESOURCE_GROUP:-mmr-photos-rg}}"
LOCATION="${2:-${LOCATION:-eastus}}"
SWA_NAME="${SWA_NAME:-swa-mmr-photos}"
API_APP="${API_APP:-event-photo-api}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "==> Building web bundle"
cd "$REPO_ROOT"
npm run build -w @cloud-webapp/web

echo "==> Ensuring Static Web App exists: $SWA_NAME"
az staticwebapp show -n "$SWA_NAME" -g "$RESOURCE_GROUP" >/dev/null 2>&1 || \
  az staticwebapp create -n "$SWA_NAME" -g "$RESOURCE_GROUP" \
    --location "$LOCATION" --sku Free -o none

echo "==> Deploying static assets with the SWA CLI"
# The SWA CLI uploads the prebuilt dist/ using a deployment token. Install once:
#   npm i -g @azure/static-web-apps-cli
DEPLOY_TOKEN="$(az staticwebapp secrets list -n "$SWA_NAME" -g "$RESOURCE_GROUP" \
  --query 'properties.apiKey' -o tsv)"
swa deploy "$REPO_ROOT/web/dist" \
  --deployment-token "$DEPLOY_TOKEN" \
  --env production

echo "==> Linking the api Container App as the /api backend (one-time; ignored if already linked)"
API_RESOURCE_ID="$(az containerapp show -g "$RESOURCE_GROUP" -n "$API_APP" --query id -o tsv 2>/dev/null || echo "")"
if [[ -n "$API_RESOURCE_ID" ]]; then
  az staticwebapp backends link -n "$SWA_NAME" -g "$RESOURCE_GROUP" \
    --backend-resource-id "$API_RESOURCE_ID" --backend-region "$LOCATION" -o none 2>/dev/null || \
    echo "    (backend already linked or link skipped)"
else
  echo "    WARN: api Container App '$API_APP' not found — deploy it first, then re-run to link." >&2
fi

echo "==> Web deploy complete"
az staticwebapp show -n "$SWA_NAME" -g "$RESOURCE_GROUP" --query '{defaultHostname:defaultHostname}' -o table
