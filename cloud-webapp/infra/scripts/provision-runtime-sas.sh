#!/usr/bin/env bash
# E2 (FACE_MATCHING_SETUP_RUNBOOK.md): create least-privilege runtime service
# accounts and grant their roles. Idempotent — safe to re-run.
# Usage: ./provision-runtime-sas.sh [PROJECT_ID]
set -euo pipefail

PROJECT_ID="${1:-${PROJECT_ID:?Usage: $0 PROJECT_ID (or export PROJECT_ID)}}"

echo "==> Creating runtime service accounts in ${PROJECT_ID}..."
for SA in api-runtime matcher-runtime indexer-runtime; do
  gcloud iam service-accounts create "$SA" \
    --project="$PROJECT_ID" \
    --display-name="Find Me $SA" 2>/dev/null \
    && echo "    created: $SA" \
    || echo "    exists:  $SA"
done

grant() {  # grant SA_NAME ROLE...
  local sa="$1"; shift
  for ROLE in "$@"; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
      --member="serviceAccount:${sa}@${PROJECT_ID}.iam.gserviceaccount.com" \
      --role="$ROLE" --condition=None --quiet >/dev/null
    echo "    ${sa} += ${ROLE}"
  done
}

echo "==> api-runtime: Firestore, Cloud SQL, Storage, Secrets, invoke matcher, Pub/Sub publish"
grant api-runtime \
  roles/datastore.user roles/cloudsql.client roles/storage.objectAdmin \
  roles/secretmanager.secretAccessor roles/run.invoker roles/pubsub.publisher

echo "==> matcher-runtime: Cloud SQL, read uploads, secrets"
grant matcher-runtime \
  roles/cloudsql.client roles/storage.objectViewer roles/secretmanager.secretAccessor

echo "==> indexer-runtime: Cloud SQL, write derivatives, Firestore"
grant indexer-runtime \
  roles/cloudsql.client roles/storage.objectAdmin roles/datastore.user

echo "==> Done. Verify:"
echo "    gcloud iam service-accounts list --project=${PROJECT_ID} --filter='runtime'"
