#!/usr/bin/env bash
#
# sweep-stranded-derivatives.sh — delete derivative objects in the derivatives
# bucket that no live photo points at.
#
# The indexer writes three objects per photo (`photos/orig|web|thumb/<photoId>`),
# and until the removal sweep landed in indexer/job.py nothing ever collected
# them again: a photo that left Drive — or a byte-identical duplicate that stopped
# being the canonical copy — had its Firestore doc deleted and its objects left
# behind forever. Only a whole-event delete swept them. The mirrored original is
# ~94% of the bucket's bytes, so each stranding cost real storage.
#
# The indexer now sweeps as photos leave, so this script is a ONE-OFF for the
# backlog that accumulated before that fix — objects whose photoId is in no
# manifest, which no future run will ever look at again.
#
# WHAT MAKES AN OBJECT SAFE TO DELETE — all four must hold:
#   1. its photoId is absent from the event's embeddings/manifest.json `photos`
#      map (so the live index does not list it);
#   2. there is NO Firestore `photos/<photoId>` document — the authoritative
#      check, because `download.ts` reads that doc before it signs any URL, and
#      404s when it is missing. A doc means something can still ask for the bytes;
#   3. the event's index is NOT in flight (see below);
#   4. the object is older than MIN_AGE_HOURS (see below).
# Only `photos/{orig,web,thumb}/` are considered. `embeddings/` and `outfit/` are
# never touched — the matcher and outfit-tagger own those.
#
# WHY THE IN-FLIGHT AND AGE GUARDS EXIST: the indexer writes a photo's objects
# during the run but writes the manifest only at the END. So mid-run there is a
# window where a brand-new photo's objects exist, the (still old) manifest does
# not mention it, and its Firestore doc may not be written yet — it would look
# exactly like a stranded object and deleting it would silently destroy that
# run's work. An event whose indexState is queued/running is therefore SKIPPED
# outright, and objects newer than MIN_AGE_HOURS (default 24) are never deleted
# even on an idle event. Two independent guards, because the first one relies on
# indexState being accurate and a crashed run can leave it stale.
#
# DRY RUN BY DEFAULT: prints what it would delete, and its size. Pass --apply.
#
# RECOVERY: the bucket has soft delete enabled (7 days), so an --apply run is
# reversible for a week — but only via the GCS soft-delete API, not the admin UI.
# Verify the window before relying on it:
#   gcloud storage buckets describe gs://<project>-derivatives \
#     --format='value(soft_delete_policy.retentionDurationSeconds)'
#
# Usage:
#   ./infra/scripts/sweep-stranded-derivatives.sh                  # dry run, all events
#   ./infra/scripts/sweep-stranded-derivatives.sh ev123            # dry run, one event
#   ./infra/scripts/sweep-stranded-derivatives.sh --apply ev123    # delete, one event
#   ./infra/scripts/sweep-stranded-derivatives.sh --apply          # delete, all events
#   YES=1 ./infra/scripts/sweep-stranded-derivatives.sh --apply    # no confirmation prompt
#
# Auth: needs `gcloud` logged in with read/write on the derivatives bucket and
# read on Firestore. Unlike the Drive-side tools this talks to GCS and Firestore
# directly — there is no api route and no machine token involved.
#
# Tunables (env): PROJECT, BUCKET, MIN_AGE_HOURS, WORKERS.

set -euo pipefail

PROJECT="${PROJECT:-mmr-data-pipeline}"
BUCKET="${BUCKET:-${PROJECT}-derivatives}"
MIN_AGE_HOURS="${MIN_AGE_HOURS:-24}"
WORKERS="${WORKERS:-16}"

APPLY=0
EVENTS=()
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n '2,60p' "$0"; exit 0 ;;
    -*) echo "ERROR: unknown flag '$arg'" >&2; exit 1 ;;
    *) EVENTS+=("$arg") ;;
  esac
done

for bin in gcloud python3; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: '$bin' not found on PATH" >&2; exit 1; }
done

TOKEN="$(gcloud auth print-access-token 2>/dev/null)" || {
  echo "ERROR: 'gcloud auth print-access-token' failed — run 'gcloud auth login'." >&2
  exit 1
}

echo "Project: $PROJECT"
echo "Bucket:  gs://$BUCKET"
echo "Guards:  skip in-flight events; keep objects newer than ${MIN_AGE_HOURS}h"
if [[ "$APPLY" == "1" ]]; then
  echo "Mode:    APPLY — stranded objects will be deleted (soft-deleted, recoverable ~7d)"
else
  echo "Mode:    DRY RUN — nothing will be changed (pass --apply to delete)"
fi

if [[ "$APPLY" == "1" && "${YES:-0}" != "1" ]]; then
  printf 'Delete stranded derivative objects from gs://%s? [y/N] ' "$BUCKET"
  read -r reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Aborted."; exit 0; }
fi

SWEEP_TOKEN="$TOKEN" SWEEP_PROJECT="$PROJECT" SWEEP_BUCKET="$BUCKET" \
SWEEP_APPLY="$APPLY" SWEEP_MIN_AGE_HOURS="$MIN_AGE_HOURS" SWEEP_WORKERS="$WORKERS" \
SWEEP_EVENTS="$(IFS=,; printf '%s' "${EVENTS[*]-}")" python3 - <<'PY'
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

TOKEN = os.environ["SWEEP_TOKEN"]
PROJECT = os.environ["SWEEP_PROJECT"]
BUCKET = os.environ["SWEEP_BUCKET"]
APPLY = os.environ["SWEEP_APPLY"] == "1"
MIN_AGE_HOURS = float(os.environ["SWEEP_MIN_AGE_HOURS"])
WORKERS = max(1, int(os.environ["SWEEP_WORKERS"]))
EVENTS = [e for e in os.environ.get("SWEEP_EVENTS", "").split(",") if e]

FS = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"
GCS = f"https://storage.googleapis.com/storage/v1/b/{urllib.parse.quote(BUCKET, safe='')}/o"
KINDS = ("orig", "web", "thumb")
CUTOFF = datetime.now(timezone.utc) - timedelta(hours=MIN_AGE_HOURS)


def call(url: str, method: str = "GET", body: dict | None = None) -> dict | None:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {TOKEN}"}
    if data:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def list_events() -> list[str]:
    out, page = [], ""
    while True:
        url = f"{FS}/events?pageSize=300" + (f"&pageToken={page}" if page else "")
        d = call(url) or {}
        for doc in d.get("documents", []):
            out.append(doc["name"].rsplit("/", 1)[-1])
        page = d.get("nextPageToken", "")
        if not page:
            return out


def index_in_flight(event_id: str) -> tuple[bool, str]:
    """Is this event mid-index? Objects written by a live run are not yet in any
    manifest, so they must not be judged stranded. An UNPARSEABLE or missing
    state counts as in flight — an unknown state must never license deletion."""
    doc = call(f"{FS}/events/{urllib.parse.quote(event_id)}")
    if doc is None:
        return True, "no event doc"
    state = doc.get("fields", {}).get("indexState", {}).get("mapValue", {}).get("fields", {})
    status = state.get("status", {}).get("stringValue", "")
    if not status:
        return False, "no indexState (never indexed by this pipeline)"
    if status in ("queued", "running"):
        return True, f"index {status}"
    return False, f"index {status}"


def read_manifest(event_id: str) -> dict | None:
    name = urllib.parse.quote(f"{event_id}/embeddings/manifest.json", safe="")
    req = urllib.request.Request(f"{GCS}/{name}?alt=media",
                                headers={"Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def list_objects(prefix: str) -> list[dict]:
    out, page = [], ""
    while True:
        url = (f"{GCS}?prefix={urllib.parse.quote(prefix, safe='')}"
               "&fields=items(name,size,timeCreated),nextPageToken&maxResults=1000"
               + (f"&pageToken={page}" if page else ""))
        d = call(url) or {}
        out.extend(d.get("items", []))
        page = d.get("nextPageToken", "")
        if not page:
            return out


def firestore_photo_ids(ids: list[str]) -> set[str]:
    """Which of `ids` still have a photos/<id> doc. THE decisive check: the
    download routes read this doc before signing a URL, so a doc means the bytes
    are still reachable. Batched — one request per 100 ids, not per id."""
    found: set[str] = set()
    for i in range(0, len(ids), 100):
        chunk = ids[i:i + 100]
        body = {"documents": [f"projects/{PROJECT}/databases/(default)/documents/photos/{p}"
                              for p in chunk]}
        for row in call(f"{FS}:batchGet", "POST", body) or []:
            if "found" in row:
                found.add(row["found"]["name"].rsplit("/", 1)[-1])
    return found


def delete_object(name: str) -> str | None:
    try:
        call(f"{GCS}/{urllib.parse.quote(name, safe='')}", "DELETE")
        return None
    except Exception as exc:  # noqa: BLE001
        return f"{name}: {exc}"


def human(n: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(n) < 1024 or unit == "TiB":
            return f"{n:.2f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024


events = EVENTS or sorted(list_events())
if not events:
    print("No events found — nothing to do.")
    sys.exit(0)

print(f"Events:  {len(events)}")

grand_bytes = grand_objs = grand_deleted = grand_failed = 0
skipped: list[str] = []

for n, event_id in enumerate(events, 1):
    print(f"\n[{n}/{len(events)}] {event_id}")

    in_flight, why = index_in_flight(event_id)
    if in_flight:
        print(f"  SKIP — {why}; a live run's objects are not yet in any manifest")
        skipped.append(f"{event_id} ({why})")
        continue

    manifest = read_manifest(event_id)
    if manifest is None:
        # Without a manifest there is no way to tell a live object from a
        # stranded one, and guessing here deletes photos.
        print("  SKIP — no embeddings/manifest.json; cannot tell live from stranded")
        skipped.append(f"{event_id} (no manifest)")
        continue

    live = set(manifest.get("photos", {}))
    dup_ids = {i for v in manifest.get("duplicates", {}).values() for i in v}

    # Group every object by the photoId encoded in its name.
    by_photo: dict[str, list[dict]] = {}
    for kind in KINDS:
        for obj in list_objects(f"{event_id}/photos/{kind}/"):
            stem = obj["name"].rsplit("/", 1)[-1]
            pid = stem.rsplit(".", 1)[0]
            if pid:
                by_photo.setdefault(pid, []).append(obj)

    candidates = sorted(set(by_photo) - live)
    if not candidates:
        print(f"  clean — {len(live)} live photo(s), no stranded objects")
        continue

    # The decisive Firestore check, then the age guard.
    still_referenced = firestore_photo_ids(candidates)
    stranded: list[dict] = []
    too_new = 0
    for pid in candidates:
        if pid in still_referenced:
            continue
        for obj in by_photo[pid]:
            created = datetime.fromisoformat(obj["timeCreated"].replace("Z", "+00:00"))
            if created > CUTOFF:
                too_new += 1
                continue
            stranded.append(obj)

    ev_bytes = sum(int(o["size"]) for o in stranded)
    held = len(still_referenced)
    print(f"  {len(live)} live photo(s); {len(candidates)} photoId(s) not in the manifest"
          f" — {held} still have a Firestore doc (kept)")
    if too_new:
        print(f"  {too_new} object(s) newer than {MIN_AGE_HOURS:g}h — kept by the age guard")
    overlap = len({p for p in candidates if p in dup_ids} - still_referenced)
    if overlap:
        print(f"  {overlap} of these are collapsed byte-identical duplicates"
              " (their bytes also live under the canonical photoId)")
    if not stranded:
        print("  nothing to delete after the guards")
        continue

    print(f"  {len(stranded)} stranded object(s), {human(ev_bytes)}")
    for obj in stranded[:10]:
        print(f"    - {obj['name']} ({human(int(obj['size']))})")
    if len(stranded) > 10:
        print(f"    … and {len(stranded) - 10} more")

    grand_objs += len(stranded)
    grand_bytes += ev_bytes

    if not APPLY:
        continue

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        errors = [e for e in pool.map(lambda o: delete_object(o["name"]), stranded) if e]
    grand_deleted += len(stranded) - len(errors)
    grand_failed += len(errors)
    for err in errors[:5]:
        print(f"    FAILED {err}")
    print(f"  deleted {len(stranded) - len(errors)} object(s), {len(errors)} failure(s)")

print()
if APPLY:
    print(f"Done: deleted {grand_deleted} object(s), {human(grand_bytes)} reclaimed,"
          f" {grand_failed} failure(s).")
    print("Soft-deleted — recoverable from GCS for the bucket's retention window (~7d).")
else:
    print(f"Dry run: {grand_objs} object(s), {human(grand_bytes)} would be deleted."
          " Re-run with --apply to do it.")
if skipped:
    print(f"Skipped {len(skipped)} event(s): {', '.join(skipped)}")
sys.exit(1 if grand_failed else 0)
PY
