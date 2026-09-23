#!/usr/bin/env python3
"""
prepare_replay.py — assemble the inputs run_eval.py needs to replay a real
event and tune T-norm / measure PRF (FACE_RECOGNITION_IMPROVEMENT_ANALYSIS
§1.2/§1.3).

It turns live Firestore + the uploads bucket into the two things run_eval
can't derive itself:

  <out-dir>/labels-<event-id>.csv  judged labels (photoId,person,label,…) — the
                                confirmed/wrong votes for the event
  <out-dir>/queries/<uid>/…     each judged searcher's reference selfie(s),
                                the query side of the replay

Then it prints the exact `run_eval.py … --judged-only --tnorm --prf` command,
pointing --store straight at the derivatives bucket (store.py reads gs://).

`person` in the labels is the searcher's uid, so queries/<uid>/ lines up with
the label rows. Only searchers who actually have a stored reference selfie
contribute a query; the rest are reported and skipped (run_eval skips labeled
people with no reference photo anyway).

Two modes (mirrors export_feedback_labels.py so it runs in tests without GCP):
    --project <gcp-project>                      read live Firestore + GCS
    --feedback-json f --uploads-json u [...]     read exported docs offline

Usage (live):
    python eval/prepare_replay.py --project mmr-data-pipeline \
        --event-id 81a584f7-b9e8-4f18-9744-8002693364ba \
        --uploads-bucket mmr-data-pipeline-uploads \
        --derivatives gs://mmr-data-pipeline-derivatives \
        --out-dir /tmp/replay
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from typing import Any, Callable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from export_feedback_labels import build_label_rows, write_event_csv  # noqa: E402

# find_me_uploads rows may predate the `outcome` field; treat missing as matched
# (same convention as api/src/services/references.ts).
DEFAULT_REFS_PER_USER = 1


def rank_reference_uploads(
    uploads: list[dict[str, Any]],
    uids: set[str],
    event_id: str,
) -> dict[str, list[dict[str, Any]]]:
    """Every stored selfie of each judged searcher, in the order to try them.

    For every uid we take that user's own find_me_uploads, preferring the ones
    first uploaded FOR this event (a reused selfie has a different eventId, so it
    sorts after but is still eligible as a fallback), then most recent. A uid with
    no stored upload is simply absent (reported by the caller).

    The whole list is returned, not just the head, because a doc can outlive its
    bytes: the uploads bucket deletes objects 90 days after UPLOAD, so a searcher
    whose event-time selfie is gone may still have a newer one from another
    event. That is the same face, and it is what keeps a months-old event
    replayable at all."""
    by_uid: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for up in uploads:
        uid = str(up.get("uid", ""))
        if uid in uids and up.get("gcsPath"):
            by_uid[uid].append(up)

    for ups in by_uid.values():
        ups.sort(
            key=lambda u: (u.get("eventId") == event_id, str(u.get("createdAt") or "")),
            reverse=True,  # this-event first, then most recent
        )
    return dict(by_uid)


def select_reference_uploads(
    uploads: list[dict[str, Any]],
    uids: set[str],
    event_id: str,
    refs_per_user: int = DEFAULT_REFS_PER_USER,
) -> dict[str, list[dict[str, Any]]]:
    """The first `refs_per_user` of `rank_reference_uploads` for each uid — the
    selfies to use when every one of them still exists."""
    ranked = rank_reference_uploads(uploads, uids, event_id)
    return {uid: ups[: max(1, refs_per_user)] for uid, ups in ranked.items()}


def _ext_from(upload: dict[str, Any]) -> str:
    """Filename extension for a downloaded selfie — off the stored gcsPath, else
    the contentType, else .jpg. (run_eval only cares that it's a decodable image.)"""
    path = str(upload.get("gcsPath") or "")
    _, dot, ext = path.rpartition(".")
    if dot and 1 <= len(ext) <= 5:
        return ext.lower()
    ct = str(upload.get("contentType") or "")
    return {"image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif"}.get(ct, "jpg")


def prepare(
    feedback: list[dict[str, Any]],
    runs_by_id: dict[str, dict[str, Any]],
    uploads: list[dict[str, Any]],
    event_id: str,
    out_dir: str,
    download: Callable[[str, str], None],
    refs_per_user: int = DEFAULT_REFS_PER_USER,
) -> dict[str, Any]:
    """Write labels.csv + queries/<uid>/… under out_dir; return a summary.

    `download(gcs_path, dest_path)` fetches one selfie — injected so tests run
    without GCS. Selfie download failures are collected, not fatal (a missing
    reference just drops that searcher's query)."""
    rows = [r for r in build_label_rows(feedback, runs_by_id) if r["_eventId"] == event_id]
    if not rows:
        return {"eventId": event_id, "labels": 0, "users": 0, "queries_written": 0, "missing_refs": [], "download_errors": []}

    os.makedirs(out_dir, exist_ok=True)
    labels_path = write_event_csv(out_dir, event_id, rows)

    uids = {r["person"] for r in rows if r["person"]}
    ranked = rank_reference_uploads(uploads, uids, event_id)
    want = max(1, refs_per_user)

    queries_dir = os.path.join(out_dir, "queries")
    written = 0
    fallbacks = 0
    with_refs: set[str] = set()
    download_errors: list[str] = []
    for uid, ups in ranked.items():
        udir = os.path.join(queries_dir, uid)
        got = 0
        for pos, up in enumerate(ups):
            if got >= want:
                break
            gcs_path = str(up["gcsPath"])
            os.makedirs(udir, exist_ok=True)
            dest = os.path.join(udir, f"{up.get('uploadId', 'ref')}.{_ext_from(up)}")
            try:
                download(gcs_path, dest)
            except Exception as exc:  # noqa: BLE001 — best-effort per selfie; try the next
                download_errors.append(f"{uid}:{gcs_path}: {exc}")
                continue
            written += 1
            got += 1
            if pos >= want:  # a preferred selfie was gone and a later one stood in
                fallbacks += 1
        if got:
            with_refs.add(uid)
        elif os.path.isdir(udir) and not os.listdir(udir):
            os.rmdir(udir)  # no empty query dirs: run_eval would count them as people

    return {
        "eventId": event_id,
        "labels": len(rows),
        "users": len(uids),
        "users_with_refs": len(with_refs),
        "queries_written": written,
        "fallbacks": fallbacks,
        "labels_csv": labels_path,
        "queries_dir": queries_dir,
        # No stored upload at all vs uploads whose bytes are all gone.
        "missing_refs": sorted(uids - set(ranked)),
        "no_live_ref": sorted(set(ranked) - with_refs),
        "download_errors": download_errors,
    }


# ── live loaders ──────────────────────────────────────────────────────────────


def _load_firestore(project: str, event_id: str) -> tuple[list[dict], dict[str, dict], list[dict]]:
    try:
        from google.cloud import firestore  # type: ignore
    except ImportError:
        raise SystemExit(
            "ERROR: --project needs google-cloud-firestore (pip install google-cloud-firestore)."
        )
    db = firestore.Client(project=project)
    # Scope the feedback read to the event; runs/uploads are small enough to pull whole.
    feedback = [
        d.to_dict() | {"id": d.id}
        for d in db.collection("match_feedback").where("eventId", "==", event_id).stream()
    ]
    runs = {d.id: d.to_dict() for d in db.collection("match_runs").stream()}
    uploads = [d.to_dict() | {"uploadId": d.id} for d in db.collection("find_me_uploads").stream()]
    return feedback, runs, uploads


def _gcs_downloader(project: str, bucket_name: str) -> Callable[[str, str], None]:
    from google.cloud import storage  # type: ignore

    bucket = storage.Client(project=project).bucket(bucket_name)

    def _dl(gcs_path: str, dest: str) -> None:
        bucket.blob(gcs_path).download_to_filename(dest)

    return _dl


def _load_json_array(path: str) -> list[dict[str, Any]]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise SystemExit(f"ERROR: {path} must be a JSON array")
    return data


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--event-id", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--project", default="", help="GCP project (live Firestore + GCS)")
    p.add_argument("--uploads-bucket", default="", help="reference-selfie bucket (default <project>-uploads)")
    p.add_argument("--derivatives", default="", help="store root for the printed run_eval command (gs://…-derivatives)")
    p.add_argument("--refs-per-user", type=int, default=DEFAULT_REFS_PER_USER)
    p.add_argument("--feedback-json", default="", help="offline: match_feedback docs")
    p.add_argument("--runs-json", default="", help="offline: match_runs docs (optional)")
    p.add_argument("--uploads-json", default="", help="offline: find_me_uploads docs")
    p.add_argument("--k", type=int, default=20, help="K for the printed run_eval command")
    args = p.parse_args()

    if args.project:
        feedback, runs_by_id, uploads = _load_firestore(args.project, args.event_id)
        bucket = args.uploads_bucket or f"{args.project}-uploads"
        download = _gcs_downloader(args.project, bucket)
    elif args.feedback_json and args.uploads_json:
        feedback = _load_json_array(args.feedback_json)
        runs_list = _load_json_array(args.runs_json) if args.runs_json else []
        runs_by_id = {str(r.get("id") or r.get("runId") or ""): r for r in runs_list}
        uploads = _load_json_array(args.uploads_json)
        raise SystemExit(
            "ERROR: offline mode has no GCS to download selfies from — use --project, "
            "or import prepare() directly with your own download callback (see tests)."
        )
    else:
        raise SystemExit("ERROR: provide --project OR (--feedback-json AND --uploads-json)")

    summary = prepare(
        feedback, runs_by_id, uploads, args.event_id, args.out_dir, download, args.refs_per_user
    )

    print(f"Event {args.event_id}:")
    print(f"  judged labels: {summary['labels']}  ({summary['users']} searchers)")
    covered = summary.get("users_with_refs", 0)
    print(f"  reference selfies downloaded: {summary['queries_written']} for {covered}/{summary['users']} searchers"
          f" ({summary.get('fallbacks', 0)} via a newer selfie after the preferred one was gone)")
    if summary["missing_refs"]:
        print(f"  ⚠️  {len(summary['missing_refs'])} searchers have NO stored selfie (skipped).")
    if summary.get("no_live_ref"):
        print(f"  ⚠️  {len(summary['no_live_ref'])} searchers' selfies have ALL been deleted "
              "(the uploads bucket drops objects 90 days after upload) — skipped.")
    if summary["download_errors"]:
        print(f"  {len(summary['download_errors'])} selfie download(s) failed; first: {summary['download_errors'][0]}")
    if summary["labels"] == 0:
        print("  Nothing to replay (no judged feedback for this event).")
        return 1

    store = args.derivatives or "gs://<project>-derivatives"
    print("\nNow run the replay (needs the ONNX models — MODEL_DIR, or the matcher-image job):")
    print(
        f"  python eval/run_eval.py --store {store} --event-id {args.event_id} "
        f"--labels {summary['labels_csv']} --queries {summary['queries_dir']} "
        f"--k {args.k} --judged-only --tnorm --prf --report {os.path.join(args.out_dir, 'report.json')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
