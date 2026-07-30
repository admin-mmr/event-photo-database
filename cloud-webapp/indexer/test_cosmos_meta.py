"""
test_cosmos_meta.py — CosmosMeta against the semantics FirestoreMeta guarantees.

The indexer's metadata writes are where a Cosmos port can go wrong *quietly*.
Cosmos `upsert_item` REPLACES a document where Firestore's `set(merge=True)`
merges, and the reused-photo path calls `upsert_photo` with a PARTIAL patch — so a
replacing write drops `takenAt`/`contentHash`/`duplicateCount` and the gallery
keeps working, just sorted wrongly. Nothing throws. Hence these tests.

No SDK is installed (CI: `pip install numpy Pillow pytest`), which is why
`CosmosMeta` takes a database object and `from_env()` owns client construction.

Every case below is paired with the FirestoreMeta behaviour it must match; where
the two genuinely differ, the test says so.
"""

from __future__ import annotations

import pytest

from job import CosmosMeta, make_meta


class NotFound(Exception):
    """Stands in for azure.cosmos.exceptions.CosmosResourceNotFoundError, which
    the adapter matches by `status_code` rather than by type."""

    status_code = 404


class ServerError(Exception):
    status_code = 500


class FakeContainer:
    def __init__(self, partition_field: str):
        self.partition_field = partition_field
        self.items: dict[tuple[str, str], dict] = {}  # (pk, id) → body
        self.cross_partition_queries = 0
        self.upserts: list[dict] = []
        self.fail_reads_with: Exception | None = None

    # ── the CosmosClient surface the adapter uses ───────────────────────────

    def read_item(self, doc_id, partition_key):
        if self.fail_reads_with is not None:
            raise self.fail_reads_with
        body = self.items.get((str(partition_key), doc_id))
        if body is None:
            raise NotFound()
        return dict(body)

    def query_items(self, query, parameters, enable_cross_partition_query=False):
        assert enable_cross_partition_query, "a by-id lookup must span partitions"
        self.cross_partition_queries += 1
        wanted = next(p["value"] for p in parameters if p["name"] == "@id")
        return [dict(b) for (_pk, did), b in self.items.items() if did == wanted]

    def upsert_item(self, body):
        self.upserts.append(dict(body))
        pk = str(body.get(self.partition_field) or "")
        self.items[(pk, body["id"])] = dict(body)

    def delete_item(self, doc_id, partition_key):
        if self.items.pop((str(partition_key), doc_id), None) is None:
            raise NotFound()

    # ── test helpers ────────────────────────────────────────────────────────

    def seed(self, doc_id: str, body: dict) -> None:
        # `_etag`/`_ts` are Cosmos system properties; seeded so the adapter is
        # forced to strip them rather than writing them back.
        full = {"id": doc_id, "_etag": 'W/"1"', "_ts": 1, **body}
        # Compute the partition key from the FINAL body: `events` is partitioned
        # by /id, so it has to see the id that was just added.
        pk = str(full.get(self.partition_field) or "")
        self.items[(pk, doc_id)] = full

    def get(self, doc_id: str, pk: str) -> dict | None:
        return self.items.get((pk, doc_id))


class FakeDatabase:
    def __init__(self):
        self.containers = {
            "events": FakeContainer("id"),
            "photos": FakeContainer("eventId"),
        }

    def get_container_client(self, name):
        return self.containers[name]


@pytest.fixture()
def db() -> FakeDatabase:
    return FakeDatabase()


@pytest.fixture()
def meta(db: FakeDatabase) -> CosmosMeta:
    return CosmosMeta(db)


# ── get_event ────────────────────────────────────────────────────────────────

def test_get_event_returns_none_when_absent(meta):
    # FirestoreMeta returns None on `not snap.exists`; run() does
    # `fs.get_event(...) or {}`, so a raised 404 here would kill the run.
    assert meta.get_event("nope") is None


def test_get_event_strips_cosmos_system_properties(meta, db):
    # `id` is outside the body on Firestore and a reserved property on Cosmos, and
    # `_etag`/`_ts` have no Firestore analogue. get_event()'s result is read as a
    # plain document (`ev.get("name")`), so the shapes have to match.
    db.containers["events"].seed("e1", {"name": "Regatta", "driveFolderId": "fld1"})
    assert meta.get_event("e1") == {"name": "Regatta", "driveFolderId": "fld1"}


def test_get_event_is_a_point_read(meta, db):
    # `events` is partitioned by /id, so the id IS the partition key — no
    # cross-partition query should ever be needed here.
    db.containers["events"].seed("e1", {"name": "Regatta"})
    meta.get_event("e1")
    assert db.containers["events"].cross_partition_queries == 0


def test_a_non_404_read_error_propagates(meta, db):
    # Fail loudly: swallowing a 500 would make a transient outage look like
    # "event has no name / no folder" and silently mis-index.
    db.containers["events"].fail_reads_with = ServerError()
    with pytest.raises(ServerError):
        meta.get_event("e1")


# ── set_index_state ──────────────────────────────────────────────────────────

def test_set_index_state_creates_the_doc_when_absent(meta, db):
    meta.set_index_state("e1", {"status": "running"})
    body = db.containers["events"].get("e1", "e1")
    assert body["indexState"]["status"] == "running"
    assert body["indexState"]["updatedAt"]  # stamped, like FirestoreMeta


def test_set_index_state_keeps_other_event_fields(meta, db):
    # THE hazard: Firestore's merge=True leaves `name`/`driveFolderId` alone. A
    # replacing upsert would blank the event's name on every index run.
    db.containers["events"].seed("e1", {"name": "Regatta", "driveFolderId": "fld1"})
    meta.set_index_state("e1", {"status": "done", "photos": 12})
    body = db.containers["events"].get("e1", "e1")
    assert body["name"] == "Regatta"
    assert body["driveFolderId"] == "fld1"
    assert body["indexState"]["status"] == "done"


def test_set_index_state_replaces_the_whole_indexState_map(meta, db):
    # Firestore's merge is shallow: the path written is `indexState`, not
    # `indexState.status`, so the previous map is REPLACED. Deep-merging here
    # would let a stale `status: running` outlive a finished run — which is
    # exactly the state that blocks new triggers with 409 already_running.
    db.containers["events"].seed("e1", {"indexState": {"status": "running", "startedAt": "t0"}})
    meta.set_index_state("e1", {"status": "done"})
    state = db.containers["events"].get("e1", "e1")["indexState"]
    assert state["status"] == "done"
    assert "startedAt" not in state


def test_upserts_never_write_back_system_properties(meta, db):
    db.containers["events"].seed("e1", {"name": "Regatta"})
    meta.set_index_state("e1", {"status": "done"})
    written = db.containers["events"].upserts[-1]
    assert not [k for k in written if k.startswith("_")]


# ── set_event_name_if_empty ──────────────────────────────────────────────────

def test_sets_the_name_when_empty(meta, db):
    db.containers["events"].seed("e1", {"name": ""})
    assert meta.set_event_name_if_empty("e1", "Spring Run") is True
    assert db.containers["events"].get("e1", "e1")["name"] == "Spring Run"


def test_never_clobbers_an_existing_name(meta, db):
    # An admin or the Sheet reconciler owns the name; the Drive folder name is
    # only a default for events that have none (B5).
    db.containers["events"].seed("e1", {"name": "Admin Chosen"})
    assert meta.set_event_name_if_empty("e1", "Drive Folder") is False
    assert db.containers["events"].get("e1", "e1")["name"] == "Admin Chosen"


def test_a_blank_candidate_writes_nothing(meta, db):
    assert meta.set_event_name_if_empty("e1", "") is False
    assert db.containers["events"].upserts == []


def test_whitespace_only_stored_name_counts_as_empty(meta, db):
    db.containers["events"].seed("e1", {"name": "   "})
    assert meta.set_event_name_if_empty("e1", "Spring Run") is True


# ── upsert_photo ─────────────────────────────────────────────────────────────

FULL_DOC = {
    "eventId": "e1", "driveFileId": "p1", "name": "IMG_1.jpg", "md5": "abc",
    "contentHash": "abc", "duplicateCount": 0, "takenAt": "2026-06-20T10:00:00",
    "takenAtSource": "exif", "addedAt": "2026-06-21T09:00:00",
}


def test_a_full_doc_needs_no_cross_partition_query(meta, db):
    # The patch carries eventId, so the partition key is already in hand. This is
    # the hot path — one write per embedded photo, thousands per event.
    meta.upsert_photo("p1", dict(FULL_DOC))
    assert db.containers["photos"].cross_partition_queries == 0
    assert db.containers["photos"].get("p1", "e1")["name"] == "IMG_1.jpg"


def test_a_partial_patch_merges_instead_of_replacing(meta, db):
    # THE hazard this file exists for. job.py's reused-photo branch patches only
    # what changed; a replacing write silently drops takenAt/contentHash and the
    # gallery sorts wrongly with no error anywhere.
    db.containers["photos"].seed("p1", dict(FULL_DOC))
    meta.upsert_photo("p1", {"name": "20260620-100000_IMG_1.jpg", "relPath": "a/b"})
    body = db.containers["photos"].get("p1", "e1")
    assert body["name"] == "20260620-100000_IMG_1.jpg"
    assert body["relPath"] == "a/b"
    assert body["takenAt"] == FULL_DOC["takenAt"]
    assert body["contentHash"] == "abc"
    assert body["eventId"] == "e1"


def test_a_partial_patch_recovers_the_partition_key(meta, db):
    # `photos` is partitioned by /eventId but upsert_photo(pid, patch) has no
    # event in hand, so the key is recovered with a cross-partition lookup. Costs
    # RU, never correctness — the same trade the api adapter makes.
    db.containers["photos"].seed("p1", dict(FULL_DOC))
    meta.upsert_photo("p1", {"relPath": "a/b"})
    assert db.containers["photos"].cross_partition_queries == 1
    assert db.containers["photos"].get("p1", "e1")["relPath"] == "a/b"


def test_a_partial_patch_for_an_unknown_photo_writes_nothing(meta, db):
    # There is nothing to merge into and no event to file it under. Inventing a
    # partition (e.g. "") would strand the doc where no event-scoped query finds
    # it — invisible in the gallery and invisible to the next run's diff.
    meta.upsert_photo("ghost", {"relPath": "a/b"})
    assert db.containers["photos"].upserts == []


def test_photo_ids_are_preserved_as_the_document_id(meta, db):
    # photoId == Drive fileId everywhere (manifest rows, blob keys, api reads).
    meta.upsert_photo("1AbC-dEf_123", dict(FULL_DOC, driveFileId="1AbC-dEf_123"))
    assert db.containers["photos"].upserts[-1]["id"] == "1AbC-dEf_123"


# ── delete_photo ─────────────────────────────────────────────────────────────

def test_delete_removes_the_doc(meta, db):
    db.containers["photos"].seed("p1", dict(FULL_DOC))
    meta.delete_photo("p1")
    assert db.containers["photos"].get("p1", "e1") is None


def test_delete_of_an_unknown_photo_is_a_no_op(meta, db):
    # Firestore's delete is a no-op on a missing doc, and run() deletes photos it
    # believes vanished from Drive — a raise here would fail the whole run at the
    # very end, after all the embedding work.
    meta.delete_photo("ghost")  # must not raise


def test_delete_finds_the_partition_key(meta, db):
    db.containers["photos"].seed("p1", dict(FULL_DOC))
    meta.delete_photo("p1")
    assert db.containers["photos"].cross_partition_queries == 1


# ── backend selection ────────────────────────────────────────────────────────

def test_make_meta_defaults_to_firestore(monkeypatch):
    # The GCP deploy sets no CLOUD_PROVIDER. Selecting Cosmos by accident would
    # fail at import (no SDK) rather than silently, but the default still matters.
    monkeypatch.delenv("CLOUD_PROVIDER", raising=False)
    monkeypatch.setattr("job.FirestoreMeta", lambda: "firestore-instance")
    assert make_meta() == "firestore-instance"


def test_make_meta_selects_cosmos_on_azure(monkeypatch):
    monkeypatch.setenv("CLOUD_PROVIDER", "azure")
    monkeypatch.setattr("job.CosmosMeta.from_env", classmethod(lambda cls: "cosmos-instance"))
    assert make_meta() == "cosmos-instance"


def test_an_unknown_provider_falls_back_to_firestore(monkeypatch):
    monkeypatch.setenv("CLOUD_PROVIDER", "aws")
    monkeypatch.setattr("job.FirestoreMeta", lambda: "firestore-instance")
    assert make_meta() == "firestore-instance"
