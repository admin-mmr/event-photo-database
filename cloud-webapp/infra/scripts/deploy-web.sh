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
npm run build -w @cloud-webapp/web

echo "==> Deploying to Firebase Hosting + Firestore rules + Storage rules"
cd "$INFRA_DIR"
firebase deploy \
  --project="$PROJECT_ID" \
  --only=hosting,firestore:rules,firestore:indexes,storage \
  --non-interactive

echo "==> Web deploy complete"
