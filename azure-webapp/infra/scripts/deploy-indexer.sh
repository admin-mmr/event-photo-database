#!/usr/bin/env bash
#
# deploy-indexer.sh — build and deploy the photo-indexer as an Azure Container
# Apps JOB. Azure counterpart of the GCP Cloud Run Job.
#
# Usage:
#   ./infra/scripts/deploy-indexer.sh [resource-group] [location]
#
# Trigger type "Manual": one execution = one event, started on demand by the api
# (or by the scheduled wrapper, see provision-index-scan-scheduler.sh). Jobs bill
# only while a replica runs, so idle cost is $0 (CLAUDE.md) with no schedule that
# fires when there's no work.
#
# Run an indexing execution manually (per-event env override):
#   az containerapp job start -g <rg> -n photo-indexer \
#     --env-vars EVENT_ID=<eventId>

set -euo pipefail

RESOURCE_GROUP="${1:-${RESOURCE_GROUP:-mmr-photos-rg}}"
LOCATION="${2:-${LOCATION:-eastus}}"
SUFFIX="${NAME_SUFFIX:-$(echo "$RESOURCE_GROUP" | tr -cd 'a-z0-9' | cut -c1-12)}"

JOB="photo-indexer"
ACR_NAME="${ACR_NAME:-mmrphotosacr${SUFFIX}}"
ACA_ENV="${ACA_ENV:-cae-mmr-photos}"
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-mmrphotos${SUFFIX}}"
COSMOS_ACCOUNT="${COSMOS_ACCOUNT:-cosmos-mmr-${SUFFIX}}"
COSMOS_DB="${COSMOS_DB:-eventphotos}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

TAG="$(date +%Y%m%d-%H%M%S)"
LOGIN_SERVER="${ACR_NAME}.azurecr.io"
IMAGE="${LOGIN_SERVER}/${JOB}:${TAG}"

echo "==> Building indexer image in ACR (context: repo root): $IMAGE"
# The indexer Dockerfile COPYs matcher modules + model weights; FETCH_MODELS=1
# pulls weights during the in-cloud build.
az acr build --registry "$ACR_NAME" --image "${JOB}:${TAG}" \
  --build-arg FETCH_MODELS="${FETCH_MODELS:-1}" \
  --file indexer/Dockerfile "$REPO_ROOT"

INDEXER_ID="$(az identity show -g "$RESOURCE_GROUP" -n id-indexer-runtime --query id -o tsv)"
INDEXER_CLIENT_ID="$(az identity show -g "$RESOURCE_GROUP" -n id-indexer-runtime --query clientId -o tsv)"
COSMOS_ENDPOINT="$(az cosmosdb show -n "$COSMOS_ACCOUNT" -g "$RESOURCE_GROUP" --query documentEndpoint -o tsv)"

ENV_VARS=(
  "AZURE_CLIENT_ID=${INDEXER_CLIENT_ID}"
  "STORAGE_ACCOUNT=${STORAGE_ACCOUNT}"
  "DERIVATIVES_ROOT=https://${STORAGE_ACCOUNT}.blob.core.windows.net/derivatives"
  "COSMOS_ENDPOINT=${COSMOS_ENDPOINT}"
  "COSMOS_DATABASE=${COSMOS_DB}"
  "INDEX_CONCURRENCY=${INDEX_CONCURRENCY:-8}"
)

if az containerapp job show -g "$RESOURCE_GROUP" -n "$JOB" >/dev/null 2>&1; then
  echo "==> Updating existing Container Apps Job $JOB"
  az containerapp job registry set -g "$RESOURCE_GROUP" -n "$JOB" \
    --server "$LOGIN_SERVER" --identity "$INDEXER_ID" -o none 2>/dev/null || true
  az containerapp job update -g "$RESOURCE_GROUP" -n "$JOB" \
    --image "$IMAGE" \
    --cpu 4.0 --memory 8.0Gi \
    --replica-timeout 7200 --replica-retry-limit 1 \
    --set-env-vars "${ENV_VARS[@]}" -o none
else
  echo "==> Creating Container Apps Job $JOB (Manual trigger, scale-to-zero)"
  az containerapp job create -g "$RESOURCE_GROUP" -n "$JOB" \
    --environment "$ACA_ENV" \
    --trigger-type Manual \
    --replica-timeout 7200 --replica-retry-limit 1 --parallelism 1 \
    --image "$IMAGE" \
    --registry-server "$LOGIN_SERVER" --registry-identity "$INDEXER_ID" \
    --mi-user-assigned "$INDEXER_ID" \
    --cpu 4.0 --memory 8.0Gi \
    --env-vars "${ENV_VARS[@]}" -o none
fi

cat <<EOF

==> Deployed. Index one event:
    az containerapp job start -g $RESOURCE_GROUP -n $JOB \\
      --env-vars EVENT_ID=<eventId>

Watch executions:
    az containerapp job execution list -g $RESOURCE_GROUP -n $JOB -o table

Prereq: the event must have a driveFolderId. Run a "Sync with Drive"
(POST /api/admin/sync) to import it, or pass DRIVE_FOLDER_ID=<id> in --env-vars.
NOTE: ACA Jobs bill the full instance lifetime per execution; 4 vCPU / 8 GiB is
the cost/speed default — see CLAUDE.md "Indexer speed vs. free tier".
EOF
