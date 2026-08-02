#!/usr/bin/env bash
#
# audit-person-crops.sh — report which person-crop geometry each indexed event
# actually used, and flag any event whose manifest tag disagrees with its boxes.
#
# Usage:
#   ./infra/scripts/audit-person-crops.sh [project-id] [event-id …]
#
# Why this exists: `MODEL_VERSION` used to be a constant claiming `+yolov8n+`
# whether or not the detector had loaded. `yolov8n.onnx` was never staged, so
# every event was embedded with `expand_face_to_person` — a fixed 3x/7x blow-up of
# the face box — under a tag that said otherwise. Nothing in the system could tell
# the two apart, and it went unnoticed across 9 events / 9,574 photos / 55,270
# person crops.
#
# The tell is geometric and unambiguous: with the fallback, EVERY person box is
# exactly 3.00x the face width and 7.00x the face height. Real detections scatter.
# Run this after any re-index to confirm the detector really ran, rather than
# trusting the tag (which is now derived, but verify anyway — that is the point).
#
# Read-only: fetches each event's embeddings/manifest.json and does arithmetic.

set -euo pipefail

PROJECT_ID="${1:-mmr-data-pipeline}"
shift || true
DERIVATIVES="${DERIVATIVES_BUCKET:-gs://${PROJECT_ID}-derivatives}"

EVENTS=()
if [[ $# -gt 0 ]]; then
  EVENTS=("$@")
else
  # A read loop, not `mapfile`: the dev machine is macOS, whose bash is 3.2 and
  # has no mapfile/readarray (CLAUDE.md, "Local environment").
  while IFS= read -r ev; do
    [[ -n "$ev" ]] && EVENTS+=("$ev")
  done < <(gcloud storage ls "${DERIVATIVES}/" --project="$PROJECT_ID" 2>/dev/null \
    | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
fi

if [[ ${#EVENTS[@]} -eq 0 ]]; then
  echo "No events found under ${DERIVATIVES}/" >&2
  exit 1
fi

printf '%-10s %7s %7s %8s  %-13s %-22s %s\n' \
  EVENT PHOTOS FACES PERSONS RATIO GEOMETRY MODEL_VERSION
printf '%.0s-' {1..108}; echo

FALLBACK_COUNT=0
MISMATCH_COUNT=0
for ev in "${EVENTS[@]}"; do
  manifest="$(gcloud storage cat "${DERIVATIVES}/${ev}/embeddings/manifest.json" \
    --project="$PROJECT_ID" 2>/dev/null || true)"
  if [[ -z "$manifest" ]]; then
    printf '%-10s %7s %7s %8s  %-13s %-22s %s\n' "${ev:0:8}" - - - - "not-indexed" -
    continue
  fi
  # Exit code carries the verdict so the shell can tally: 3 = fallback geometry,
  # 4 = tag disagrees with the boxes (the dangerous case), 0 = clean.
  set +e
  line="$(EVENT="$ev" python3 -c '
import json, os, statistics, sys

m = json.load(sys.stdin)
faces, persons = m.get("faces") or [], m.get("persons") or []
version = m.get("modelVersion", "?")
photos = len(m.get("photos") or {})
if not faces or not persons:
    print("%-10s %7d %7d %8d  %-13s %-22s %s" % (os.environ["EVENT"][:8], photos,
          len(faces), len(persons), "-", "no-rows", version))
    sys.exit(0)

# Pair rows BY INDEX. The indexer appends one person row per face row in lockstep
# (hence the identical counts), so persons[i] is derived from faces[i]. Pairing by
# photoId instead — comparing every person box of a group shot against that
# photo`s FIRST face — mixes unrelated pairs, yields ratios like 2.84x/5.64y, and
# reports a clean bill of health for an event that is 100% fallback. That false
# all-clear is worse than no check, so the photoId equality below is an assertion,
# not a lookup key.
# Unequal counts are CONCLUSIVE evidence of a real detector, not a problem to
# report as "unpaired". The fallback derives exactly one person box per face box,
# so it can only ever produce equal counts; a detector finds people whose faces
# were never detected (back-turned, occluded, too small) and the person count
# rises above the face count. Report that as the success signal it is.
if len(faces) != len(persons):
    extra = len(persons) - len(faces)
    note = "detections +%d no-face" % extra if extra > 0 else "detections (%d fewer)" % -extra
    print("%-10s %7d %7d %8d  %-13s %-22s %s" % (os.environ["EVENT"][:8], photos,
          len(faces), len(persons), "n/a 1:1", note, version))
    sys.exit(0)

ratios = []
if len(faces) == len(persons):
    for f, p in list(zip(faces, persons))[:500]:
        if f.get("photoId") != p.get("photoId"):
            continue
        fw, fh = f["box"][2] - f["box"][0], f["box"][3] - f["box"][1]
        if fw > 0 and fh > 0:
            ratios.append(((p["box"][2] - p["box"][0]) / fw, (p["box"][3] - p["box"][1]) / fh))
if not ratios:
    print("%-10s %7d %7d %8d  %-13s %-22s %s" % (os.environ["EVENT"][:8], photos,
          len(faces), len(persons), "-", "unpaired/count-mismatch", version))
    sys.exit(0)

rw = statistics.median(r[0] for r in ratios)
rh = statistics.median(r[1] for r in ratios)
# expand_face_to_person makes every box exactly 3x the face width and 7x its
# height — but it CLAMPS to the image, so a person at the frame edge comes out
# smaller. Spread is therefore not a usable discriminator (a big event has plenty
# of edge crops, which is why an earlier spread<0.02 test cleared 8 of 9 fallback
# events). What clamping cannot do is EXCEED the ratio, so the tell is the share of
# pairs sitting exactly on 3.0/7.0; a real detector hits both simultaneously
# essentially never.
exact = sum(1 for a, b in ratios if abs(a - 3.0) < 1e-6 and abs(b - 7.0) < 1e-6)
exact_share = exact / len(ratios)
is_fallback = exact_share >= 0.25 and rw <= 3.0 + 1e-6 and rh <= 7.0 + 1e-6
geometry = ("FACE-EXPAND %d%%" % round(exact_share * 100)) if is_fallback else "detections"
claims_detector = "yolov8n" in version
mismatch = is_fallback and claims_detector
if mismatch:
    geometry = geometry + " TAG-LIES"
print("%-10s %7d %7d %8d  %s %-22s %s" % (os.environ["EVENT"][:8], photos,
      len(faces), len(persons), ("%.2fx/%.2fy" % (rw, rh)).ljust(13), geometry, version))
sys.exit(4 if mismatch else (3 if is_fallback else 0))
' <<<"$manifest")"
  rc=$?
  set -e
  echo "$line"
  [[ $rc -eq 3 || $rc -eq 4 ]] && FALLBACK_COUNT=$((FALLBACK_COUNT + 1)) || true
  [[ $rc -eq 4 ]] && MISMATCH_COUNT=$((MISMATCH_COUNT + 1)) || true
done

echo
if [[ $MISMATCH_COUNT -gt 0 ]]; then
  echo "!! $MISMATCH_COUNT event(s) are tagged '+yolov8n+' but their boxes are face expansions." >&2
  echo "   Those embeddings were produced WITHOUT a person detector. Stage yolov8n.onnx" >&2
  echo "   and re-index (FORCE_REINDEX=1) — the outfit half of Find-Me is degraded until then." >&2
  exit 1
elif [[ $FALLBACK_COUNT -gt 0 ]]; then
  echo "$FALLBACK_COUNT event(s) use the face-expand fallback, honestly tagged '+faceexpand+'."
  echo "Re-index them once a person detector is staged to get real person crops."
else
  echo "All events used a real person detector."
fi
