#!/usr/bin/env bash
#
# provision-sync-scheduler.sh — daily "Sync with Drive" reconcile trigger.
# Azure counterpart of the Cloud Scheduler job. Implemented as a Container Apps
# JOB with a Schedule trigger (cron, UTC) that POSTs /api/admin/sync on the api,
# authorized with the shared SYNC_TRIGGER_TOKEN header (routes/sync.ts).
#
# Usage:
#   ./infra/scripts/provision-sync-scheduler.sh [resource-group] [location]
#
# The token is read from Key Vault at job runtime (secret SYNC-TRIGGER-TOKEN),
# so it never appears on the command line. Idempotent — re-running updates the
# job in place. Schedule jobs scale to zero between fires (no idle cost).

set -euo pipefail

RESOURCE_GROUP="${1:-${RESOURCE_GROUP:-mmr-photos-rg}}"
LOCATION="${2:-${LOCATION:-eastus}}"
SUFFIX="${NAME_SUFFIX:-$(echo "$RESOURCE_GROUP" | tr -cd 'a-z0-9' | cut -c1-12)}"

JOB="sync-scheduler"
ACA_ENV="${ACA_ENV:-cae-mmr-photos}"
KEY_VAULT="${KEY_VAULT:-kv-mmr-${SUFFIX}}"
API_APP="${API_APP:-event-photo-api}"
CRON="${SYNC_CRON:-0 9 * * *}"   # 09:00 UTC daily

API_FQDN="$(az containerapp show -g "$RESOURCE_GROUP" -n "$API_APP" --query properties.configuration.ingress.fqdn -o tsv)"
API_URL="https://${API_FQDN}/api/admin/sync"

# A dedicated identity that may read the token secret from Key Vault.
SCHED_ID="$(az identity show -g "$RESOURCE_GROUP" -n id-api-runtime --query id -o tsv)"
KV_URI="https://${KEY_VAULT}.vault.azure.net/secrets/SYNC-TRIGGER-TOKEN"

CMD='sh'
ARGS="-c|curl -fsS -X POST -H \"Content-Type: application/json\" -H \"X-Sync-Token: \$SYNC_TRIGGER_TOKEN\" -d '{}' ${API_URL}"

if az containerapp job show -g "$RESOURCE_GROUP" -n "$JOB" >/dev/null 2>&1; then
  echo "==> Updating schedule on $JOB -> '$CRON'"
  az containerapp job update -g "$RESOURCE_GROUP" -n "$JOB" --cron-expression "$CRON" -o none
else
  echo "==> Creating scheduled job $JOB ('$CRON', UTC) -> POST $API_URL"
  az containerapp job create -g "$RESOURCE_GROUP" -n "$JOB" \
    --environment "$ACA_ENV" \
    --trigger-type Schedule --cron-expression "$CRON" \
    --replica-timeout 300 --replica-retry-limit 1 --parallelism 1 \
    --image mcr.microsoft.com/azure-cli:latest \
    --mi-user-assigned "$SCHED_ID" \
    --secrets "sync-trigger-token=keyvaultref:${KV_URI},identityref:${SCHED_ID}" \
    --env-vars "SYNC_TRIGGER_TOKEN=secretref:sync-trigger-token" \
    --command "$CMD" --args "$ARGS" -o none
fi

echo "==> Done. Test an immediate run:"
echo "    az containerapp job start -g $RESOURCE_GROUP -n $JOB"
