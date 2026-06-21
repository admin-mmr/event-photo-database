#!/usr/bin/env bash
#
# deploy-web.sh — build the React SPA and deploy to Firebase Hosting.
# Also deploys Firestore rules/indexes and Storage rules.
#
# Usage:
#   ./infra/scripts/deploy-web.sh <project-id>

set -euo pipefail

PROJECT_ID="${1:-}"
if [[ -z "$PROJECT_ID" ]]; then
  echo "Usage: $0 <project-id>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${INFRA_DIR}/.." && pwd)"

echo "==> Building web bundle"
cd "$REPO_ROOT"
# VITE_RECAPTCHA_SITE_KEY is baked into the bundle at build time and must match
# the api service's RECAPTCHA_SITE_KEY, or /api/findme/search returns 403
# ("We could not verify this request"). It is a public value. Export it before
# running this script, e.g.:
#   export VITE_RECAPTCHA_SITE_KEY="$(gcloud run services describe event-photo-api \
#     --region=us-central1 --project="$PROJECT_ID" \
#     --format='value(spec.template.spec.containers[0].env)' \
#     | tr ',' '\n' | sed -n 's/.*RECAPTCHA_SITE_KEY=//p')"
if [[ -z "${VITE_RECAPTCHA_SITE_KEY:-}" ]]; then
  echo "WARNING: VITE_RECAPTCHA_SITE_KEY is not set — Find Me search will 403 if" >&2
  echo "         the api service has reCAPTCHA enabled. Export it before deploying." >&2
fi
VITE_RECAPTCHA_SITE_KEY="${VITE_RECAPTCHA_SITE_KEY:-}" npm run build -w @cloud-webapp/web

echo "==> Deploying to Firebase Hosting + Firestore rules + Storage rules"
# firebase.json lives at the repo root (cloud-webapp/) because the CLI requires
# the hosting public dir (web/dist) to be inside the project directory.
cd "$REPO_ROOT"
firebase deploy \
  --project="$PROJECT_ID" \
  --only=hosting,firestore:rules,firestore:indexes,storage \
  --non-interactive

echo "==> Web deploy complete"
