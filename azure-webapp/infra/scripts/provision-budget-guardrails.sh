#!/usr/bin/env bash
#
# provision-budget-guardrails.sh — Azure cost guardrails (counterpart of the
# GCP budget + max-instances checks).
#
#   1. $10/mo Cost Management budget on the resource group with 50/90/100%
#      email alerts. Expected steady-state spend is ~$0 (scale-to-zero design),
#      so any alert means something drifted: a min-replicas>0 app, Log Analytics
#      ingestion, ACR storage >0.5 GB, or Blob egress.
#   2. Verify no Container App has min-replicas > 0 (the idle-cost trap from
#      CLAUDE.md — a warm replica bills around the clock).
#
# Usage:
#   ./infra/scripts/provision-budget-guardrails.sh [resource-group] [monthly-usd] [alert-email]

set -euo pipefail

RESOURCE_GROUP="${1:-${RESOURCE_GROUP:-mmr-photos-rg}}"
AMOUNT="${2:-10}"
EMAIL="${3:-admin@mmrunners.org}"
BUDGET_NAME="${BUDGET_NAME:-mmr-photos-monthly}"

SUB_ID="$(az account show --query id -o tsv)"
RG_SCOPE="/subscriptions/${SUB_ID}/resourceGroups/${RESOURCE_GROUP}"
START="$(date -u +%Y-%m-01)"

echo "==> Creating/updating budget '$BUDGET_NAME' (\$${AMOUNT}/mo) on $RESOURCE_GROUP"
az consumption budget create \
  --budget-name "$BUDGET_NAME" \
  --amount "$AMOUNT" \
  --category cost \
  --time-grain Monthly \
  --start-date "$START" \
  --end-date "$(date -u -d "$START +5 years" +%Y-%m-01 2>/dev/null || date -u -v+5y +%Y-%m-01)" \
  --resource-group "$RESOURCE_GROUP" \
  --notifications "{\"Actual_50\":{\"enabled\":true,\"operator\":\"GreaterThanOrEqualTo\",\"threshold\":50,\"contactEmails\":[\"${EMAIL}\"]},\"Actual_90\":{\"enabled\":true,\"operator\":\"GreaterThanOrEqualTo\",\"threshold\":90,\"contactEmails\":[\"${EMAIL}\"]},\"Actual_100\":{\"enabled\":true,\"operator\":\"GreaterThanOrEqualTo\",\"threshold\":100,\"contactEmails\":[\"${EMAIL}\"]}}" \
  -o none 2>/dev/null || echo "    (budget exists or partial update — check Cost Management in the portal)"

echo
echo "==> Idle-cost audit: any Container App with minReplicas > 0 is a warm-instance bill."
az containerapp list -g "$RESOURCE_GROUP" \
  --query "[].{name:name, minReplicas:properties.template.scale.minReplicas, maxReplicas:properties.template.scale.maxReplicas}" \
  -o table || true
echo
echo "All minReplicas should read 0 or null. If any is >0, reset it:"
echo "    az containerapp update -g $RESOURCE_GROUP -n <app> --min-replicas 0"
