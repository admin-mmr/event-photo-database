#!/usr/bin/env bash
#
# deploy-api.sh — build and deploy the api to Azure Container Apps.
# Azure counterpart of the GCP Cloud Run deploy. CI/CD does the same on push.
#
# Usage:
#   ./infra/scripts/deploy-api.sh [resource-group] [location]
#
# The api Container App has EXTERNAL ingress (the SPA / Static Web App calls it
# at /api/**). It does its OWN auth (requireAuth/requireAdmin/X-Sync-Token), so
# external ingress is by design — the equivalent of the public Cloud Run service
# behind Firebase Hosting. min-replicas=0 keeps idle cost at $0 (CLAUDE.md).

set -euo pipefail

RESOURCE_GROUP="${1:-${RESOURCE_GROUP:-mmr-photos-rg}}"
LOCATION="${2:-${LOCATION:-eastus}}"
SUFFIX="${NAME_SUFFIX:-$(echo "$RESOURCE_GROUP" | tr -cd 'a-z0-9' | cut -c1-12)}"

APP="event-photo-api"
ACR_NAME="${ACR_NAME:-mmrphotosacr${SUFFIX}}"
ACA_ENV="${ACA_ENV:-cae-mmr-photos}"
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-mmrphotos${SUFFIX}}"
COSMOS_ACCOUNT="${COSMOS_ACCOUNT:-cosmos-mmr-${SUFFIX}}"
COSMOS_DB="${COSMOS_DB:-eventphotos}"
KEY_VAULT="${KEY_VAULT:-kv-mmr-${SUFFIX}}"
MATCHER_APP="${MATCHER_APP:-matcher}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

TAG="$(date +%Y%m%d-%H%M%S)"
IMAGE="${ACR_NAME}.azurecr.io/${APP}:${TAG}"
LOGIN_SERVER="${ACR_NAME}.azurecr.io"

echo "==> Building image in ACR (in-cloud, like Cloud Build): $IMAGE"
# Build context is the repo root so the Dockerfile can COPY the shared/ workspace.
az acr build --registry "$ACR_NAME" --image "${APP}:${TAG}" \
  --file api/Dockerfile "$REPO_ROOT"

# Resolve managed identity + endpoints.
API_ID="$(az identity show -g "$RESOURCE_GROUP" -n id-api-runtime --query id -o tsv)"
API_CLIENT_ID="$(az identity show -g "$RESOURCE_GROUP" -n id-api-runtime --query clientId -o tsv)"
COSMOS_ENDPOINT="$(az cosmosdb show -n "$COSMOS_ACCOUNT" -g "$RESOURCE_GROUP" --query documentEndpoint -o tsv)"
# matcher has internal ingress; reachable at its env-internal FQDN.
MATCHER_FQDN="$(az containerapp show -g "$RESOURCE_GROUP" -n "$MATCHER_APP" --query properties.configuration.ingress.fqdn -o tsv 2>/dev/null || echo "")"
MATCHER_URL="${MATCHER_URL:-}"
[[ -z "$MATCHER_URL" && -n "$MATCHER_FQDN" ]] && MATCHER_URL="https://${MATCHER_FQDN}"

# Env vars. AZURE_CLIENT_ID makes DefaultAzureCredential pick the user-assigned
# identity. Storage/Cosmos use AAD (managed identity), no keys in env.
ENV_VARS=(
  "NODE_ENV=production"
  "AZURE_CLIENT_ID=${API_CLIENT_ID}"
  "COSMOS_ENDPOINT=${COSMOS_ENDPOINT}"
  "COSMOS_DATABASE=${COSMOS_DB}"
  "STORAGE_ACCOUNT=${STORAGE_ACCOUNT}"
  "PHOTOS_CONTAINER=photos"
  "DERIVATIVES_CONTAINER=derivatives"
  "STAGING_CONTAINER=staging"
  "GIT_COMMIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  "FINDME_SEARCH_LIMIT=${FINDME_SEARCH_LIMIT:-20}"
  "FINDME_SEARCH_WINDOW_SEC=${FINDME_SEARCH_WINDOW_SEC:-60}"
  "DOWNLOAD_LIMIT_PER_DAY=${DOWNLOAD_LIMIT_PER_DAY:-50}"
  "ORIGINAL_FETCH_LIMIT=${ORIGINAL_FETCH_LIMIT:-500}"
)
[[ -n "$MATCHER_URL" ]] && ENV_VARS+=("MATCHER_URL=${MATCHER_URL}")
[[ -n "${MASTER_SPREADSHEET_ID:-}" ]] && ENV_VARS+=("MASTER_SPREADSHEET_ID=${MASTER_SPREADSHEET_ID}")

# Key Vault secret references. The Container App pulls these at runtime using its
# managed identity (Key Vault Secrets User), so secrets never sit in env dumps —
# the Azure equivalent of Cloud Run --set-secrets.
KV_URI="https://${KEY_VAULT}.vault.azure.net/secrets"
SECRETS=(
  "sync-trigger-token=keyvaultref:${KV_URI}/SYNC-TRIGGER-TOKEN,identityref:${API_ID}"
  "consent-policy-version=keyvaultref:${KV_URI}/CONSENT-POLICY-VERSION,identityref:${API_ID}"
  "recaptcha-key=keyvaultref:${KV_URI}/RECAPTCHA-KEY,identityref:${API_ID}"
)
SECRET_ENV=(
  "SYNC_TRIGGER_TOKEN=secretref:sync-trigger-token"
  "CONSENT_POLICY_VERSION=secretref:consent-policy-version"
  "RECAPTCHA_KEY=secretref:recaptcha-key"
)

if az containerapp show -g "$RESOURCE_GROUP" -n "$APP" >/dev/null 2>&1; then
  echo "==> Updating existing Container App $APP"
  az containerapp registry set -g "$RESOURCE_GROUP" -n "$APP" \
    --server "$LOGIN_SERVER" --identity "$API_ID" -o none
  az containerapp secret set -g "$RESOURCE_GROUP" -n "$APP" --secrets "${SECRETS[@]}" -o none
  az containerapp update -g "$RESOURCE_GROUP" -n "$APP" \
    --image "$IMAGE" \
    --set-env-vars "${ENV_VARS[@]}" "${SECRET_ENV[@]}" -o none
else
  echo "==> Creating Container App $APP (external ingress, scale-to-zero)"
  az containerapp create -g "$RESOURCE_GROUP" -n "$APP" \
    --environment "$ACA_ENV" \
    --image "$IMAGE" \
    --registry-server "$LOGIN_SERVER" --registry-identity "$API_ID" \
    --user-assigned "$API_ID" \
    --ingress external --target-port 8080 \
    --min-replicas 0 --max-replicas 10 \
    --cpu 0.5 --memory 1.0Gi \
    --secrets "${SECRETS[@]}" \
    --env-vars "${ENV_VARS[@]}" "${SECRET_ENV[@]}" -o none
fi

URL="https://$(az containerapp show -g "$RESOURCE_GROUP" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)"
echo "==> Deployed:  $URL"
echo "==> Smoke test (GET /api/health):"
HEALTH_CODE="$(curl -s -o /tmp/api_health.json -w '%{http_code}' "$URL/api/health" || echo 000)"
cat /tmp/api_health.json 2>/dev/null; echo
case "$HEALTH_CODE" in
  200)     echo "==> Smoke test OK (200).";;
  401|403) echo "==> Service up and auth-gated (HTTP $HEALTH_CODE).";;
  *)       echo "ERROR: /api/health returned HTTP $HEALTH_CODE — deploy may be unhealthy." >&2; exit 1;;
esac

echo
echo "Link this app as the Static Web App backend so /api/** routes to it:"
echo "  az staticwebapp backends link -n <swa-name> -g $RESOURCE_GROUP \\"
echo "    --backend-resource-id \$(az containerapp show -g $RESOURCE_GROUP -n $APP --query id -o tsv) \\"
echo "    --backend-region $LOCATION"
