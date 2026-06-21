#!/usr/bin/env bash
#
# provision-runtime-identities.sh — create least-privilege user-assigned
# Managed Identities for the three runtimes and grant their RBAC roles.
# Azure counterpart of the old provision-runtime-sas.sh (GCP service accounts).
# Idempotent — safe to re-run.
#
# Usage:
#   ./infra/scripts/provision-runtime-identities.sh [resource-group] [location]
#
# Identity -> role mapping (least privilege):
#   id-api-runtime      Cosmos DB Data Contributor, Storage Blob Data Contributor,
#                       Key Vault Secrets User, can trigger the indexer job
#   id-matcher-runtime  Storage Blob Data Reader (reads embeddings only)
#   id-indexer-runtime  Cosmos DB Data Contributor, Storage Blob Data Contributor

set -euo pipefail

RESOURCE_GROUP="${1:-${RESOURCE_GROUP:-mmr-photos-rg}}"
LOCATION="${2:-${LOCATION:-eastus}}"
SUFFIX="${NAME_SUFFIX:-$(echo "$RESOURCE_GROUP" | tr -cd 'a-z0-9' | cut -c1-12)}"
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-mmrphotos${SUFFIX}}"
COSMOS_ACCOUNT="${COSMOS_ACCOUNT:-cosmos-mmr-${SUFFIX}}"
KEY_VAULT="${KEY_VAULT:-kv-mmr-${SUFFIX}}"

SUB_ID="$(az account show --query id -o tsv)"
RG_SCOPE="/subscriptions/${SUB_ID}/resourceGroups/${RESOURCE_GROUP}"
SA_SCOPE="${RG_SCOPE}/providers/Microsoft.Storage/storageAccounts/${STORAGE_ACCOUNT}"
KV_SCOPE="${RG_SCOPE}/providers/Microsoft.KeyVault/vaults/${KEY_VAULT}"

make_identity () { # name -> echoes principalId
  local name="$1"
  az identity show -g "$RESOURCE_GROUP" -n "$name" >/dev/null 2>&1 || \
    az identity create -g "$RESOURCE_GROUP" -n "$name" --location "$LOCATION" -o none
  az identity show -g "$RESOURCE_GROUP" -n "$name" --query principalId -o tsv
}

assign () { # principalId role scope
  az role assignment create --assignee-object-id "$1" --assignee-principal-type ServicePrincipal \
    --role "$2" --scope "$3" -o none 2>/dev/null || true
}

echo "==> Creating user-assigned managed identities"
API_PID="$(make_identity id-api-runtime)"
MATCHER_PID="$(make_identity id-matcher-runtime)"
INDEXER_PID="$(make_identity id-indexer-runtime)"

echo "==> Storage (Blob) role assignments"
assign "$API_PID"     "Storage Blob Data Contributor" "$SA_SCOPE"
assign "$INDEXER_PID" "Storage Blob Data Contributor" "$SA_SCOPE"
assign "$MATCHER_PID" "Storage Blob Data Reader"      "$SA_SCOPE"

echo "==> Key Vault role assignments (api reads secrets)"
assign "$API_PID" "Key Vault Secrets User" "$KV_SCOPE"

echo "==> Cosmos DB data-plane role assignments (NoSQL built-in Data Contributor = 00000000-0000-0000-0000-000000000002)"
# Cosmos uses its OWN data-plane RBAC, not Azure RBAC, for document read/write.
for pid in "$API_PID" "$INDEXER_PID"; do
  az cosmosdb sql role assignment create -a "$COSMOS_ACCOUNT" -g "$RESOURCE_GROUP" \
    --role-definition-id "00000000-0000-0000-0000-000000000002" \
    --principal-id "$pid" \
    --scope "/" -o none 2>/dev/null || true
done

cat <<EOF

==> Identities ready. Resource IDs to pass to the deploy scripts:
  api:     $(az identity show -g "$RESOURCE_GROUP" -n id-api-runtime --query id -o tsv)
  matcher: $(az identity show -g "$RESOURCE_GROUP" -n id-matcher-runtime --query id -o tsv)
  indexer: $(az identity show -g "$RESOURCE_GROUP" -n id-indexer-runtime --query id -o tsv)

The deploy-*.sh scripts resolve these by name, so no manual wiring is needed.
For the indexer's Google Drive access (Drive is staying on Google), store the
service-account JSON / OAuth client in Key Vault and mount it as a secret — see
verify-drive-access.sh and AZURE.md "Drive access on Azure".
EOF
