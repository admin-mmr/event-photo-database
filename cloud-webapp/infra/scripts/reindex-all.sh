#!/usr/bin/env bash
#
# reindex-all.sh — re-index every event so Find Me picks up a new MODEL_VERSION.
#
# After bumping MODEL_VERSION (e.g. enabling the YOLOv8 person detector, @m1),
# the automatic index-scan will NOT re-index events whose Drive files are
# unchanged — it keys off the Drive fingerprint, and a model bump doesn't touch
# any photos. So a model change has to be triggered per event. This script walks
# every event in the Firestore `events` cache and triggers
# POST /api/events/<id>/index (the same call the admin "Index event" button
# makes). The indexer notices the version mismatch and does a full re-embed on
# its own — you do NOT need the force flag for that.
#
# It processes ONE event at a time, waiting for each to finish before starting
# the next, so job concurrency (and cost) stays predictable.
#
# Usage:
#   ./infra/scripts/reindex-all.sh                 # re-index ALL events
#   ./infra/scripts/reindex-all.sh ev123 ev456     # only these event IDs
#   DRY_RUN=1 ./infra/scripts/reindex-all.sh       # list what would run, do nothing
#   YES=1     ./infra/scripts/reindex-all.sh       # skip the confirmation prompt
#
# Auth: needs `gcloud` logged in. It uses your gcloud token to list events from
# Firestore, and reads the trigger token (SYNC_TRIGGER_TOKEN) from the deployed
# api service. If that token has been moved to Secret Manager (no plaintext env),
# pass it directly:  SYNC_TOKEN=... ./infra/scripts/reindex-all.sh
#
# Tunables (env): PROJECT, REGION, API_BASE, API_SERVICE, POLL_EVERY,
# POLL_TIMEOUT, SLEEP_BETWEEN.

set -euo pipefail

PROJECT="${PROJECT:-mmr-data-pipeline}"
REGION="${REGION:-us-central1}"
API_BASE="${API_BASE:-https://mmr-data-pipeline.web.app}"
API_SERVICE="${API_SERVICE:-event-photo-api}"
POLL_EVERY="${POLL_EVERY:-15}"      # seconds between status checks
POLL_TIMEOUT="${POLL_TIMEOUT:-1800}" # max seconds to wait per event
SLEEP_BETWEEN="${SLEEP_BETWEEN:-5}"  # pause between events
DRY_RUN="${DRY_RUN:-0}"

for bin in gcloud curl python3; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: '$bin' not found on PATH" >&2; exit 1; }
done

RESP_FILE="$(mktemp -t reindex-resp-XXXXXX)"
trap 'rm -f "$RESP_FILE"' EXIT

gcloud_token() {
  gcloud auth print-access-token 2>/dev/null || {
    echo "ERROR: 'gcloud auth print-access-token' failed — run 'gcloud auth login'." >&2
    exit 1
  }
}

TOKEN="$(gcloud_token)"

# Trigger token: explicit SYNC_TOKEN wins; otherwise read it from the service env.
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
  echo "         SYNC_TOKEN=... $0" >&2
  exit 1
fi

# Build the list of event IDs: from CLI args, else the whole events collection.
EVENTS=()
if [[ "$#" -gt 0 ]]; then
  EVENTS=("$@")
else
  while IFS= read -r line; do
    [[ -n "$line" ]] && EVENTS+=("$line")
  done < <(FS_TOKEN="$TOKEN" FS_PROJECT="$PROJECT" python3 - <<'PY'
import os, json, urllib.request
tok = os.environ["FS_TOKEN"]; proj = os.environ["FS_PROJECT"]
base = f"https://firestore.googleapis.com/v1/projects/{proj}/databases/(default)/documents/events"
page = ""
while True:
    url = base + ("?pageSize=300" + (f"&pageToken={page}" if page else ""))
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
    data = json.load(urllib.request.urlopen(req))
    for d in data.get("documents", []):
        print(d["name"].split("/")[-1])
    page = data.get("nextPageToken", "")
    if not page:
        break
PY
  )
fi

if (( ${#EVENTS[@]} == 0 )); then
  echo "No events found — nothing to do."
  exit 0
fi

echo "Project: $PROJECT   Region: $REGION"
echo "API:     $API_BASE"
echo "Events to re-index: ${#EVENTS[@]}"
printf '  %s\n' "${EVENTS[@]}"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "(DRY_RUN=1 — nothing triggered)"
  exit 0
fi

if [[ "${YES:-0}" != "1" ]]; then
  printf 'Trigger a full re-embed for all %d event(s)? [y/N] ' "${#EVENTS[@]}"
  read -r reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Aborted."; exit 0; }
fi

# Read an event's current index status from Firestore (typed JSON).
get_status() {
  FS_TOKEN="$TOKEN" FS_PROJECT="$PROJECT" FS_EV="$1" python3 - <<'PY'
import os, json, urllib.request
tok = os.environ["FS_TOKEN"]; proj = os.environ["FS_PROJECT"]; ev = os.environ["FS_EV"]
url = f"https://firestore.googleapis.com/v1/projects/{proj}/databases/(default)/documents/events/{ev}"
req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
try:
    d = json.load(urllib.request.urlopen(req))
except Exception:
    print("unknown"); raise SystemExit
f = d.get("fields", {}).get("indexState", {}).get("mapValue", {}).get("fields", {})
print(f.get("status", {}).get("stringValue", "unknown"))
PY
}

wait_for_done() {
  local id="$1" elapsed=0 st=""
  while (( elapsed < POLL_TIMEOUT )); do
    TOKEN="$(gcloud_token)"   # refresh: access tokens expire ~1h
    st="$(get_status "$id")"
    case "$st" in
      done)         printf '\r  status=done            \n'; return 0 ;;
      failed|error) printf '\r  status=%s            \n' "$st"; return 1 ;;
      *)            printf '\r  status=%s (%ss elapsed) ' "$st" "$elapsed" ;;
    esac
    sleep "$POLL_EVERY"; elapsed=$(( elapsed + POLL_EVERY ))
  done
  printf '\r  TIMEOUT after %ss (last status=%s)\n' "$POLL_TIMEOUT" "$st"
  return 1
}

ok=0; failed=0; n=0; total=${#EVENTS[@]}
for id in "${EVENTS[@]}"; do
  n=$(( n + 1 ))
  echo "[$n/$total] $id"
  TOKEN="$(gcloud_token)"

  code="$(curl -sS -o "$RESP_FILE" -w '%{http_code}' \
    -X POST "$API_BASE/api/events/$id/index" \
    -H "X-Sync-Token: $SYNC_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{}' || echo "000")"

  err="$(python3 -c 'import sys,json
try: print(json.load(open(sys.argv[1])).get("error",""))
except Exception: print("")' "$RESP_FILE" 2>/dev/null || true)"

  case "$code" in
    200|202)
      echo "  triggered"
      if wait_for_done "$id"; then ok=$(( ok + 1 )); else failed=$(( failed + 1 )); fi
      ;;
    409)
      if [[ "$err" == "already_running" ]]; then
        echo "  already running — waiting for it to finish"
        if wait_for_done "$id"; then ok=$(( ok + 1 )); else failed=$(( failed + 1 )); fi
      else
        echo "  skipped (HTTP 409: ${err:-conflict})"
        failed=$(( failed + 1 ))
      fi
      ;;
    *)
      echo "  trigger failed (HTTP $code${err:+, $err})"
      failed=$(( failed + 1 ))
      ;;
  esac
  sleep "$SLEEP_BETWEEN"
done

echo
echo "Re-index complete: $ok ok, $failed failed/skipped, of $total event(s)."
[[ "$failed" -eq 0 ]]
