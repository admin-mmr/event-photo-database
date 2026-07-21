"""Tests for prepare_replay.py — pure logic + prepare() with an injected
download callback, so nothing touches Firestore or GCS."""

import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from prepare_replay import _ext_from, prepare, select_reference_uploads  # noqa: E402

EVENT = "ev1"


def _feedback():
    return [
        {"uid": "alice", "eventId": EVENT, "photoId": "p1.jpg", "verdict": "confirmed", "runId": "r1"},
        {"uid": "alice", "eventId": EVENT, "photoId": "p2.jpg", "verdict": "not_me", "runId": "r1"},
        {"uid": "bob", "eventId": EVENT, "photoId": "p3.jpg", "verdict": "confirmed", "runId": "r2"},
        {"uid": "carol", "eventId": EVENT, "photoId": "p4.jpg", "verdict": "confirmed", "runId": "r3"},
        {"uid": "alice", "eventId": "other", "photoId": "p9.jpg", "verdict": "confirmed", "runId": "r4"},
    ]


def _uploads():
    return [
        {"uploadId": "u-a1", "uid": "alice", "gcsPath": "find_me_references/alice/u-a1.jpg", "eventId": "old", "createdAt": "2026-01-01"},
        {"uploadId": "u-a2", "uid": "alice", "gcsPath": "find_me_references/alice/u-a2.png", "eventId": EVENT, "createdAt": "2026-02-01"},
        {"uploadId": "u-b1", "uid": "bob", "gcsPath": "find_me_references/bob/u-b1.jpg", "eventId": "old", "createdAt": "2026-03-01"},
        # carol has no upload → should be reported missing.
        {"uploadId": "u-z1", "uid": "zoe", "gcsPath": "find_me_references/zoe/u-z1.jpg", "eventId": EVENT, "createdAt": "2026-04-01"},
    ]


# ── select_reference_uploads ────────────────────────────────────────────────────

def test_prefers_this_event_then_recency():
    chosen = select_reference_uploads(_uploads(), {"alice", "bob"}, EVENT, refs_per_user=1)
    # alice has one 'old' and one this-event upload → the this-event one wins.
    assert [u["uploadId"] for u in chosen["alice"]] == ["u-a2"]
    assert [u["uploadId"] for u in chosen["bob"]] == ["u-b1"]


def test_excludes_uids_not_in_set():
    chosen = select_reference_uploads(_uploads(), {"alice"}, EVENT)
    assert set(chosen) == {"alice"}  # zoe/bob not requested


def test_refs_per_user_cap():
    ups = [
        {"uploadId": f"u{i}", "uid": "alice", "gcsPath": f"x/u{i}.jpg", "eventId": EVENT, "createdAt": f"2026-0{i}-01"}
        for i in range(1, 5)
    ]
    chosen = select_reference_uploads(ups, {"alice"}, EVENT, refs_per_user=2)
    assert len(chosen["alice"]) == 2
    # Newest two by createdAt.
    assert [u["uploadId"] for u in chosen["alice"]] == ["u4", "u3"]


# ── _ext_from ────────────────────────────────────────────────────────────────────

def test_ext_from_path_then_contenttype_then_default():
    assert _ext_from({"gcsPath": "a/b/c.PNG"}) == "png"
    assert _ext_from({"gcsPath": "a/b/c", "contentType": "image/webp"}) == "webp"
    assert _ext_from({"gcsPath": "a/b/c"}) == "jpg"


# ── prepare ────────────────────────────────────────────────────────────────────

def test_prepare_writes_labels_and_queries(tmp_path):
    downloaded: list[tuple[str, str]] = []

    def fake_download(gcs_path: str, dest: str) -> None:
        downloaded.append((gcs_path, dest))
        with open(dest, "wb") as f:
            f.write(b"fake-image")

    summary = prepare(
        _feedback(), {}, _uploads(), EVENT, str(tmp_path), fake_download, refs_per_user=1
    )

    # 4 judged rows for ev1 (alice x2, bob, carol); alice's 'other'-event vote excluded.
    assert summary["labels"] == 4
    assert summary["users"] == 3  # alice, bob, carol
    # carol has no stored selfie → missing; alice+bob downloaded.
    assert summary["missing_refs"] == ["carol"]
    assert summary["queries_written"] == 2
    assert summary["download_errors"] == []

    # labels.csv is well-formed and event-scoped.
    with open(summary["labels_csv"], newline="", encoding="utf-8") as f:
        label_rows = list(csv.DictReader(f))
    assert {r["photoId"] for r in label_rows} == {"p1.jpg", "p2.jpg", "p3.jpg", "p4.jpg"}
    assert {r["label"] for r in label_rows} == {"confirmed", "wrong"}

    # queries/<uid>/ layout, alice got her this-event .png.
    assert os.path.isfile(os.path.join(summary["queries_dir"], "alice", "u-a2.png"))
    assert os.path.isfile(os.path.join(summary["queries_dir"], "bob", "u-b1.jpg"))
    assert not os.path.isdir(os.path.join(summary["queries_dir"], "carol"))


def test_prepare_reports_download_failures(tmp_path):
    def flaky_download(gcs_path: str, dest: str) -> None:
        if "bob" in gcs_path:
            raise RuntimeError("boom")
        with open(dest, "wb") as f:
            f.write(b"x")

    summary = prepare(_feedback(), {}, _uploads(), EVENT, str(tmp_path), flaky_download)
    assert summary["queries_written"] == 1  # alice ok, bob failed
    assert len(summary["download_errors"]) == 1 and "bob" in summary["download_errors"][0]


def test_prepare_empty_when_no_feedback_for_event(tmp_path):
    summary = prepare(_feedback(), {}, _uploads(), "nonexistent", str(tmp_path), lambda *a: None)
    assert summary["labels"] == 0 and summary["queries_written"] == 0
