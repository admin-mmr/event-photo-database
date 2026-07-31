"""Tests for the outfit store: URI parsing parity, local round-trip, index shape."""

from __future__ import annotations

import json
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from store import (  # noqa: E402
    BlobIO,
    CROPS_FILE,
    INDEX_FILE,
    OutfitIndex,
    OutfitStore,
    build_index,
    load_matcher_manifest,
    manifest_path,
    outfit_path,
    parse_root,
    write_outfit,
)

ACCT = "https://acct.blob.core.windows.net"


def test_uri_parsing_matches_matcher(monkeypatch):
    """We read the same derivatives root the matcher and indexer do, so all three
    parsers must agree. They are duplicated on purpose (separate deployables,
    separate Docker build contexts — see the store.py docstring), which is exactly
    why this test exists."""
    matcher_dir = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "matcher"
    )
    sys.path.insert(0, matcher_dir)
    try:
        import store as matcher_store
    finally:
        sys.path.remove(matcher_dir)

    monkeypatch.setenv("AZURE_STORAGE_ACCOUNT_URL", ACCT)
    for root in (
        "/tmp/derivs",
        "gs://bkt",
        "gs://bkt/pre",
        "az://derivatives",
        "az://derivatives/pre",
        f"{ACCT}/derivatives",
        f"{ACCT}/derivatives/pre/fix",
        "http://127.0.0.1:10000/devstoreaccount1/derivatives",
    ):
        mine, theirs = parse_root(root), matcher_store.parse_root(root)
        assert mine[0] == theirs[0], root
        # Ours returns a NamedTuple for azure, the matcher a plain tuple; compare
        # as tuples where both are tuples, by value for the local-dir string.
        mine_v = tuple(mine[1]) if isinstance(mine[1], tuple) else mine[1]
        theirs_v = tuple(theirs[1]) if isinstance(theirs[1], tuple) else theirs[1]
        assert mine_v == theirs_v, root


def test_az_root_requires_account_url(monkeypatch):
    monkeypatch.delenv("AZURE_STORAGE_ACCOUNT_URL", raising=False)
    with pytest.raises(ValueError, match="AZURE_STORAGE_ACCOUNT_URL"):
        parse_root("az://derivatives")


def test_local_blob_roundtrip(tmp_path):
    blobs = BlobIO(str(tmp_path))
    assert blobs.backend == "local"
    assert not blobs.exists("e1/outfit/index.json")
    blobs.write("e1/outfit/index.json", b"{}", "application/json")
    assert blobs.exists("e1/outfit/index.json")
    assert blobs.read("e1/outfit/index.json") == b"{}"


def _write_manifest(tmp_path, event_id: str, manifest: dict) -> None:
    path = tmp_path / manifest_path(event_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest), encoding="utf-8")


def test_load_matcher_manifest(tmp_path):
    _write_manifest(tmp_path, "e1", {"modelVersion": "m1", "persons": [], "faces": []})
    manifest = load_matcher_manifest(BlobIO(str(tmp_path)), "e1")
    assert manifest["modelVersion"] == "m1"


def test_load_matcher_manifest_missing_is_explicit(tmp_path):
    with pytest.raises(FileNotFoundError, match="index the event first"):
        load_matcher_manifest(BlobIO(str(tmp_path)), "nope")


def _index_with(rows, dim=4):
    vectors = np.eye(len(rows), dim, dtype=np.float32) if rows else np.zeros((0, dim), np.float32)
    index = build_index("e1", "o1", "m1", rows, photos=len({r["photoId"] for r in rows}))
    return OutfitIndex(index, vectors)


def test_index_rejects_length_mismatch():
    index = build_index("e1", "o1", "m1", [{"photoId": "p1", "region": "person"}], photos=1)
    with pytest.raises(ValueError, match="length mismatch"):
        OutfitIndex(index, np.zeros((3, 4), np.float32))


def test_region_mask_filters_region_and_small():
    ev = _index_with(
        [
            {"photoId": "p1", "region": "person"},
            {"photoId": "p1", "region": "head", "small": True},
            {"photoId": "p2", "region": "head"},
        ]
    )
    assert ev.region_mask(None, include_small=True).tolist() == [True, True, True]
    assert ev.region_mask(None, include_small=False).tolist() == [True, False, True]
    assert ev.region_mask("head", include_small=True).tolist() == [False, True, True]
    assert ev.region_mask("person", include_small=False).tolist() == [True, False, False]


def test_missing_small_key_is_not_small():
    """Absent ≠ bad: an index written before the flag existed must keep every row,
    not silently exclude all of them."""
    ev = _index_with([{"photoId": "p1", "region": "person"}])
    assert ev.region_mask(None, include_small=False).tolist() == [True]


def test_vectors_for_photo_respects_region():
    ev = _index_with(
        [
            {"photoId": "p1", "region": "person"},
            {"photoId": "p1", "region": "head"},
            {"photoId": "p2", "region": "person"},
        ]
    )
    assert len(ev.vectors_for_photo("p1")) == 2
    assert len(ev.vectors_for_photo("p1", "head")) == 1
    assert len(ev.vectors_for_photo("absent")) == 0


def test_sims_are_cosines_against_unit_rows():
    vectors = np.array([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)
    ev = OutfitIndex(
        build_index("e1", "o1", "m1", [{"photoId": "a"}, {"photoId": "b"}], photos=2), vectors
    )
    sims = ev.sims(np.array([1.0, 0.0], dtype=np.float32))
    assert sims.tolist() == pytest.approx([1.0, 0.0])
    # An unnormalized query is normalized before scoring, so scale cannot inflate.
    assert ev.sims(np.array([5.0, 0.0], np.float32)).tolist() == pytest.approx([1.0, 0.0])


def test_write_then_load_roundtrip(tmp_path):
    blobs = BlobIO(str(tmp_path))
    rows = [{"photoId": "p1", "region": "person", "box": [0, 0, 10, 20]}]
    vectors = np.array([[0.6, 0.8]], dtype=np.float32)
    write_outfit(blobs, "e1", build_index("e1", "o1", "m1", rows, photos=1), vectors)

    assert blobs.exists(outfit_path("e1", CROPS_FILE))
    assert blobs.exists(outfit_path("e1", INDEX_FILE))

    store = OutfitStore(str(tmp_path))
    assert store.is_prepared("e1")
    ev = store.load_event("e1")
    assert len(ev) == 1
    assert ev.model_version == "o1"
    assert ev.source_model_version == "m1"
    np.testing.assert_allclose(ev.vectors, vectors)


def test_unprepared_event_is_a_clear_error(tmp_path):
    store = OutfitStore(str(tmp_path))
    assert not store.is_prepared("e1")
    with pytest.raises(FileNotFoundError, match="not prepared"):
        store.load_event("e1")


def test_load_event_is_cached_and_invalidatable(tmp_path):
    blobs = BlobIO(str(tmp_path))
    write_outfit(
        blobs,
        "e1",
        build_index("e1", "o1", "m1", [{"photoId": "p1", "region": "person"}], photos=1),
        np.array([[1.0, 0.0]], dtype=np.float32),
    )
    store = OutfitStore(str(tmp_path))
    first = store.load_event("e1")
    assert store.load_event("e1") is first
    store.invalidate("e1")
    assert store.load_event("e1") is not first
