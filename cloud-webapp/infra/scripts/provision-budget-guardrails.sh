#!/usr/bin/env bash
#
# provision-budget-guardrails.sh — runbook Phase J (cost guardrails).
#
#   J1: $10/mo budget with 50/90/100% email alerts. Expected steady-state
#       spend is $0 (zero-cost design, Phase F) — any alert means something
#       drifted out of free tier (Artifact Registry >0.5 GB, GCS egress).
#   J2: verify Cloud Run max-instances caps on every service in the project.
#
# Usage:
#   ./infra/scripts/provision-budget-guardrails.sh [project-id] [region]
#
# Idempotent: re-running updates nothing if the budget already exists.
# Requires roles/billing.admin (or costsManager) on the billing account.

set -euo pipefail

PROJECT_ID="${1:-mmr-data-pipeline}"
REGION="${2:-us-central1}"
BUDGET_NAME="findme-monthly-cap"
BUDGET_USD="${BUDGET_USD:-10}"
MAX_INSTANCES_CAP="${MAX_INSTANCES_CAP:-10}"

echo "==> Looking up billing account for $PROJECT_ID"
BILLING_ACCOUNT="$(gcloud billing projects describe "$PROJECT_ID" \
  --format='value(billingAccountName)' | sed 's|billingAccounts/||')"
if [[ -z "$BILLING_ACCOUNT" ]]; then
  echo "ERROR: no billing account linked to $PROJECT_ID" >&2
  exit 1
fi
echo "    billing account: $BILLING_ACCOUNT"

echo "==> Enabling Billing Budgets API (idempotent)"
gcloud services enable billingbudgets.googleapis.com --project="$PROJECT_ID"

echo "==> J1: budget '$BUDGET_NAME' (\$${BUDGET_USD}/mo, alerts at 50/90/100%)"
EXISTING="$(gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" \
  --filter="displayName=$BUDGET_NAME" --format='value(name)' || true)"
if [[ -n "$EXISTING" ]]; then
  echo "    already exists: $EXISTING — leaving as-is"
else
  # Scoped to this project only, so alerts aren't noise from other projects
  # on the same billing account. Alert emails go to Billing Account
  # Administrators/Users by default.
  gcloud billing budgets create \
    --billing-account="$BILLING_ACCOUNT" \
    --display-name="$BUDGET_NAME" \
    --budget-amount="${BUDGET_USD}USD" \
    --filter-projects="projects/$PROJECT_ID" \
    --threshold-rule=percent=0.5 \
    --threshold-rule=percent=0.9 \
    --threshold-rule=percent=1.0
  echo "    created."
fi

echo "==> J2: Cloud Run max-instances caps (region $REGION)"
FAIL=0
while IFS=$'\t' read -r svc max; do
  if [[ -z "$max" || "$max" == "0" ]]; then
    echo "    ⚠ $svc: NO max-instances cap — fixing to $MAX_INSTANCES_CAP"
    gcloud run services update "$svc" --region="$REGION" --project="$PROJECT_ID" \
      --max-instances="$MAX_INSTANCES_CAP"
  else
    echo "    ✓ $svc: max-instances=$max"
  fi
done < <(gcloud run services list --project="$PROJECT_ID" --region="$REGION" \
  --format=$'value(metadata.name,spec.template.metadata.annotations."autoscaling.knative.dev/maxScale")')

# Jobs have bounded parallelism by definition, but list them for visibility.
echo "==> Cloud Run jobs (parallelism is bounded per-execution; no cap needed):"
gcloud run jobs list --project="$PROJECT_ID" --region="$REGION" \
  --format='value(metadata.name)' | sed 's/^/    /' || true

echo
echo "Done. Mark runbook Phase J: J1 ✓ (budget) · J2 ✓ (caps) · J3 already ✓."
exit $FAIL
