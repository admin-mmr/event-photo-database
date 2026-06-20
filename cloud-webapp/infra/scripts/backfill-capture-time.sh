#!/usr/bin/env bash
#
# backfill-capture-time.sh — populate takenAt and apply the capture-time
# filename prefix across the EXISTING photo library (CAPTURE_TIME_SORT_DESIGN
# §8). It force-reindexes every event; the indexer re-reads each photo's bytes,
# writes takenAt/takenAtSource to Firestore, and (with CAPTURE_TIME_RENAME=1)
# renames the Drive file + stamps its modifiedTime. Idempotent — safe to re-run.
#
# DRY RUN BY DEFAULT: prints what it would trigger. Pass --apply to execute.
#
# Usage:
#   ./infra/scripts/backfill-capture-time.sh <project-id> [region] [--apply] [event-id ...]
#
#   With no explicit event ids it enumerates every event (with a driveFolderId)
#   from Firestore. Supply ids to backfill just those.
#
# Pre-reqs:
#   - gcloud authed as someone who can run the job + read Firestore.
#   - The Drive read-WRITE scope is granted to the DWD client (Workspace Admin
#     console) — the rename needs it. Without it, takenAt still backfills but
#     every rename logs "rename SKIP ... 403".
#   - `jq` for the Firestore enumeration (not needed if you pass event ids).
#
# Note: this drives the Cloud Run Job directly (not the api), so the api's
# `lastIndexSig` bookkeeping isn't updated; the next scheduled index-scan may
# re-trigger an event once (harmless — the indexer is idempotent).

set -euo pipefail

PROJECT_ID="${1:-}"
shift || true
REGION="us-central1"
APPLY=0
EVENT_IDS=()

if [[ -z "$PROJECT_ID" ]]; then
  echo "Usage: $0 <project-id> [region] [--apply] [event-id ...]" >&2
  exit 1
fi

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    us-*|europe-*|asia-*) REGION="$arg" ;;
    *) EVENT_IDS+=("$arg") ;;
  esac
done

JOB="photo-indexer"
FS_BASE="https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents"

enumerate_events() {
  local token page_url next body
  token="$(gcloud auth print-access-token)"
  next=""
  while :; do
    page_url="${FS_BASE}/events?pageSize=300"
    if [[ -n "$next" ]]; then
      page_url="${page_url}&pageToken=${next}"
    fi
    body="$(curl -sS -H "Authorization: Bearer ${token}" "$page_url")"
    echo "$body" | jq -r '.documents[]? | select(.fields.driveFolderId != null) | .name | sub(".*/events/"; "")'
    next="$(echo "$body" | jq -r '.nextPageToken // empty')"
    [[ -z "$next" ]] && break
  done
}

if [[ ${#EVENT_IDS[@]} -eq 0 ]]; then
  echo "==> Enumerating events with a driveFolderId from Firestore…"
  mapfile -t EVENT_IDS < <(enumerate_events)
fi

echo "==> Project: $PROJECT_ID  region: $REGION  events: ${#EVENT_IDS[@]}  apply: $APPLY"

for eid in "${EVENT_IDS[@]}"; do
  [[ -z "$eid" ]] && continue
  if [[ "$APPLY" -eq 1 ]]; then
    echo "==> reindex+rename $eid"
    gcloud run jobs execute "$JOB" \
      --project="$PROJECT_ID" --region="$REGION" \
      --update-env-vars="EVENT_ID=${eid},FORCE_REINDEX=1,CAPTURE_TIME_RENAME=1" \
      --wait
  else
    echo "DRY-RUN would: gcloud run jobs execute $JOB --region=$REGION --update-env-vars=EVENT_ID=${eid},FORCE_REINDEX=1,CAPTURE_TIME_RENAME=1 --wait"
  fi
done

echo "==> Done. (dry-run: re-run with --apply to execute)"
