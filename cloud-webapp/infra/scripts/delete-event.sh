#!/usr/bin/env bash
#
# delete-event.sh — delete an event and everything that hangs off it.
#
# An event lives in five places (Sheet Events row, Sheet Upload_Links rows, the
# Drive folder, the derivatives bucket, and a handful of Firestore collections),
# so retiring one used to mean hand-editing all five in the right order. This
# drives the api's delete tool, which does them in that order:
#
#   GET  /api/admin/events/<event>/delete-preview  — inventory (read-only)
#   POST /api/admin/events/<event>/delete          — dry run, or apply
#
# What happens to each layer:
#   • Upload links   → REVOKED (rows kept, so the audit trail survives)
#   • Drive folder   → TRASHED + a Deleted_Files row, so it is restorable from the
#                      admin "Deleted files" page until the purge job passes
#                      retention. NOT permanently deleted.
#   • Derivatives    → deleted from gs://…-derivatives/<eventId>/ (regenerable by
#                      a re-index)
#   • Sheet row      → deleted. This has to happen, or the next findme-drive-sync
#                      tick recreates the event from the Sheet (the SSOT).
#   • Firestore      → events, photos, uploadLinks, upload_batches, upload_dedup,
#                      match_runs, match_feedback, specialFolders docs
#
# NOT deleted: staged volunteer uploads. A staged object can be the only copy of
# a photo that never reached Drive — deleting those is what destroyed volunteer
# photos on 2026-07-27/28. They are counted and reported; the staging bucket
# lifecycle reclaims them, and recover-staged-uploads.sh can still rescue them.
#
# DRY RUN BY DEFAULT: prints the inventory. Pass --apply to delete.
#
# Usage:
#   ./infra/scripts/delete-event.sh ev123 ev456           # dry run
#   ./infra/scripts/delete-event.sh --apply ev123         # delete one event
#   YES=1 ./infra/scripts/delete-event.sh --apply ev123   # no confirmation prompt
#   REASON="test event" ./infra/scripts/delete-event.sh --apply ev123
#
# The event id is required — there is deliberately no "all events" mode.
#
# Auth: needs `gcloud` logged in. The api call uses the machine token
# (SYNC_TRIGGER_TOKEN) read from Secret Manager (you need
# roles/secretmanager.secretAccessor); override with SYNC_TOKEN=... if you prefer.
#
# Tunables (env): PROJECT, REGION, API_BASE, API_SERVICE, REASON, MAX_RUNS.
#
# WHY IT MAY RUN THE DELETE MORE THAN ONCE: the only unbounded step is sweeping
# the derivatives bucket, which for a big event is thousands of objects — more
# than fits in one request (Firebase Hosting kills any browser-routed request at
# 60s). The api sweeps what it can, reports `derivativesRemaining`, and leaves the
# Sheet row + Firestore docs in place so a re-run finishes the job. This script
# just repeats the call until it comes back clean.

set -euo pipefail

PROJECT="${PROJECT:-mmr-data-pipeline}"
REGION="${REGION:-us-central1}"
API_BASE="${API_BASE:-https://mmr-data-pipeline.web.app}"
API_SERVICE="${API_SERVICE:-event-photo-api}"
MAX_RUNS="${MAX_RUNS:-20}"

APPLY=0
EVENTS=()
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n '2,55p' "$0"; exit 0 ;;
    -*) echo "ERROR: unknown flag '$arg'" >&2; exit 1 ;;
    *) EVENTS+=("$arg") ;;
  esac
done

if [[ ${#EVENTS[@]} -eq 0 ]]; then
  echo "ERROR: pass at least one event id (there is no 'all events' mode here)." >&2
  echo "       List them with: ./infra/scripts/remove-duplicate-files.sh   (dry run prints ids)" >&2
  exit 1
fi

for bin in gcloud curl python3; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: '$bin' not found on PATH" >&2; exit 1; }
done

RESP_FILE="$(mktemp -t delevent-resp-XXXXXX)"
trap 'rm -f "$RESP_FILE"' EXIT

# Resolve the machine token (SYNC_TRIGGER_TOKEN) the api checks. It is deployed
# via --set-secrets, so the service spec carries a valueFrom.secretKeyRef and NOT
# a literal value. Order: explicit SYNC_TOKEN, literal env value, Secret Manager.
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

echo "Project: $PROJECT   Region: $REGION"
echo "API:     $API_BASE"
echo "Events:  ${#EVENTS[@]}"
if [[ "$APPLY" == "1" ]]; then
  echo "Mode:    APPLY — the Drive folder goes to trash (restorable); Sheet + Firestore rows are removed"
else
  echo "Mode:    DRY RUN — nothing will be changed (pass --apply to delete)"
fi

# Pull one field out of the last response body. Booleans print as 1/0 so the
# shell can test them without parsing "True".
field() {
  python3 -c 'import sys, json
try:
    d = json.load(open(sys.argv[1]))
    for key in sys.argv[2].split("."):
        d = d.get(key, "")
        if d == "":
            break
    v = d
except Exception:
    v = ""
print(1 if v is True else 0 if v is False else v)' "$RESP_FILE" "$1" 2>/dev/null || true
}

post_delete() {
  local id="$1" body="$2"
  curl -sS -o "$RESP_FILE" -w '%{http_code}' \
    -X POST "$API_BASE/api/admin/events/$id/delete" \
    -H "X-Sync-Token: $SYNC_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body" || echo "000"
}

print_warnings() {
  python3 -c 'import sys, json
try:
    rows = json.load(open(sys.argv[1])).get("warnings", [])
except Exception:
    rows = []
for r in rows:
    print("    ! " + str(r))' "$RESP_FILE" 2>/dev/null || true
}

json_string() {
  python3 -c 'import sys, json; print(json.dumps(sys.argv[1]))' "$1"
}

deleted=0
errors=0
n=0

for id in "${EVENTS[@]}"; do
  n=$(( n + 1 ))
  echo
  echo "[$n/${#EVENTS[@]}] $id"

  # Always dry run first: it names the event (needed for the confirmation the api
  # requires on an apply) and prints what is about to go.
  code="$(post_delete "$id" '{}')"
  if [[ "$code" != "200" ]]; then
    echo "  HTTP $code — $(field message)"
    errors=$(( errors + 1 ))
    continue
  fi
  ev_name="$(field eventName)"
  echo "  name:        ${ev_name:-<unnamed>}  ($(field eventDate))"
  echo "  photos:      $(field inventory.photos)"
  echo "  links:       $(field inventory.links) ($(field inventory.activeLinks) active)"
  echo "  stored files:$(field inventory.derivativeObjects)"
  echo "  staged:      $(field inventory.stagedObjects) (never deleted)"
  print_warnings

  if [[ "$APPLY" != "1" ]]; then
    continue
  fi

  if [[ "${YES:-0}" != "1" ]]; then
    printf '  Delete "%s"? [y/N] ' "${ev_name:-$id}"
    read -r reply
    [[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "  Skipped."; continue; }
  fi

  # The api requires confirmName to match the event's name (or its id) — echo back
  # what the preview just told us rather than trusting the caller's spelling.
  confirm="${ev_name:-$id}"
  body="{\"apply\":true,\"confirmName\":$(json_string "$confirm"),\"reason\":$(json_string "${REASON:-deleted via delete-event.sh}")}"

  run=0
  while (( run < MAX_RUNS )); do
    run=$(( run + 1 ))
    code="$(post_delete "$id" "$body")"
    if [[ "$code" != "200" ]]; then
      echo "  HTTP $code — $(field message)"
      errors=$(( errors + 1 ))
      break
    fi
    echo "  run $run: $(field message)"
    print_warnings
    if [[ "$(field derivativesRemaining)" != "1" ]]; then
      deleted=$(( deleted + 1 ))
      break
    fi
    echo "  run $run: bucket sweep unfinished — running again"
  done
done

echo
if [[ "$APPLY" == "1" ]]; then
  echo "Done: deleted $deleted event(s)."
  echo "Drive folders are in the trash — restore from the admin \"Deleted files\" page if this was a mistake."
else
  echo "Dry run: nothing changed. Re-run with --apply to delete."
fi
(( errors > 0 )) && echo "WARNING: $errors event(s) errored — see the HTTP lines above." >&2
exit 0
