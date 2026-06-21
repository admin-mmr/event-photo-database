#!/usr/bin/env bash
#
# provision-error-alert.sh — email alert on api errors (Azure counterpart of the
# GCP "event-photo-api unhandled errors" Cloud Monitoring policy).
#
# The api logs JSON to stdout via pino; Container Apps ships every line to the
# Log Analytics workspace (table ContainerAppConsoleLogs_CL). pino maps its
# levels onto a `severity` field, so an unhandled server exception
# (errorHandler -> logger.error) and a browser-side failure POSTed to
# /api/client-errors (routes/telemetry.ts -> logger.error, carrying
# "clientError":true) both surface as `"severity":"ERROR"` lines. This wires a
# scheduled-query alert on those lines to an email action group.
#
# Without this rule the /api/client-errors endpoint logs correctly but nothing
# notifies anyone — Azure has no equivalent of the GCP policy until it's created
# here.
#
# Idempotent. Safe to re-run (creates-or-updates the action group + rule).
#
# Usage:
#   ./infra/scripts/provision-error-alert.sh [resource-group] [alert-email] [log-workspace]
#
# Example:
#   ./infra/scripts/provision-error-alert.sh mmr-photos-rg it-ai@youth4am.org

set -euo pipefail

RESOURCE_GROUP="${1:-${RESOURCE_GROUP:-mmr-photos-rg}}"
EMAIL="${2:-${ALERT_EMAIL:-admin@mmrunners.org}}"
LOG_WORKSPACE="${3:-${LOG_WORKSPACE:-law-mmr-photos}}"

APP="${APP:-event-photo-api}"
ACTION_GROUP="${ACTION_GROUP:-ag-mmr-photos-alerts}"
ACTION_GROUP_SHORT="${ACTION_GROUP_SHORT:-mmrAlerts}"
RULE_NAME="${RULE_NAME:-event-photo-api-errors}"

echo "==> Resource group: $RESOURCE_GROUP  workspace: $LOG_WORKSPACE  app: $APP"
echo "==> Alert email: $EMAIL"

WORKSPACE_ID="$(az monitor log-analytics workspace show -g "$RESOURCE_GROUP" -n "$LOG_WORKSPACE" --query id -o tsv)"
if [[ -z "$WORKSPACE_ID" ]]; then
  echo "!!! Log Analytics workspace '$LOG_WORKSPACE' not found in '$RESOURCE_GROUP'." >&2
  echo "    Run bootstrap-azure.sh first, or pass the workspace name as arg 3." >&2
  exit 1
fi

echo "==> Creating/updating action group '$ACTION_GROUP' (email receiver)"
az monitor action-group create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$ACTION_GROUP" \
  --short-name "$ACTION_GROUP_SHORT" \
  --action email ops "$EMAIL" \
  -o none
ACTION_GROUP_ID="$(az monitor action-group show -g "$RESOURCE_GROUP" -n "$ACTION_GROUP" --query id -o tsv)"

# KQL: any ERROR-severity line from the api in the look-back window. This covers
# BOTH server exceptions and client-error reports. To alert on client-side
# failures ONLY, append:  | where Log_s has '"clientError":true'
read -r -d '' QUERY <<'KQL' || true
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "event-photo-api"
| where Log_s has '"severity":"ERROR"'
KQL

echo "==> Creating/updating scheduled-query alert '$RULE_NAME'"
# severity 2 = Warning; window/frequency 5m mirrors the GCP policy's 300s
# notificationRateLimit, and --mute-actions-duration PT30M mirrors its 1800s
# autoClose so a burst of errors doesn't flood the inbox.
az monitor scheduled-query create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$RULE_NAME" \
  --scopes "$WORKSPACE_ID" \
  --description "An ERROR-severity log line was emitted by $APP (an unhandled server exception, or a browser-side failure reported to /api/client-errors). Open the alert to see the log entry." \
  --condition "count 'Errors' > 0" \
  --condition-query Errors="$QUERY" \
  --evaluation-frequency 5m \
  --window-size 5m \
  --severity 2 \
  --mute-actions-duration PT30M \
  --action-groups "$ACTION_GROUP_ID" \
  -o none

echo
echo "==> Done. Verify with:"
echo "    az monitor scheduled-query show -g $RESOURCE_GROUP -n $RULE_NAME -o yaml"
echo
echo "NOTE: Container App console logs can take a few minutes to land in Log"
echo "      Analytics, so a freshly-triggered error may not fire the alert"
echo "      instantly. To alert on CLIENT-side failures only, edit the KQL to add"
echo "      a \`| where Log_s has '\"clientError\":true'\` line and re-run."
