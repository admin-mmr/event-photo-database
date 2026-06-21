#!/usr/bin/env bash
#
# verify-drive-access.sh — sanity-check the indexer's Google Drive access.
#
# Google Drive is the source of truth for photos and STAYS on Google even after
# the Azure migration (the org's Workspace shared drives aren't moving). So the
# indexer still authenticates to Drive with a Google service account; what
# changes on Azure is only WHERE that credential lives: instead of GCP
# domain-wide delegation via keyless signJwt, the SA's JSON key (or an OAuth
# client) is stored in Key Vault and mounted into the indexer job as a secret
# (env GOOGLE_APPLICATION_CREDENTIALS pointing at the mounted file).
#
# This script lists the test event folder and creates+deletes a probe file in
# the uploads folder, using whatever credential the indexer would use.
#
# Usage:
#   ./infra/scripts/verify-drive-access.sh <EVENT_FOLDER_ID> <UPLOADS_FOLDER_ID>
#
# Prereq (one-time): seed the Drive SA credential into Key Vault, then this
# script reads it locally to test:
#   az keyvault secret set --vault-name <kv> --name DRIVE-SA-JSON --file sa.json
set -euo pipefail

KEY_VAULT="${KEY_VAULT:-kv-mmr-${NAME_SUFFIX:-}}"
EVENT_FOLDER_ID="${1:?usage: $0 <EVENT_FOLDER_ID> <UPLOADS_FOLDER_ID>}"
UPLOADS_FOLDER_ID="${2:?usage: $0 <EVENT_FOLDER_ID> <UPLOADS_FOLDER_ID>}"
SUBJECT="${DRIVE_SUBJECT:-admin@mmrunners.org}"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
SA_JSON="$WORKDIR/sa.json"

echo "==> Fetching Drive SA credential from Key Vault ($KEY_VAULT/DRIVE-SA-JSON)"
az keyvault secret show --vault-name "$KEY_VAULT" --name DRIVE-SA-JSON \
  --query value -o tsv > "$SA_JSON"

echo "==> Verifying Drive access as $SUBJECT (lists event folder, probe-writes uploads folder)"
GOOGLE_APPLICATION_CREDENTIALS="$SA_JSON" \
DRIVE_SUBJECT="$SUBJECT" \
python3 - "$EVENT_FOLDER_ID" "$UPLOADS_FOLDER_ID" <<'PY'
import os, sys, json
from google.oauth2 import service_account
from googleapiclient.discovery import build

event_folder, uploads_folder = sys.argv[1], sys.argv[2]
creds = service_account.Credentials.from_service_account_file(
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"],
    scopes=["https://www.googleapis.com/auth/drive"],
    subject=os.environ.get("DRIVE_SUBJECT"),
)
drive = build("drive", "v3", credentials=creds)
res = drive.files().list(q=f"'{event_folder}' in parents", pageSize=5,
                         fields="files(id,name)", supportsAllDrives=True,
                         includeItemsFromAllDrives=True).execute()
print("event folder contents:", [f["name"] for f in res.get("files", [])])
meta = {"name": "_probe.txt", "parents": [uploads_folder]}
f = drive.files().create(body=meta, fields="id", supportsAllDrives=True).execute()
print("created probe file id:", f["id"])
drive.files().delete(fileId=f["id"], supportsAllDrives=True).execute()
print("deleted probe file — Drive read+write OK")
PY
echo "==> Drive access verified."
