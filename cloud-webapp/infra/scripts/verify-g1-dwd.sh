#!/usr/bin/env bash
# Verify G1: domain-wide delegation for indexer-runtime SA (FACE_MATCHING_SETUP_RUNBOOK §G1).
# Mints a DWD access token keylessly (signJwt via your gcloud credentials), then:
#   1. lists the test event folder
#   2. creates + deletes a test file in _find_me_uploads
#
# Usage: ./verify-g1-dwd.sh <EVENT_FOLDER_ID> <UPLOADS_FOLDER_ID>
# Prereq (one-time): your gcloud user needs permission to sign as the SA:
#   gcloud iam service-accounts add-iam-policy-binding \
#     indexer-runtime@mmr-data-pipeline.iam.gserviceaccount.com \
#     --member="user:admin@mmrunners.org" \
#     --role="roles/iam.serviceAccountTokenCreator"
set -euo pipefail

SA="indexer-runtime@mmr-data-pipeline.iam.gserviceaccount.com"
SUBJECT="admin@mmrunners.org"   # Workspace user the SA impersonates
EVENT_FOLDER_ID="${1:?usage: $0 <EVENT_FOLDER_ID> <UPLOADS_FOLDER_ID>}"
UPLOADS_FOLDER_ID="${2:?usage: $0 <EVENT_FOLDER_ID> <UPLOADS_FOLDER_ID>}"

NOW=$(date +%s)
CLAIMS=$(mktemp)
cat > "$CLAIMS" <<EOF
{
  "iss": "$SA",
  "sub": "$SUBJECT",
  "scope": "https://www.googleapis.com/auth/drive",
  "aud": "https://oauth2.googleapis.com/token",
  "iat": $NOW,
  "exp": $((NOW + 3600))
}
EOF

echo "==> Signing DWD assertion as $SA (sub=$SUBJECT)..."
JWT=$(gcloud iam service-accounts sign-jwt "$CLAIMS" /dev/stdout --iam-account="$SA")
rm -f "$CLAIMS"

echo "==> Exchanging for access token..."
TOKEN=$(curl -sf https://oauth2.googleapis.com/token \
  -d "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer" \
  --data-urlencode "assertion=$JWT" | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
echo "    OK (token acquired — DWD grant is live)"

echo "==> Test 1: listing event folder $EVENT_FOLDER_ID..."
curl -sf -H "Authorization: Bearer $TOKEN" \
  "https://www.googleapis.com/drive/v3/files?q='$EVENT_FOLDER_ID'+in+parents+and+trashed=false&fields=files(id,name)&pageSize=5&supportsAllDrives=true&includeItemsFromAllDrives=true" \
  | python3 -m json.tool
echo "    OK"

echo "==> Test 2: writing test file to _find_me_uploads ($UPLOADS_FOLDER_ID)..."
FILE_ID=$(curl -sf -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"dwd-verify-$(date +%Y%m%d-%H%M%S).txt\",\"parents\":[\"$UPLOADS_FOLDER_ID\"]}" \
  "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
echo "    Created $FILE_ID — cleaning up..."
curl -sf -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://www.googleapis.com/drive/v3/files/$FILE_ID?supportsAllDrives=true"
echo "    OK (created and deleted)"

echo
echo "✅ G1 verified: SA can read the event folder and write to _find_me_uploads via DWD."
echo "   Check the box in FACE_MATCHING_SETUP_RUNBOOK.md §G1."
