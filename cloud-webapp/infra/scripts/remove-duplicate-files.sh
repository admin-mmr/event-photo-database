#!/usr/bin/env bash
#
# remove-duplicate-files.sh — remove byte-identical duplicate files from an
# event's Google Drive tree (or from every event).
#
# The same photo lands in Drive more than once all the time — a card re-uploaded,
# two volunteers with the same shot, a batch copied twice. The indexer and the
# managed-folder rebuild already ignore the extra copies, but nobody ever deleted
# them, so they keep paying Drive storage and keep turning one filename into a
# dozen hits in Drive search. This drives the api's duplicate tool:
#
#   GET  /api/admin/duplicates/<event>         — scan live Drive
#   POST /api/admin/duplicates/<event>/remove  — trash the redundant copies
#
# What survives: the first copy in path order — the same one the indexer keeps
# when it collapses photos by md5 — so removal never trashes the file the current
# gallery points at. Managed folders (Photos_NNN / Videos / Album) are never
# touched, and a file Drive reports no checksum for is always kept.
#
# Removal is a SOFT delete: the file goes to Drive's trash, a row is appended to
# the Deleted_Files tab of the master Sheet, and the scheduled purge job deletes
# it for good only after SOFT_DELETE_RETENTION_DAYS. Restore from the admin
# "Deleted files" page any time before that.
#
# DRY RUN BY DEFAULT: prints what it would trash. Pass --apply to execute.
#
# Usage:
#   ./infra/scripts/remove-duplicate-files.sh                     # dry run, all events
#   ./infra/scripts/remove-duplicate-files.sh ev123               # dry run, one event
#   ./infra/scripts/remove-duplicate-files.sh --apply ev123       # remove, one event
#   ./infra/scripts/remove-duplicate-files.sh --apply             # remove, all events
#   YES=1 ./infra/scripts/remove-duplicate-files.sh --apply       # no confirmation prompt
#
# Auth: needs `gcloud` logged in. Your gcloud token lists events from Firestore;
# the api call uses the machine token (SYNC_TRIGGER_TOKEN) read from the deployed
# service. If that token lives in Secret Manager, pass it directly:
#   SYNC_TOKEN=... ./infra/scripts/remove-duplicate-files.sh --apply ev123
#
# Tunables (env): PROJECT, REGION, API_BASE, API_SERVICE, BATCH_LIMIT, MAX_ROUNDS.
#
# Each POST is bounded server-side (a file cap plus a wall-clock budget covering
# the whole call — Drive scan included) so it fits the 60s Firebase Hosting
# ceiling; this script just calls again while the response still reports files
# remaining.

set -euo pipefail

PROJECT="${PROJECT:-mmr-data-pipeline}"
REGION="${REGION:-us-central1}"
API_BASE="${API_BASE:-https://mmr-data-pipeline.web.app}"
API_SERVICE="${API_SERVICE:-event-photo-api}"
BATCH_LIMIT="${BATCH_LIMIT:-150}"
MAX_ROUNDS="${MAX_ROUNDS:-200}"

APPLY=0
EVENTS=()
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n '2,44p' "$0"; exit 0 ;;
    -*) echo "ERROR: unknown flag '$arg'" >&2; exit 1 ;;
    *) EVENTS+=("$arg") ;;
  esac
done

for bin in gcloud curl python3; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: '$bin' not found on PATH" >&2; exit 1; }
done

RESP_FILE="$(mktemp -t dedupe-resp-XXXXXX)"
trap 'rm -f "$RESP_FILE"' EXIT

gcloud_token() {
  gcloud auth print-access-token 2>/dev/null || {
    echo "ERROR: 'gcloud auth print-access-token' failed — run 'gcloud auth login'." >&2
    exit 1
  }
}

TOKEN="$(gcloud_token)"

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

if [[ ${#EVENTS[@]} -eq 0 ]]; then
  echo "==> Enumerating events with a driveFolderId from Firestore…"
  while IFS= read -r line; do
    [[ -n "$line" ]] && EVENTS+=("$line")
  done < <(FS_TOKEN="$TOKEN" FS_PROJECT="$PROJECT" python3 - <<'PY'
import os, json, urllib.request
tok = os.environ["FS_TOKEN"]; proj = os.environ["FS_PROJECT"]
base = f"https://firestore.googleapis.com/v1/projects/{proj}/databases/(default)/documents/events"
page = ""
while True:
    url = base + "?pageSize=300" + (f"&pageToken={page}" if page else "")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
    d = json.load(urllib.request.urlopen(req))
    for doc in d.get("documents", []):
        if doc.get("fields", {}).get("driveFolderId"):
            print(doc["name"].rsplit("/", 1)[-1])
    page = d.get("nextPageToken", "")
    if not page:
        break
PY
  )
fi

if [[ ${#EVENTS[@]} -eq 0 ]]; then
  echo "No events found — nothing to do."
  exit 0
fi

echo "Project: $PROJECT   Region: $REGION"
echo "API:     $API_BASE"
echo "Events:  ${#EVENTS[@]}"
if [[ "$APPLY" == "1" ]]; then
  echo "Mode:    APPLY — duplicates will be moved to Drive trash (restorable)"
else
  echo "Mode:    DRY RUN — nothing will be changed (pass --apply to remove)"
fi

if [[ "$APPLY" == "1" && "${YES:-0}" != "1" ]]; then
  printf 'Trash duplicate files across %d event(s)? [y/N] ' "${#EVENTS[@]}"
  read -r reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Aborted."; exit 0; }
fi

# Pull one number (or string) out of the last response body.
field() {
  python3 -c 'import sys, json
try:
    print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))
except Exception:
    print("")' "$RESP_FILE" "$1" 2>/dev/null || true
}

post_remove() {
  local id="$1" body="$2"
  curl -sS -o "$RESP_FILE" -w '%{http_code}' \
    -X POST "$API_BASE/api/admin/duplicates/$id/remove" \
    -H "X-Sync-Token: $SYNC_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body" || echo "000"
}

total_removed=0
total_planned=0
total_failed=0
events_with_errors=0
n=0

for id in "${EVENTS[@]}"; do
  n=$(( n + 1 ))
  echo
  echo "[$n/${#EVENTS[@]}] $id"

  round=0
  while (( round < MAX_ROUNDS )); do
    round=$(( round + 1 ))
    if [[ "$APPLY" == "1" ]]; then
      code="$(post_remove "$id" "{\"apply\":true,\"limit\":${BATCH_LIMIT}}")"
    else
      code="$(post_remove "$id" "{\"limit\":${BATCH_LIMIT}}")"
    fi

    if [[ "$code" != "200" ]]; then
      echo "  HTTP $code — $(field message)"
      events_with_errors=$(( events_with_errors + 1 ))
      break
    fi

    candidates="$(field candidates)"
    removed="$(field removed)"
    failed="$(field failed)"
    remaining="$(field remaining)"

    if [[ "$APPLY" == "1" ]]; then
      echo "  round $round: removed ${removed:-0}, failed ${failed:-0}, remaining ${remaining:-0} (of ${candidates:-0})"
      total_removed=$(( total_removed + ${removed:-0} ))
      total_failed=$(( total_failed + ${failed:-0} ))
      # No forward progress means every attempt in this round failed; stop
      # instead of looping on the same files forever.
      if [[ "${removed:-0}" == "0" ]]; then
        [[ "${remaining:-0}" != "0" ]] && echo "  no progress this round — stopping this event"
        break
      fi
      [[ "${remaining:-0}" == "0" ]] && break
    else
      planned="$(python3 -c 'import sys, json
try:
    print(len(json.load(open(sys.argv[1])).get("planned", [])))
except Exception:
    print(0)' "$RESP_FILE" 2>/dev/null || echo 0)"
      echo "  would trash ${planned} of ${candidates:-0} duplicate file(s)"
      python3 -c 'import sys, json
try:
    rows = json.load(open(sys.argv[1])).get("planned", [])
except Exception:
    rows = []
for r in rows[:20]:
    print("    - " + r.get("relPath", r.get("driveFileId", "?")))
if len(rows) > 20:
    print(f"    … and {len(rows) - 20} more")' "$RESP_FILE" 2>/dev/null || true
      total_planned=$(( total_planned + ${planned:-0} ))
      break
    fi
  done
done

echo
if [[ "$APPLY" == "1" ]]; then
  echo "Done: trashed $total_removed duplicate file(s), $total_failed failure(s)."
  echo "They are recoverable from the admin \"Deleted files\" page until the purge job runs."
  if (( total_removed > 0 )); then
    echo "Re-index the affected events so the gallery drops the removed copies:"
    echo "  ./infra/scripts/reindex-all.sh ${EVENTS[*]}"
  fi
else
  echo "Dry run: $total_planned duplicate file(s) would be trashed. Re-run with --apply to do it."
fi
(( events_with_errors > 0 )) && echo "WARNING: $events_with_errors event(s) errored — see the HTTP lines above." >&2
exit 0
