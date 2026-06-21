#!/usr/bin/env bash
#
# deploy-matcher.sh — build and deploy the matcher to Azure Container Apps.
# Azure counterpart of the GCP Cloud Run matcher service.
#
# Usage:
#   ./infra/scripts/deploy-matcher.sh [resource-group] [location]
#
# The matcher has INTERNAL ingress: it is only reachable from inside the
# Container Apps environment (i.e. by the api), never from the public internet.
# This replaces the GCP "private service + IAM ID token" model with simpler
# network isolation — no token minting needed for api -> matcher calls.
# min-replicas=0 keeps idle cost at $0; raise to 1 before event weekends to
# avoid the model-load cold start (see CLAUDE.md / dev plan §8).
#
# Model weights: the ~184 MB ONNX files are baked into the image. Stage them
# in Blob Storage once and let ACR Build pull them in-cloud (so they never
# travel from a laptop), OR fetch them at build time with FETCH_MODELS=1.

set -euo pipefail

RESOURCE_GROUP="${1:-${RESOURCE_GROUP:-mmr-photos-rg}}"
LOCATION="${2:-${LOCATION:-eastus}}"
SUFFIX="${NAME_SUFFIX:-$(echo "$RESOURCE_GROUP" | tr -cd 'a-z0-9' | cut -c1-12)}"

APP="matcher"
ACR_NAME="${ACR_NAME:-mmrphotosacr${SUFFIX}}"
ACA_ENV="${ACA_ENV:-cae-mmr-photos}"
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-mmrphotos${SUFFIX}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

TAG="$(date +%Y%m%d-%H%M%S)"
LOGIN_SERVER="${ACR_NAME}.azurecr.io"
IMAGE="${LOGIN_SERVER}/${APP}:${TAG}"

echo "==> Building matcher image in ACR (context: matcher/): $IMAGE"
# FETCH_MODELS=1 makes the Dockerfile download weights during the in-cloud build.
# Pass the model URLs (or pre-stage model_files/ in the build context).
az acr build --registry "$ACR_NAME" --image "${APP}:${TAG}" \
  --build-arg FETCH_MODELS="${FETCH_MODELS:-1}" \
  --build-arg OSNET_URL="${OSNET_URL:-}" \
  --build-arg YOLO_URL="${YOLO_URL:-}" \
  --file Dockerfile "$REPO_ROOT/matcher"

MATCHER_ID="$(az identity show -g "$RESOURCE_GROUP" -n id-matcher-runtime --query id -o tsv)"
MATCHER_CLIENT_ID="$(az identity show -g "$RESOURCE_GROUP" -n id-matcher-runtime --query clientId -o tsv)"

# EMBEDDINGS_ROOT points at the derivatives Blob container. store.py reads
# embeddings via AAD (managed identity) — see AZURE.md storage migration note.
ENV_VARS=(
  "AZURE_CLIENT_ID=${MATCHER_CLIENT_ID}"
  "STORAGE_ACCOUNT=${STORAGE_ACCOUNT}"
  "EMBEDDINGS_ROOT=https://${STORAGE_ACCOUNT}.blob.core.windows.net/derivatives"
)

if az containerapp show -g "$RESOURCE_GROUP" -n "$APP" >/dev/null 2>&1; then
  echo "==> Updating existing Container App $APP"
  az containerapp registry set -g "$RESOURCE_GROUP" -n "$APP" \
    --server "$LOGIN_SERVER" --identity "$MATCHER_ID" -o none
  az containerapp update -g "$RESOURCE_GROUP" -n "$APP" \
    --image "$IMAGE" --set-env-vars "${ENV_VARS[@]}" -o none
else
  echo "==> Creating Container App $APP (INTERNAL ingress, scale-to-zero)"
  az containerapp create -g "$RESOURCE_GROUP" -n "$APP" \
    --environment "$ACA_ENV" \
    --image "$IMAGE" \
    --registry-server "$LOGIN_SERVER" --registry-identity "$MATCHER_ID" \
    --user-assigned "$MATCHER_ID" \
    --ingress internal --target-port 8080 \
    --min-replicas 0 --max-replicas 3 \
    --cpu 2.0 --memory 4.0Gi \
    --env-vars "${ENV_VARS[@]}" -o none
fi

FQDN="$(az containerapp show -g "$RESOURCE_GROUP" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)"
echo
echo "==> Deployed (internal):  https://${FQDN}"
echo "    The api auto-resolves this as MATCHER_URL on its next deploy."
echo "    Smoke test from inside the env, e.g. exec into the api container:"
echo "      curl https://${FQDN}/healthz"
