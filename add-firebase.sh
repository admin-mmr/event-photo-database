#!/usr/bin/env bash
# Adds Firebase to mmr-data-pipeline while temporarily relaxing the
# iam.allowedPolicyMemberDomains (Domain Restricted Sharing) org policy,
# then restores the org-inherited policy no matter how the script exits.
set -uo pipefail

PROJECT="mmr-data-pipeline"
CONSTRAINT="iam.allowedPolicyMemberDomains"
MAX_WAIT=900      # give up after 15 min (max org-policy propagation)
INTERVAL=30       # seconds between addFirebase attempts

restore() {
  echo ">>> Restoring org-inherited Domain Restricted Sharing on ${PROJECT}..."
  gcloud org-policies delete "${CONSTRAINT}" --project="${PROJECT}" --quiet \
    && echo ">>> Override removed; project re-inherits org policy." \
    || echo "!!! WARNING: failed to remove override. Run manually: gcloud org-policies delete ${CONSTRAINT} --project=${PROJECT}"
}
trap restore EXIT

# 1. Apply the allowAll override at the project level.
TMP_POLICY="$(mktemp /tmp/allow-all-domains.XXXXXX.yaml)"
cat > "${TMP_POLICY}" <<YAML
name: projects/${PROJECT}/policies/${CONSTRAINT}
spec:
  rules:
    - allowAll: true
YAML

echo ">>> Applying allowAll override..."
gcloud org-policies set-policy "${TMP_POLICY}" || { echo "set-policy failed"; exit 1; }
rm -f "${TMP_POLICY}"

# 2. Poll addFirebase until it succeeds or we hit MAX_WAIT.
echo ">>> Waiting for policy to propagate, then retrying addFirebase..."
elapsed=0
until firebase projects:addfirebase "${PROJECT}"; do
  if [ "${elapsed}" -ge "${MAX_WAIT}" ]; then
    echo "!!! Still failing after ${MAX_WAIT}s. The cause is likely NOT this org policy."
    echo "    Check firebase-debug.log for a different error before retrying."
    exit 1
  fi
  echo "    Not ready yet (${elapsed}s elapsed) — retrying in ${INTERVAL}s..."
  sleep "${INTERVAL}"
  elapsed=$(( elapsed + INTERVAL ))
done

echo ">>> Firebase added successfully."
# restore() runs automatically via the EXIT trap.
