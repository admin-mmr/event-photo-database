#!/usr/bin/env bash
#
# event-scale.sh — put the photo plane into (or out of) "big event" mode.
#
# Written for the NYC Marathon (2026-11-01, up to 500k photos into one event).
# Everything here is TEMPORARY and reversible; the permanent sizing (api 4Gi,
# indexer 32Gi/24h, matcher 16Gi) lives in the deploy scripts and is NOT touched.
#
#   up     queue concurrency 10 / 10 attempts / 1h backoff;
#          staging lifecycle 30 days (Drive ingest runs for days — Google caps
#            one account at 750 GB/day ≈ 120k photos — and a staged photo is the
#            only copy until it reaches Drive);
#          api: MANAGED_FOLDERS_ENABLED=false (every batch otherwise rebuilds
#            EVERY Photos_NNN folder of the event — O(event) Drive writes per
#            batch) and VOLUNTEER_UPLOAD_LIMIT=20000 (a link shared by several
#            photographers would hit the 2000/h default);
#          matcher min-instances=1 — the scheduled warm window CLAUDE.md allows
#            (a cold load of a big event outlasts the 60s Hosting cap);
#          budget alert raised so it measures the event instead of firing day 1.
#   down   reverse all of that, EXCEPT the queue (stays at 10 — the live value
#          before this was the Cloud Tasks default of 1000, which OOM-packs the
#          api). Run it only when the staging bucket has drained (`status`).
#          Re-enabling managed folders does not rebuild them; queue the "All
#          events → Photos / Videos+Albums" rebuild from /admin afterwards.
#   status print the live values this script manages.
#
# Usage: ./infra/scripts/event-scale.sh up|down|status [project-id] [region]
set -euo pipefail

MODE="${1:-status}"
PROJECT_ID="${2:-mmr-data-pipeline}"
REGION="${3:-us-central1}"
QUEUE="upload-process"
STAGING="gs://${PROJECT_ID}-uploads-staging"
BUDGET_NAME="findme-monthly-cap"
EVENT_BUDGET_USD="${EVENT_BUDGET_USD:-400}"
NORMAL_BUDGET_USD="${NORMAL_BUDGET_USD:-20}"
QUEUE_CONCURRENCY="${QUEUE_CONCURRENCY:-10}"

lifecycle() {
  local days="$1" f
  f="$(mktemp)"
  cat >"$f" <<EOF
{ "rule": [
  { "action": {"type": "Delete"}, "condition": {"age": ${days}} },
  { "action": {"type": "AbortIncompleteMultipartUpload"}, "condition": {"age": 7} }
] }
EOF
  gcloud storage buckets update "$STAGING" --lifecycle-file="$f" --project="$PROJECT_ID"
  rm -f "$f"
}

budget() {
  local usd="$1" billing name
  billing="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingAccountName)' | sed 's|billingAccounts/||')"
  name="$(gcloud billing budgets list --billing-account="$billing" --filter="displayName=$BUDGET_NAME" --format='value(name)')"
  if [[ -z "$name" ]]; then
    echo "    no '$BUDGET_NAME' budget found — skipping (provision-budget-guardrails.sh creates it)" >&2
    return
  fi
  gcloud billing budgets update "$name" --billing-account="$billing" --budget-amount="${usd}USD"
}

status() {
  echo "== queue $QUEUE"
  gcloud tasks queues describe "$QUEUE" --location="$REGION" --project="$PROJECT_ID" \
    --format='table(rateLimits.maxDispatchesPerSecond:label=RATE, rateLimits.maxConcurrentDispatches:label=CONCURRENT, retryConfig.maxAttempts:label=ATTEMPTS, retryConfig.maxBackoff:label=MAX_BACKOFF)'
  echo "== staging lifecycle + depth (should drain to ~0 before 'down')"
  gcloud storage buckets describe "$STAGING" --format='value(lifecycle_config.rule[0].condition.age)' | sed 's/^/    delete after days: /'
  gcloud storage du -s "$STAGING" | awk '{printf "    staged bytes: %.2f GiB\n", $1/1073741824}'
  echo "== api env"
  gcloud run services describe event-photo-api --region="$REGION" --project="$PROJECT_ID" --format=json |
    python3 -c 'import json,sys; [print("   ",e["name"],"=",e.get("value")) for e in json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0]["env"] if e["name"] in ("MANAGED_FOLDERS_ENABLED","VOLUNTEER_UPLOAD_LIMIT")]'
  echo "== services"
  gcloud run services list --region="$REGION" --project="$PROJECT_ID" \
    --format='table(metadata.name, spec.template.metadata.annotations["autoscaling.knative.dev/minScale"]:label=MIN, spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"]:label=MAX, spec.template.spec.containers[0].resources.limits.cpu:label=CPU, spec.template.spec.containers[0].resources.limits.memory:label=MEM)'
}

case "$MODE" in
  up)
    echo "==> queue: concurrency $QUEUE_CONCURRENCY, 10 attempts, backoff up to 1h"
    gcloud tasks queues update "$QUEUE" --location="$REGION" --project="$PROJECT_ID" \
      --max-concurrent-dispatches="$QUEUE_CONCURRENCY" --max-dispatches-per-second=5 \
      --max-attempts=10 --min-backoff=30s --max-backoff=3600s
    echo "==> staging lifecycle: 30 days"
    lifecycle 30
    echo "==> api: managed folders OFF, upload limit 20000/link/h"
    gcloud run services update event-photo-api --region="$REGION" --project="$PROJECT_ID" \
      --update-env-vars=MANAGED_FOLDERS_ENABLED=false,VOLUNTEER_UPLOAD_LIMIT=20000
    echo "==> matcher: warm window (min-instances=1)"
    gcloud run services update matcher --region="$REGION" --project="$PROJECT_ID" --min-instances=1
    echo "==> budget alert: \$${EVENT_BUDGET_USD}"
    budget "$EVENT_BUDGET_USD"
    ;;
  down)
    echo "==> matcher: back to scale-to-zero"
    gcloud run services update matcher --region="$REGION" --project="$PROJECT_ID" --min-instances=0
    echo "==> api: managed folders ON, default upload limit"
    gcloud run services update event-photo-api --region="$REGION" --project="$PROJECT_ID" \
      --update-env-vars=MANAGED_FOLDERS_ENABLED=true --remove-env-vars=VOLUNTEER_UPLOAD_LIMIT
    echo "==> staging lifecycle: 14 days"
    lifecycle 14
    echo "==> budget alert: \$${NORMAL_BUDGET_USD}"
    budget "$NORMAL_BUDGET_USD"
    echo "    queue left at concurrency $QUEUE_CONCURRENCY (see header)."
    echo "    Now queue the managed-folder rebuild from /admin (All events → Photos, Videos+Albums)."
    ;;
  status) ;;
  *) echo "Usage: $0 up|down|status [project-id] [region]" >&2; exit 2 ;;
esac

status
