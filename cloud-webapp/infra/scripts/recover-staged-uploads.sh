#!/usr/bin/env bash
#
# recover-staged-uploads.sh — copy volunteer photos that are still sitting in the
# staging bucket into Google Drive.
#
# A volunteer upload lands in a GCS staging bucket first, and a Cloud Tasks
# worker copies it into the event's Drive folder. Only after that does the
# indexer see it and the gallery show it. When the worker fails, the bytes stay
# in staging and the photo is invisible — safe, but missing.
#
# That happened on 2026-07-27: the api was deployed with a 60s request timeout
# (below the worker's 1800s dispatch deadline), so the worker was killed
# mid-batch, Cloud Tasks gave up after 5 attempts, and 1,188 photos (~5.1 GB)
# were left staged. This script puts them back.
#
#   GET  /api/admin/upload-recovery/<event>   — report what is owed
#   POST /api/admin/upload-recovery/<event>   — dry run, or dispatch the copies
#
# Applying does NOT copy anything inline: it creates Cloud Tasks work items and
# the normal upload worker does the copying, reusing the same tested path as a
# real upload — batch folder, credited filename (photographer credit is read
# from each staged object's GCS metadata), md5 duplicate check, Deleted_Files
# bookkeeping and the indexer trigger.
#
# SAFE TO RE-RUN: objects whose content is already in Drive are filtered out
# before dispatch, and the worker's own md5 claim is the authoritative check, so
# a second run cannot create duplicate Drive files.
#
# DRY RUN BY DEFAULT: prints what it would copy. Pass --apply to execute.
#
# Usage:
#   ./infra/scripts/recover-staged-uploads.sh ev123              # report + dry run
#   ./infra/scripts/recover-staged-uploads.sh --apply ev123      # dispatch the copies
#   YES=1 ./infra/scripts/recover-staged-uploads.sh --apply ev123
#
# Auth: needs `gcloud` logged in; the api call uses the machine token
# (SYNC_TRIGGER_TOKEN) read from the deployed service, or pass it directly:
#   SYNC_TOKEN=... ./infra/scripts/recover-staged-uploads.sh --apply ev123
#
# Tunables (env): PROJECT, REGION, API_BASE, API_SERVICE, CHUNK_SIZE.
#
# PREREQUISITE: the api must be deployed with --timeout=1800. At 60s the worker
# is killed mid-batch and this just reproduces the original failure. Check with:
#   gcloud run services describe event-photo-api --region=us-central1 \
#     --project=mmr-data-pipeline --format='value(spec.template.spec.timeoutSeconds)'

set -euo pipefail

PROJECT="${PROJECT:-mmr-data-pipeline}"
REGION="${REGION:-us-central1}"
API_BASE="${API_BASE:-https://mmr-data-pipeline.web.app}"
API_SERVICE="${API_SERVICE:-event-photo-api}"
CHUNK_SIZE="${CHUNK_SIZE:-400}"

APPLY=0
EVENTS=()
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n '2,46p' "$0"; exit 0 ;;
    -*) echo "ERROR: unknown flag '$arg'" >&2; exit 1 ;;
    *) EVENTS+=("$arg") ;;
  esac
done

if [[ ${#EVENTS[@]} -eq 0 ]]; then
  echo "ERROR: name at least one event id (recovery is per-event on purpose)." >&2
  echo "Usage: $0 [--apply] <event-id> [event-id ...]" >&2
  exit 1
fi

for bin in gcloud curl python3; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: '$bin' not found on PATH" >&2; exit 1; }
done

RESP_FILE="$(mktemp -t recover-resp-XXXXXX)"
trap 'rm -f "$RESP_FILE"' EXIT

if [[ -z "${SYNC_TOKEN:-}" ]]; then
  SYNC_TOKEN="$(gcloud run services describe "$API_SERVICE" --region="$REGION" --project="$PROJECT" --format=json 2>/dev/null \
    | python3 -c 'import sys, json
d = json.load(sys.stdin)
envs = d.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [{}])[0].get("env", [])
print(next((e.get("value", "") for e in envs if e.get("name") == "SYNC_TRIGGER_TOKEN"), ""))' 2>/dev/null || true)"
fi
if [[ -z "${SYNC_TOKEN:-}" ]]; then
  echo "ERROR: couldn't read SYNC_TRIGGER_TOKEN from '$API_SERVICE'." >&2
  echo "       It may be a Secret Manager ref. Provide it explicitly:" >&2
  echo "         SYNC_TOKEN=... $0 ${*:-}" >&2
  exit 1
fi

DEPLOYED_TIMEOUT="$(gcloud run services describe "$API_SERVICE" --region="$REGION" --project="$PROJECT" \
  --format='value(spec.template.spec.timeoutSeconds)' 2>/dev/null || echo '')"
echo "Project: $PROJECT   API: $API_BASE"
echo "Deployed api request timeout: ${DEPLOYED_TIMEOUT:-unknown}s"
if [[ "$APPLY" == "1" && -n "$DEPLOYED_TIMEOUT" && "$DEPLOYED_TIMEOUT" -lt 600 ]]; then
  echo >&2
  echo "REFUSING TO APPLY: the api request timeout is ${DEPLOYED_TIMEOUT}s." >&2
  echo "  The upload worker needs the full 1800s window; at this timeout it is killed" >&2
  echo "  mid-batch and recovery reproduces the very bug it is meant to repair." >&2
  echo "  Deploy the api with --timeout=1800 first, then re-run." >&2
  exit 1
fi

post_recover() {
  local id="$1" body="$2"
  curl -sS -o "$RESP_FILE" -w '%{http_code}' \
    -X POST "$API_BASE/api/admin/upload-recovery/$id" \
    -H "X-Sync-Token: $SYNC_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body" || echo "000"
}

field() {
  python3 -c 'import sys, json
try:
    v = json.load(open(sys.argv[1])).get(sys.argv[2], "")
except Exception:
    v = ""
print(1 if v is True else 0 if v is False else v)' "$RESP_FILE" "$1" 2>/dev/null || true
}

if [[ "$APPLY" == "1" && "${YES:-0}" != "1" ]]; then
  printf 'Dispatch staged-upload recovery for %d event(s)? [y/N] ' "${#EVENTS[@]}"
  read -r reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Aborted."; exit 0; }
fi

total_objects=0
events_with_errors=0
n=0

for id in "${EVENTS[@]}"; do
  n=$(( n + 1 ))
  echo
  echo "[$n/${#EVENTS[@]}] $id"

  if [[ "$APPLY" == "1" ]]; then
    code="$(post_recover "$id" "{\"apply\":true,\"chunkSize\":${CHUNK_SIZE}}")"
    expected="202"
  else
    code="$(post_recover "$id" "{\"chunkSize\":${CHUNK_SIZE}}")"
    expected="200"
  fi

  if [[ "$code" != "$expected" ]]; then
    echo "  HTTP $code — $(field message)"
    events_with_errors=$(( events_with_errors + 1 ))
    continue
  fi

  objects="$(field objects)"
  tasks="$(field tasks)"
  batches="$(field batches)"
  notdisp="$(field notDispatched)"
  total_objects=$(( total_objects + ${objects:-0} ))

  if [[ "$APPLY" == "1" ]]; then
    echo "  dispatched ${objects:-0} photo(s) across ${tasks:-0} task(s), ${batches:-0} batch(es)"
  else
    echo "  would copy ${objects:-0} photo(s) across ${tasks:-0} task(s), ${batches:-0} batch(es)"
  fi
  [[ "${notdisp:-0}" != "0" ]] && echo "  ${notdisp} not dispatched — see warnings below"
  python3 -c 'import sys, json
try:
    for w in json.load(open(sys.argv[1])).get("warnings", []):
        print("    ! " + w)
except Exception:
    pass' "$RESP_FILE" 2>/dev/null || true
done

echo
if [[ "$APPLY" == "1" ]]; then
  echo "Done: dispatched $total_objects photo(s) to the upload worker."
  echo "The copies run in the background; watch them land with:"
  echo "  gcloud logging read 'resource.labels.service_name=\"event-photo-api\" AND jsonPayload.message=~\"worker processed staged batch\"' --project=$PROJECT --limit=20 --freshness=1h --format='value(timestamp, jsonPayload.copied, jsonPayload.skipped)'"
  echo "Each batch triggers a re-index itself, so the gallery catches up automatically."
else
  echo "Dry run: $total_objects photo(s) would be copied. Re-run with --apply to do it."
fi
(( events_with_errors > 0 )) && echo "WARNING: $events_with_errors event(s) errored — see the HTTP lines above." >&2
exit 0
