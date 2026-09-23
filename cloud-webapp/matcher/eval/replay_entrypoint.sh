#!/usr/bin/env bash
#
# replay_entrypoint.sh — entrypoint for the replay Cloud Run job image
# (eval/Dockerfile.replay). Prepares the inputs, then runs the T-norm/PRF replay.
#
# Env (set by run-replay-job.sh):
#   PROJECT         (required) GCP project
#   EVENT_ID        (required) event to replay
#   DERIVATIVES     store root         (default gs://$PROJECT-derivatives)
#   UPLOADS_BUCKET  selfie bucket      (default $PROJECT-uploads)
#   K               P@K                (default 20)
#   REFS_PER_USER   selfies per uid    (default 1)
#   REPORT_GCS      optional gs:// path to upload the JSON report to
#   EVAL_ARGS       run_eval.py analyses to add after --judged-only
#                   (default "--tnorm --prf"), e.g.
#                   "--tnorm --anchor-promotion --face-quality-weight 0.25;0.5;1.0"
set -euo pipefail

: "${PROJECT:?set PROJECT}"
: "${EVENT_ID:?set EVENT_ID}"
DERIVATIVES="${DERIVATIVES:-gs://${PROJECT}-derivatives}"
UPLOADS_BUCKET="${UPLOADS_BUCKET:-${PROJECT}-uploads}"
K="${K:-20}"
REFS_PER_USER="${REFS_PER_USER:-1}"
read -r -a EXTRA <<< "${EVAL_ARGS:---tnorm --prf}"
OUT=/tmp/replay

echo "==> Preparing labels + query selfies for $EVENT_ID"
python eval/prepare_replay.py \
  --project "$PROJECT" \
  --event-id "$EVENT_ID" \
  --uploads-bucket "$UPLOADS_BUCKET" \
  --derivatives "$DERIVATIVES" \
  --out-dir "$OUT" \
  --refs-per-user "$REFS_PER_USER" \
  --k "$K"

echo "==> Replaying (judged-only ${EXTRA[*]})"
python eval/run_eval.py \
  --store "$DERIVATIVES" \
  --event-id "$EVENT_ID" \
  --labels "$OUT/labels-$EVENT_ID.csv" \
  --queries "$OUT/queries" \
  --k "$K" \
  --judged-only "${EXTRA[@]}" \
  --report "$OUT/report.json"

if [[ -n "${REPORT_GCS:-}" ]]; then
  echo "==> Uploading report to $REPORT_GCS"
  python - "$OUT/report.json" "$REPORT_GCS" <<'PY'
import sys
from google.cloud import storage
src, dst = sys.argv[1], sys.argv[2]
assert dst.startswith("gs://"), dst
bucket, _, path = dst[len("gs://"):].partition("/")
storage.Client().bucket(bucket).blob(path).upload_from_filename(src)
print(f"report uploaded to {dst}")
PY
fi
echo "==> Done. Read the T-norm operating-point table: it scores the production threshold at each fusion weight."
