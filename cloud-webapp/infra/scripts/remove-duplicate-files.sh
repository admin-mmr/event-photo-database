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
#   GET  /api/admin/duplicates/<event>         — scan live Drive (read-only)
#   POST /api/admin/duplicates/<event>/remove  — dry run, or QUEUE the removal
#   POST /api/admin/duplicates/drain           — do one bounded slice of the work
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
# the api call uses the machine token (SYNC_TRIGGER_TOKEN), which is deployed via
# --set-secrets and so is read from Secret Manager automatically (you need
# roles/secretmanager.secretAccessor). Override it directly if you prefer:
#   SYNC_TOKEN=... ./infra/scripts/remove-duplicate-files.sh --apply ev123
#
# Tunables (env): PROJECT, REGION, API_BASE, API_SERVICE, BATCH_LIMIT, MAX_TICKS.
#
# WHY --apply IS TWO STEPS: removing an event's duplicates is minutes of
# rate-paced Drive work (~3.5 paced Drive calls per file once its managed
# shortcuts are retired), and no single request can do it — Firebase Hosting caps
# every browser-routed request at 60s regardless of the Cloud Run timeout (which
# is now 1800s, but was 60s when this bit). An earlier version tried to
# do it inline and died at 59.99s with a 502/504 on EVERY call: files really were
# being trashed, but the caller never got a response. So --apply now QUEUES the
# work and this script drives bounded drain ticks until the batch reports done.
# If the script is interrupted, the `findme-duplicates-drain` Cloud Scheduler job
# finishes the batch on its own.

set -euo pipefail

PROJECT="${PROJECT:-mmr-data-pipeline}"
REGION="${REGION:-us-central1}"
API_BASE="${API_BASE:-https://mmr-data-pipeline.web.app}"
API_SERVICE="${API_SERVICE:-event-photo-api}"
BATCH_LIMIT="${BATCH_LIMIT:-150}"
MAX_TICKS="${MAX_TICKS:-400}"

APPLY=0
EVENTS=()
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n '2,50p' "$0"; exit 0 ;;
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

# Resolve the machine token (SYNC_TRIGGER_TOKEN) the api checks.
#
# It is deployed via `--set-secrets`, so the service spec carries a
# `valueFrom.secretKeyRef` and NOT a literal `value` — reading `value` (as this
# script originally did) can never succeed. Order: an explicit SYNC_TOKEN, then
# a literal env value if one was ever set that way, then Secret Manager. Needs
# roles/secretmanager.secretAccessor on the secret.
resolve_sync_token() {
  if [[ -n "${SYNC_TOKEN:-}" ]]; then printf '%s' "$SYNC_TOKEN"; return 0; fi

  local spec literal secret
  spec="$(gcloud run services describe "$API_SERVICE" --region="$REGION" --project="$PROJECT" --format=json 2>/dev/null || true)"
  [[ -z "$spec" ]] && return 1

  literal="$(printf '%s' "$spec" | python3 -c 'import sys, json
d = json.load(sys.stdin)
envs = d.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [{}])[0].get("env", [])
print(next((e.get("value", "") for e in envs if e.get("name") == "SYNC_TRIGGER_TOKEN" and e.get("value")), ""))' 2>/dev/null || true)"
  if [[ -n "$literal" ]]; then printf '%s' "$literal"; return 0; fi

  secret="$(printf '%s' "$spec" | python3 -c 'import sys, json
d = json.load(sys.stdin)
envs = d.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [{}])[0].get("env", [])
ref = next((e.get("valueFrom", {}).get("secretKeyRef", {}) for e in envs if e.get("name") == "SYNC_TRIGGER_TOKEN"), {})
print(ref.get("name", ""))' 2>/dev/null || true)"
  [[ -z "$secret" ]] && secret="SYNC_TRIGGER_TOKEN"

  gcloud secrets versions access latest --secret="$secret" --project="$PROJECT" 2>/dev/null | tr -d '\n'
}

SYNC_TOKEN="$(resolve_sync_token || true)"
if [[ -z "${SYNC_TOKEN:-}" ]]; then
  echo "ERROR: couldn't resolve SYNC_TRIGGER_TOKEN for '$API_SERVICE'." >&2
  echo "       It is stored in Secret Manager; you need secretAccessor on it, or pass it:" >&2
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
    v = json.load(open(sys.argv[1])).get(sys.argv[2], "")
except Exception:
    v = ""
# Booleans print as 1/0 so the shell can test them without parsing "True".
print(1 if v is True else 0 if v is False else v)' "$RESP_FILE" "$1" 2>/dev/null || true
}

post_remove() {
  local id="$1" body="$2"
  curl -sS -o "$RESP_FILE" -w '%{http_code}' \
    -X POST "$API_BASE/api/admin/duplicates/$id/remove" \
    -H "X-Sync-Token: $SYNC_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body" || echo "000"
}

# One bounded slice of queued removal work. The drain always takes the OLDEST
# running batch, so with one event queued at a time this drains that event.
post_drain() {
  curl -sS -o "$RESP_FILE" -w '%{http_code}' \
    -X POST "$API_BASE/api/admin/duplicates/drain" \
    -H "X-Sync-Token: $SYNC_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{}' || echo "000"
}

total_removed=0
total_planned=0
total_candidates=0
total_failed=0
events_with_errors=0
n=0

for id in "${EVENTS[@]}"; do
  n=$(( n + 1 ))
  echo
  echo "[$n/${#EVENTS[@]}] $id"

  if [[ "$APPLY" != "1" ]]; then
    code="$(post_remove "$id" "{\"limit\":${BATCH_LIMIT}}")"
    if [[ "$code" != "200" ]]; then
      echo "  HTTP $code — $(field message)"
      events_with_errors=$(( events_with_errors + 1 ))
      continue
    fi
    candidates="$(field candidates)"
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
    # Summarise on `candidates`, not `planned`: the preview list is capped by
    # BATCH_LIMIT, but an --apply run queues every candidate — a footer built
    # from `planned` understates what the real run would trash.
    total_candidates=$(( total_candidates + ${candidates:-0} ))
    continue
  fi

  # Step 1: queue the event's duplicates. Answers 202 with a batch id; nothing is
  # trashed yet. A 200 means there was simply nothing to do.
  code="$(post_remove "$id" '{"apply":true}')"
  if [[ "$code" != "202" && "$code" != "200" ]]; then
    echo "  HTTP $code — $(field message)"
    events_with_errors=$(( events_with_errors + 1 ))
    continue
  fi
  queued="$(field total)"
  batch_id="$(field batchId)"
  over="$(field notEnqueued)"
  if [[ -z "$batch_id" || "$batch_id" == "None" || "${queued:-0}" == "0" ]]; then
    echo "  nothing to remove"
    continue
  fi
  echo "  queued ${queued} duplicate file(s) (batch $batch_id)"
  [[ "${over:-0}" != "0" ]] && echo "  note: ${over} beyond this batch — re-run after it finishes"

  # Step 2: drive drain ticks until the batch reports done. Each tick is bounded
  # server-side so it always answers well inside the 60s request ceiling.
  tick=0
  ev_removed=0
  while (( tick < MAX_TICKS )); do
    tick=$(( tick + 1 ))
    code="$(post_drain)"
    if [[ "$code" != "200" ]]; then
      # A tick that fails leaves its lease to expire; the next one resumes.
      echo "  tick $tick: HTTP $code — $(field message)"
      events_with_errors=$(( events_with_errors + 1 ))
      break
    fi

    drained="$(field drained)"
    busy="$(field busy)"
    processed="$(field processed)"
    failed="$(field failed)"
    remaining="$(field remaining)"
    finished="$(field finished)"

    if [[ "${drained:-0}" == "0" ]]; then
      echo "  tick $tick: queue empty"
      break
    fi
    if [[ "${busy:-0}" == "1" ]]; then
      # Another drain (the scheduler, or the admin UI) holds the batch. Wait it out.
      echo "  tick $tick: another drain holds the batch — waiting"
      sleep 5
      continue
    fi

    ev_removed=$(( ev_removed + ${processed:-0} ))
    total_removed=$(( total_removed + ${processed:-0} ))
    total_failed=$(( total_failed + ${failed:-0} ))
    echo "  tick $tick: removed ${processed:-0}, failed ${failed:-0}, remaining ${remaining:-0}"

    [[ "${finished:-0}" == "1" ]] && break
    # No forward progress and nothing left to sweep means every remaining file is
    # failing; stop instead of looping on the same files forever.
    if [[ "${processed:-0}" == "0" && "${failed:-0}" != "0" ]]; then
      echo "  no progress this tick — stopping this event"
      break
    fi
  done
  echo "  event total: ${ev_removed} file(s) trashed"
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
  if (( total_candidates > total_planned )); then
    echo "Dry run: $total_candidates duplicate file(s) would be trashed ($total_planned listed above). Re-run with --apply to do it."
  else
    echo "Dry run: $total_candidates duplicate file(s) would be trashed. Re-run with --apply to do it."
  fi
fi
(( events_with_errors > 0 )) && echo "WARNING: $events_with_errors event(s) errored — see the HTTP lines above." >&2
exit 0
