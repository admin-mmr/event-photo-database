#!/usr/bin/env python3
"""
export_feedback_labels.py — turn Find Me user feedback into eval labels
(EVAL_FEEDBACK_LOOP.md §4, dev plan M4.4).

Reads the `match_feedback` collection (one immutable vote per result: verdict
`confirmed` | `not_me`, keyed to a `match_runs` run) and emits, per event, a
judged-labels CSV consumed by `run_eval.py --judged-only`:

    photoId,person,label,model_version,tier,run_id,uid

`person` is the searcher's uid (the query side is their real Find Me upload).
Label mapping follows §4b:

    confirmed  + reason me/unset      -> 'confirmed'  (judged positive)
    not_me                            -> 'wrong'      (judged negative)
    confirmed  + reason friend/group  -> EXCLUDED     (positive for someone else / uncertain)

It also prints the **judged precision** per event straight from the votes —
confirmed / (confirmed + wrong) — with the evidence bar from §3 (>= 20 judged
pairs from >= 5 distinct users) so a number is only shown when meaningful. No
matcher replay is needed for this metric; replay (run_eval) is for re-tuning
fusion weights against accumulated labels.

Two input modes (so it runs in CI without GCP):
    --project <gcp-project>             read live Firestore
    --feedback-json f [--runs-json r]   read exported docs from JSON arrays

Usage:
    python eval/export_feedback_labels.py --project mmr-data-pipeline --out-dir eval/labels
    python eval/export_feedback_labels.py --feedback-json fb.json --out-dir /tmp/labels
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import defaultdict
from typing import Any, Iterable

# Tag reasons that must NOT enter judged precision (§4b).
EXCLUDED_REASONS = {"friend", "group"}
# Evidence bar before a judged number is meaningful (§3).
MIN_JUDGED_PAIRS = 20
MIN_DISTINCT_USERS = 5

LABEL_FIELDS = ["photoId", "person", "label", "model_version", "tier", "run_id", "uid", "search_version"]


def verdict_to_label(verdict: str, reason: str | None) -> str | None:
    """Map a feedback (verdict, reason) to a judged label, or None to exclude."""
    v = (verdict or "").strip().lower()
    r = (reason or "").strip().lower()
    if v == "not_me":
        return "wrong"
    if v == "confirmed":
        return None if r in EXCLUDED_REASONS else "confirmed"
    return None  # unknown verdict — ignore


def build_label_rows(
    feedback: Iterable[dict[str, Any]],
    runs_by_id: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, str]]:
    """Join feedback votes to their run (for model_version) and map to label rows.

    `model_version`/`tier` come from the feedback row if present, else from the
    referenced run, else ''. Rows whose verdict/reason are excluded are dropped.
    """
    runs_by_id = runs_by_id or {}
    rows: list[dict[str, str]] = []
    for fb in feedback:
        label = verdict_to_label(str(fb.get("verdict", "")), fb.get("reason") or fb.get("tagReason"))
        if label is None:
            continue
        run = runs_by_id.get(str(fb.get("runId") or ""), {})
        model_version = str(fb.get("modelVersion") or run.get("modelVersion") or "")
        tier = str(fb.get("tier") or "")
        # Retrieval-algorithm generation the vote was cast under (§1.1–1.3). The
        # api denormalizes `searchVersion` onto the feedback doc at click time;
        # fall back to the feedback/run `algo.version` for votes written before
        # that, then to '' (pre-versioning — treat as the old pipeline).
        search_version = str(
            fb.get("searchVersion")
            or (fb.get("algo") or {}).get("version")
            or (run.get("algo") or {}).get("version")
            or ""
        )
        rows.append(
            {
                "photoId": str(fb.get("photoId", "")),
                "person": str(fb.get("uid", "")),
                "label": label,
                "model_version": model_version,
                "tier": tier,
                "run_id": str(fb.get("runId") or ""),
                "uid": str(fb.get("uid", "")),
                "search_version": search_version,
                # event kept out of LABEL_FIELDS (one CSV per event), tracked here:
                "_eventId": str(fb.get("eventId", "")),
            }
        )
    return rows


def judged_precision(rows: list[dict[str, str]]) -> dict[str, Any]:
    """Judged P over a set of label rows: confirmed / (confirmed + wrong)."""
    confirmed = sum(1 for r in rows if r["label"] == "confirmed")
    wrong = sum(1 for r in rows if r["label"] == "wrong")
    pairs = confirmed + wrong
    users = len({r["person"] for r in rows if r["person"]})
    meaningful = pairs >= MIN_JUDGED_PAIRS and users >= MIN_DISTINCT_USERS
    return {
        "confirmed": confirmed,
        "wrong": wrong,
        "judged_pairs": pairs,
        "distinct_users": users,
        "precision": (confirmed / pairs) if pairs else None,
        "meaningful": meaningful,
    }


def group_by_event(rows: list[dict[str, str]]) -> dict[str, list[dict[str, str]]]:
    out: dict[str, list[dict[str, str]]] = defaultdict(list)
    for r in rows:
        out[r["_eventId"]].append(r)
    return dict(out)


def write_event_csv(out_dir: str, event_id: str, rows: list[dict[str, str]]) -> str:
    os.makedirs(out_dir, exist_ok=True)
    safe = event_id or "_no_event"
    path = os.path.join(out_dir, f"labels-{safe}.csv")
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=LABEL_FIELDS)
        w.writeheader()
        for r in rows:
            w.writerow({k: r[k] for k in LABEL_FIELDS})
    return path


# ── input loaders ────────────────────────────────────────────────────────────


def _load_json_array(path: str) -> list[dict[str, Any]]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise SystemExit(f"ERROR: {path} must contain a JSON array of documents")
    return data


def load_from_firestore(project: str) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    try:
        from google.cloud import firestore  # type: ignore
    except ImportError:
        raise SystemExit(
            "ERROR: --project needs google-cloud-firestore "
            "(pip install google-cloud-firestore), or use --feedback-json for offline."
        )
    db = firestore.Client(project=project)
    feedback = [d.to_dict() | {"id": d.id} for d in db.collection("match_feedback").stream()]
    runs = {d.id: d.to_dict() for d in db.collection("match_runs").stream()}
    return feedback, runs


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--project", default="", help="GCP project to read live Firestore")
    p.add_argument("--feedback-json", default="", help="offline: JSON array of match_feedback docs")
    p.add_argument("--runs-json", default="", help="offline: JSON array of match_runs docs (optional)")
    p.add_argument("--out-dir", default="eval/labels", help="where per-event CSVs are written")
    p.add_argument("--report", default="", help="optional JSON summary path")
    p.add_argument(
        "--search-version",
        default="",
        help="keep only votes whose search_version has this prefix (e.g. '2026.07') — "
        "restricts the labels to a retrieval-pipeline generation so old-algorithm "
        "votes don't confound judged precision. Empty = keep all.",
    )
    args = p.parse_args()

    if args.project:
        feedback, runs_by_id = load_from_firestore(args.project)
    elif args.feedback_json:
        feedback = _load_json_array(args.feedback_json)
        runs_list = _load_json_array(args.runs_json) if args.runs_json else []
        runs_by_id = {str(r.get("id") or r.get("runId") or ""): r for r in runs_list}
    else:
        raise SystemExit("ERROR: provide --project OR --feedback-json")

    rows = build_label_rows(feedback, runs_by_id)
    if args.search_version:
        before = len(rows)
        rows = [r for r in rows if r["search_version"].startswith(args.search_version)]
        print(
            f"Filtered to search_version prefix '{args.search_version}': "
            f"{len(rows)} of {before} labels kept\n"
        )
    by_event = group_by_event(rows)

    summary: dict[str, Any] = {"events": {}}
    print(f"Exported {len(rows)} judged labels across {len(by_event)} event(s)\n")
    for event_id, ev_rows in sorted(by_event.items()):
        path = write_event_csv(args.out_dir, event_id, ev_rows)
        jp = judged_precision(ev_rows)
        summary["events"][event_id] = {**jp, "csv": path}
        p_str = f"{jp['precision']:.3f}" if jp["precision"] is not None else "n/a"
        bar = "" if jp["meaningful"] else "  (below evidence bar — not meaningful yet)"
        print(
            f"  {event_id or '(no event)'}: judged P@20={p_str}  "
            f"[{jp['confirmed']} confirmed / {jp['wrong']} wrong, "
            f"{jp['judged_pairs']} pairs, {jp['distinct_users']} users]{bar}\n    → {path}"
        )

    if args.report:
        with open(args.report, "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=2)
        print(f"\nSummary written to {args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
