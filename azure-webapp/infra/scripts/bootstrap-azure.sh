#!/usr/bin/env bash
#
# bootstrap-azure.sh — one-time provisioning of the Azure footprint for the
# event-photo stack. This is the Azure counterpart of the old bootstrap-gcp.sh.
#
# It is idempotent: every `az ... create` is guarded so re-running only fills in
# what's missing. Run it once per environment (e.g. prod), then use the
# deploy-*.sh scripts for app revisions.
#
# Usage:
#   ./infra/scripts/bootstrap-azure.sh [resource-group] [location]
#
# Defaults come from env vars if set (see the block below), else the literals.
#
# Service mapping (GCP -> Azure), see AZURE.md for the full rationale:
#   Cloud Run service (api, matcher)  -> Azure Container Apps (Consumption)
#   Cloud Run Job     (indexer)       -> Azure Container Apps Job
#   Firebase Hosting  (web)           -> Azure Static Web Apps (Free)
#   Firestore                         -> Azure Cosmos DB (NoSQL API, serverless)
#   Cloud Storage                     -> Azure Blob Storage
#   Secret Manager                    -> Azure Key Vault
#   Artifact Registry / Cloud Build   -> Azure Container Registry + ACR Tasks
#   Cloud Logging                     -> Log Analytics + Application Insights
#   IAM service accounts              -> user-assigned Managed Identities
#
# COST POLICY (see ../../CLAUDE.md): every compute resource must scale to zero
# when idle. Container Apps on the Consumption plan bill $0 at zero replicas, so
# we NEVER set --min-replicas > 0 here. Cosmos DB is provisioned in *serverless*
# mode (pay per request unit, no idle floor). The single unavoidable standing
# cost is the Log Analytics workspace ingestion — keep retention low.

set -euo pipefail

RESOURCE_GROUP="${1:-${RESOURCE_GROUP:-mmr-photos-rg}}"
LOCATION="${2:-${LOCATION:-eastus}}"

# Globally-unique names. Override via env if these collide. Lowercase,
# alphanumeric only for ACR / storage / cosmos.
SUFFIX="${NAME_SUFFIX:-$(echo "$RESOURCE_GROUP" | tr -cd 'a-z0-9' | cut -c1-12)}"
ACR_NAME="${ACR_NAME:-mmrphotosacr${SUFFIX}}"
ACA_ENV="${ACA_ENV:-cae-mmr-photos}"
LOG_WORKSPACE="${LOG_WORKSPACE:-law-mmr-photos}"
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-mmrphotos${SUFFIX}}"
COSMOS_ACCOUNT="${COSMOS_ACCOUNT:-cosmos-mmr-${SUFFIX}}"
COSMOS_DB="${COSMOS_DB:-eventphotos}"
KEY_VAULT="${KEY_VAULT:-kv-mmr-${SUFFIX}}"
APP_INSIGHTS="${APP_INSIGHTS:-appi-mmr-photos}"

echo "==> Subscription / context"
az account show --query '{subscription:name, id:id, user:user.name}' -o table

echo "==> Resource group: $RESOURCE_GROUP ($LOCATION)"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" -o none

echo "==> Container Registry: $ACR_NAME (Basic, admin disabled — we use managed identity)"
az acr show --name "$ACR_NAME" >/dev/null 2>&1 || \
  az acr create --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" \
    --sku Basic --admin-enabled false -o none

echo "==> Log Analytics workspace: $LOG_WORKSPACE (30-day retention to cap ingestion cost)"
az monitor log-analytics workspace show -g "$RESOURCE_GROUP" -n "$LOG_WORKSPACE" >/dev/null 2>&1 || \
  az monitor log-analytics workspace create -g "$RESOURCE_GROUP" -n "$LOG_WORKSPACE" \
    --retention-time 30 -o none
LAW_ID="$(az monitor log-analytics workspace show -g "$RESOURCE_GROUP" -n "$LOG_WORKSPACE" --query customerId -o tsv)"
LAW_KEY="$(az monitor log-analytics workspace get-shared-keys -g "$RESOURCE_GROUP" -n "$LOG_WORKSPACE" --query primarySharedKey -o tsv)"

echo "==> Application Insights: $APP_INSIGHTS"
az extension add --name application-insights --only-show-errors >/dev/null 2>&1 || true
az monitor app-insights component show --app "$APP_INSIGHTS" -g "$RESOURCE_GROUP" >/dev/null 2>&1 || \
  az monitor app-insights component create --app "$APP_INSIGHTS" -g "$RESOURCE_GROUP" \
    --location "$LOCATION" --workspace "$LOG_WORKSPACE" -o none

echo "==> Container Apps environment: $ACA_ENV (Consumption — scales to zero)"
az containerapp env show -g "$RESOURCE_GROUP" -n "$ACA_ENV" >/dev/null 2>&1 || \
  az containerapp env create -g "$RESOURCE_GROUP" -n "$ACA_ENV" --location "$LOCATION" \
    --logs-workspace-id "$LAW_ID" --logs-workspace-key "$LAW_KEY" -o none

echo "==> Storage account: $STORAGE_ACCOUNT (Standard LRS, hot tier)"
az storage account show -n "$STORAGE_ACCOUNT" -g "$RESOURCE_GROUP" >/dev/null 2>&1 || \
  az storage account create -n "$STORAGE_ACCOUNT" -g "$RESOURCE_GROUP" --location "$LOCATION" \
    --sku Standard_LRS --kind StorageV2 --access-tier Hot \
    --allow-blob-public-access false --min-tls-version TLS1_2 -o none
# Photo + derivative containers (mirror the two GCS buckets: -photos, -derivatives,
# plus a staging container for volunteer uploads).
for c in photos derivatives staging; do
  az storage container create --account-name "$STORAGE_ACCOUNT" --name "$c" \
    --auth-mode login -o none 2>/dev/null || true
done

echo "==> Cosmos DB (NoSQL API, SERVERLESS — no idle cost): $COSMOS_ACCOUNT"
az cosmosdb show -n "$COSMOS_ACCOUNT" -g "$RESOURCE_GROUP" >/dev/null 2>&1 || \
  az cosmosdb create -n "$COSMOS_ACCOUNT" -g "$RESOURCE_GROUP" \
    --locations regionName="$LOCATION" --capabilities EnableServerless -o none
az cosmosdb sql database show -a "$COSMOS_ACCOUNT" -g "$RESOURCE_GROUP" -n "$COSMOS_DB" >/dev/null 2>&1 || \
  az cosmosdb sql database create -a "$COSMOS_ACCOUNT" -g "$RESOURCE_GROUP" -n "$COSMOS_DB" -o none
# Containers mirror the Firestore top-level collections. Partition keys chosen
# for the common query shape (see infra/cosmos-access-notes.md).
create_container () { # name partitionKey
  az cosmosdb sql container show -a "$COSMOS_ACCOUNT" -g "$RESOURCE_GROUP" -d "$COSMOS_DB" -n "$1" >/dev/null 2>&1 || \
    az cosmosdb sql container create -a "$COSMOS_ACCOUNT" -g "$RESOURCE_GROUP" -d "$COSMOS_DB" \
      -n "$1" --partition-key-path "$2" -o none
}
create_container events       "/id"
create_container clubs        "/id"
create_container photos       "/eventId"
create_container uploadLinks  "/token"
create_container auditLog     "/day"

echo "==> Key Vault: $KEY_VAULT (RBAC authorization)"
az keyvault show -n "$KEY_VAULT" -g "$RESOURCE_GROUP" >/dev/null 2>&1 || \
  az keyvault create -n "$KEY_VAULT" -g "$RESOURCE_GROUP" --location "$LOCATION" \
    --enable-rbac-authorization true -o none
echo "    Seed secrets later, e.g.:"
echo "      az keyvault secret set --vault-name $KEY_VAULT --name SYNC-TRIGGER-TOKEN --value <token>"
echo "      az keyvault secret set --vault-name $KEY_VAULT --name RECAPTCHA-KEY --value <key>"
echo "      az keyvault secret set --vault-name $KEY_VAULT --name CONSENT-POLICY-VERSION --value v1"

cat <<EOF

==> Bootstrap complete. Resource group: $RESOURCE_GROUP

Next:
  1. ./infra/scripts/provision-runtime-identities.sh $RESOURCE_GROUP
     (creates managed identities + RBAC for api / matcher / indexer)
  2. ./infra/scripts/deploy-matcher.sh  $RESOURCE_GROUP
  3. ./infra/scripts/deploy-api.sh      $RESOURCE_GROUP
  4. ./infra/scripts/deploy-indexer.sh  $RESOURCE_GROUP
  5. ./infra/scripts/deploy-web.sh      $RESOURCE_GROUP

Names (export to reuse across scripts):
  export RESOURCE_GROUP=$RESOURCE_GROUP LOCATION=$LOCATION
  export ACR_NAME=$ACR_NAME ACA_ENV=$ACA_ENV
  export STORAGE_ACCOUNT=$STORAGE_ACCOUNT COSMOS_ACCOUNT=$COSMOS_ACCOUNT
  export COSMOS_DB=$COSMOS_DB KEY_VAULT=$KEY_VAULT
EOF
