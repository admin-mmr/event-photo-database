#!/usr/bin/env bash
#
# backfill-capture-time.sh — populate takenAt and apply the capture-time
# filename prefix across the EXISTING photo library (CAPTURE_TIME_SORT_DESIGN
# §8). It force-reindexes every event; the indexer re-reads each photo's bytes,
# writes takenAt/takenAtSource to Cosmos, and (with CAPTURE_TIME_RENAME=1)
# renames the Drive file + stamps its modifiedTime. Idempotent — safe to re-run.
#
# Azure port: triggers the photo-indexer Container Apps JOB per event with env
# overrides, instead of the Cloud Run Job.
#
# DRY RUN BY DEFAULT: prints what it would trigger. Pass --apply to execute.
#
# Usage:
#   ./infra/scripts/backfill-capture-time.sh [resource-group] [--apply] [event-id ...]
#
#   With no explicit event ids it enumerates every event (with a driveFolderId)
#   from Cosmos. Supply ids to backfill just those.
#
# Pre-reqs:
#   - az logged in as someone who can start the job + read Cosmos.
#   - photo-indexer deployed (deploy-indexer.sh).

set -euo pipefail

RESOURCE_GROUP="${1:-${RESOURCE_GROUP:-mmr-photos-rg}}"; shift || true
SUFFIX="${NAME_SUFFIX:-$(echo "$RESOURCE_GROUP" | tr -cd 'a-z0-9' | cut -c1-12)}"
COSMOS_ACCOUNT="${COSMOS_ACCOUNT:-cosmos-mmr-${SUFFIX}}"
COSMOS_DB="${COSMOS_DB:-eventphotos}"
JOB="photo-indexer"

APPLY=0
EVENT_IDS=()
for arg in "$@"; do
  if [[ "$arg" == "--apply" ]]; then APPLY=1; else EVENT_IDS+=("$arg"); fi
done

if [[ ${#EVENT_IDS[@]} -eq 0 ]]; then
  echo "==> Enumerating events with a driveFolderId from Cosmos"
  mapfile -t EVENT_IDS < <(az cosmosdb sql query \
    -a "$COSMOS_ACCOUNT" -g "$RESOURCE_GROUP" -d "$COSMOS_DB" -c events \
    --query-text "SELECT VALUE c.id FROM c WHERE IS_DEFINED(c.driveFolderId)" \
    -o tsv 2>/dev/null || true)
fi

if [[ ${#EVENT_IDS[@]} -eq 0 ]]; then
  echo "No events found to backfill." >&2; exit 0
fi

echo "==> ${#EVENT_IDS[@]} event(s) to backfill (apply=$APPLY)"
for eid in "${EVENT_IDS[@]}"; do
  [[ -z "$eid" ]] && continue
  if [[ "$APPLY" -eq 1 ]]; then
    echo "  starting indexer for $eid (force + rename)"
    az containerapp job start -g "$RESOURCE_GROUP" -n "$JOB" \
      --env-vars EVENT_ID="$eid" FORCE_REINDEX=1 CAPTURE_TIME_RENAME=1 -o none
  else
    echo "  [dry-run] would start: az containerapp job start -g $RESOURCE_GROUP -n $JOB --env-vars EVENT_ID=$eid FORCE_REINDEX=1 CAPTURE_TIME_RENAME=1"
  fi
done
[[ "$APPLY" -eq 0 ]] && echo "==> Dry run only. Re-run with --apply to execute."
