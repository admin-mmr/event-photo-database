#!/usr/bin/env bash
#
# provision-derivatives-storage-class.sh — Autoclass with an ARCHIVE floor on the
# derivatives bucket, so photos nobody opens stop costing Standard/Nearline rates.
#
# Why this exists: `photos/orig/` is ~94% of the bucket's bytes and grows with
# every event (Aug 2026 alone added ~60 GiB). Autoclass was switched on by hand on
# 2026-08-06 with its default NEARLINE floor, so nothing ever got cheaper than
# $0.010/GB-mo. With an ARCHIVE floor, an object not read for 90 days moves to
# Coldline ($0.004) and after 365 days to Archive ($0.0012). Under Autoclass there
# are no retrieval or early-deletion fees: a read (gallery "Save to Photos", the
# bulk ZIP, outfit-tagger preparing head crops) just moves the object back to
# Standard. Nothing about URLs, signing or code changes.
#
# This script is the record of that configuration — until it existed, a bucket
# rebuilt from infra/scripts would have come back with no Autoclass at all.
#
# Idempotent and change-minimal: it reads the live state and only updates what
# differs. It deliberately passes --enable-autoclass only when Autoclass is OFF,
# so re-running it never re-toggles an already-enabled bucket.
#
# Usage:
#   ./infra/scripts/provision-derivatives-storage-class.sh <project-id> [bucket]
#
# Example:
#   ./infra/scripts/provision-derivatives-storage-class.sh mmr-data-pipeline

set -euo pipefail

PROJECT_ID="${1:-}"
BUCKET="${2:-${PROJECT_ID}-derivatives}"
TERMINAL_CLASS="ARCHIVE"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Usage: $0 <project-id> [bucket]" >&2
  exit 1
fi

BUCKET_URL="gs://${BUCKET}"
echo "==> Project: $PROJECT_ID  bucket: $BUCKET"

if ! gcloud storage buckets describe "$BUCKET_URL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "!!! Bucket $BUCKET_URL not found. Check the bucket name / DERIVATIVES_BUCKET." >&2
  exit 1
fi

read_state() {
  gcloud storage buckets describe "$BUCKET_URL" --project="$PROJECT_ID" \
    --format='value(autoclass.enabled,autoclass.terminalStorageClass)'
}

read -r ENABLED CURRENT_CLASS <<<"$(read_state)"
echo "==> Current: autoclass=${ENABLED:-False} terminal=${CURRENT_CLASS:-<none>}"

if [[ "$ENABLED" == "True" && "$CURRENT_CLASS" == "$TERMINAL_CLASS" ]]; then
  echo "==> Already autoclass=True terminal=${TERMINAL_CLASS}. Nothing to do."
  exit 0
fi

if [[ "$ENABLED" == "True" ]]; then
  gcloud storage buckets update "$BUCKET_URL" --project="$PROJECT_ID" \
    --autoclass-terminal-storage-class="$TERMINAL_CLASS"
else
  gcloud storage buckets update "$BUCKET_URL" --project="$PROJECT_ID" \
    --enable-autoclass --autoclass-terminal-storage-class="$TERMINAL_CLASS"
fi

read -r ENABLED CURRENT_CLASS <<<"$(read_state)"
if [[ "$ENABLED" != "True" || "$CURRENT_CLASS" != "$TERMINAL_CLASS" ]]; then
  echo "!!! Live state is autoclass=${ENABLED:-False} terminal=${CURRENT_CLASS:-<none>}, expected True/${TERMINAL_CLASS}." >&2
  exit 1
fi
echo "==> Done: autoclass=True terminal=${TERMINAL_CLASS} (verified against the live bucket)."
