#!/usr/bin/env bash
#
# sweep-expired-selfies.sh — delete Find-Me reference selfies past retention.
#
# Drives POST /api/admin/findme/retention/sweep, which enforces PRD §8.4:
# a stored selfie is kept 90 days for an adult and 30 days for a minor, then the
# GCS object is deleted and after it the find_me_uploads record.
#
# Why this exists: nothing enforced the tiers. The uploads bucket's lifecycle is
# a flat 90 days, so a minor's selfie outlived its 30-day tier by two months, and
# the Firestore TTL the runbook described was never enabled (it also could not
# have worked — `expiresAt` is a string, and a TTL only acts on a Timestamp).
# Do NOT enable a TTL on find_me_uploads now: it would delete the record and
# leave the selfie with nothing pointing at it.
#
# DRY RUN BY DEFAULT: prints what is overdue. Pass --apply to delete.
#
# Usage:
#   ./infra/scripts/sweep-expired-selfies.sh            # dry run
#   ./infra/scripts/sweep-expired-selfies.sh --apply    # delete
#
# The daily `findme-reference-retention` scheduler job does the same apply
# (provision-reference-retention-scheduler.sh); this is for a first clean-up or a
# manual run.
#
# Auth: needs `gcloud` logged in. The api call uses the machine token
# (SYNC_TRIGGER_TOKEN) from Secret Manager (roles/secretmanager.secretAccessor);
# override with SYNC_TOKEN=... if you prefer.
#
# Tunables (env): PROJECT, API_BASE, SECRET, MAX_RUNS.
#
# Each call is deadline-bounded (~40s, inside the 60s Hosting ceiling) and
# reports `remaining`; the script repeats until nothing is left.

set -euo pipefail

PROJECT="${PROJECT:-mmr-data-pipeline}"
API_BASE="${API_BASE:-https://mmr-data-pipeline.web.app}"
SECRET="${SECRET:-SYNC_TRIGGER_TOKEN}"
MAX_RUNS="${MAX_RUNS:-20}"

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "ERROR: unknown argument '$arg'" >&2; exit 1 ;;
  esac
done

for bin in gcloud curl python3; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: '$bin' not found on PATH" >&2; exit 1; }
done

if [[ -z "${SYNC_TOKEN:-}" ]]; then
  SYNC_TOKEN="$(gcloud secrets versions access latest --secret="$SECRET" --project="$PROJECT" 2>/dev/null | tr -d '\n' || true)"
fi
if [[ -z "${SYNC_TOKEN:-}" ]]; then
  echo "ERROR: couldn't read the $SECRET secret; pass SYNC_TOKEN=... instead." >&2
  exit 1
fi

RESP_FILE="$(mktemp -t selfie-sweep-XXXXXX)"
trap 'rm -f "$RESP_FILE"' EXIT

call() {
  local body="$1" code
  code="$(curl -sS -o "$RESP_FILE" -w '%{http_code}' \
    -X POST "$API_BASE/api/admin/findme/retention/sweep" \
    -H "X-Sync-Token: $SYNC_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body" || echo "000")"
  if [[ "$code" != "200" ]]; then
    echo "ERROR: HTTP $code from the sweep:" >&2
    cat "$RESP_FILE" >&2; echo >&2
    exit 1
  fi
}

field() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$RESP_FILE" "$1"
}

echo "Project: $PROJECT   API: $API_BASE"

if [[ "$APPLY" == "0" ]]; then
  call '{}'
  echo "DRY RUN — nothing deleted."
  echo "  records scanned:  $(field scanned)"
  echo "  past retention:   $(field expired)  (minor $(field expiredMinor), adult $(field expiredAdult))"
  echo "  longest overdue:  expired $(field oldestExpiry)"
  [[ "$(field capped)" == "True" ]] && echo "  NOTE: scan hit its cap — more may exist beyond it."
  echo "Re-run with --apply to delete them."
  exit 0
fi

total_deleted=0; total_failed=0
for (( run = 1; run <= MAX_RUNS; run++ )); do
  call '{"apply":true}'
  deleted="$(field deleted)"; failed="$(field failed)"; remaining="$(field remaining)"
  total_deleted=$(( total_deleted + deleted )); total_failed=$(( total_failed + failed ))
  echo "  pass $run: deleted $deleted, failed $failed, remaining $remaining"
  [[ "$remaining" == "0" ]] && break
done

echo "Done: deleted $total_deleted, failed $total_failed."
if (( total_failed > 0 )); then
  echo "Failed deletes kept their records and are retried on the next run; see the api logs" >&2
  echo "for 'retention: selfie delete failed'." >&2
  exit 1
fi
