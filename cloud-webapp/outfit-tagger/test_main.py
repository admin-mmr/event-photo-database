"""Tests for the /detect and /status endpoints, with a fake encoder bundle.

No ONNX and no model files: the encoders are stubbed so these tests exercise the
request handling, query construction, and fusion wiring — the parts that break
when the contract changes. Encoder correctness is checked at export time by
scripts/export_siglip.py's parity assertions.
"""

from __future__ import annotations

import io
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import main as main_mod  # noqa: E402
import scoring  # noqa: E402
import siglip  # noqa: E402
from store import BlobIO, build_index, write_outfit  # noqa: E402
from store import OutfitStore  # noqa: E402

DIM = 4


class FakeVision:
    """Embeds an image as a fixed direction, chosen by the image's mean pixel so
    different uploads produce different queries."""

    dim = DIM

    def __init__(self):
        self.calls = 0

    def embed(self, img):
        self.calls += 1
        bucket = int(np.asarray(img).mean()) % DIM
        vec = np.zeros(DIM, dtype=np.float32)
        vec[bucket] = 1.0
        return vec


class FakeText:
    dim = DIM

    def __init__(self):
        self.calls: list[str] = []

    def embed(self, text):
        self.calls.append(text)
        vec = np.zeros(DIM, dtype=np.float32)
        vec[len(text) % DIM] = 1.0
        return vec


class FakeBundle:
    def __init__(self, with_text=True, version="siglip_test@o1"):
        self.vision = FakeVision()
        self.text = FakeText() if with_text else None
        self.version = version
        self.dim = DIM


ROWS = [
    {"photoId": "p1", "region": "person", "box": [0, 0, 10, 20]},
    {"photoId": "p2", "region": "person", "box": [0, 0, 10, 20]},
    {"photoId": "p1", "region": "head", "box": [1, 1, 5, 5]},
    {"photoId": "p3", "region": "head", "box": [1, 1, 5, 5], "small": True},
]
# Row i is the i-th basis vector, so a query of basis vector k ranks row k first.
VECTORS = np.eye(len(ROWS), DIM, dtype=np.float32)


def test_text_calibration_is_computed_once_and_reported(client):
    """Text must be scaled by the event's query-independent background, and that
    background must be computed once per process rather than per request."""
    bundle = siglip.load_encoders()
    before = len(bundle.text.calls)
    first = client.post("/detect", data={"event_id": "e1", "text": "abc"}).get_json()
    after_first = len(bundle.text.calls)
    second = client.post("/detect", data={"event_id": "e1", "text": "abcd"}).get_json()
    after_second = len(bundle.text.calls)

    assert "textCalibration" in first
    assert first["textCalibration"] == second["textCalibration"]
    # First call embeds the background prompts + the query; the second only the query.
    background = len(scoring.BACKGROUND_PROMPTS)
    assert after_first - before == background + 1
    assert after_second - after_first == 1


def test_samples_only_query_reports_no_text_calibration(client):
    body = client.post("/detect", data={"event_id": "e1", "sample_photo_ids": "p1"}).get_json()
    assert "textCalibration" not in body


def test_text_scores_are_not_cohort_zscored(client):
    """Guards the fix: a text score must be the fixed calibration applied to the
    raw cosine, NOT a cohort z-score (which inverted plausible vs absurd in
    production)."""
    body = client.post("/detect", data={"event_id": "e1", "text": "abc", "region": "person"}).get_json()
    index = main_mod.get_store().load_event("e1")
    mask = index.region_mask("person", False)
    sims = index.sims(siglip.load_encoders().text.embed("abc"))
    mean, std = body["textCalibration"]["mean"], body["textCalibration"]["std"]
    expected = scoring.scale(sims, mean, std)
    top = body["results"][0]
    assert top["textScore"] == pytest.approx(float(expected[top["row"]]), abs=1e-4)
    cohort_z = scoring.zscore(sims, mask)
    if abs(float(cohort_z[top["row"]]) - float(expected[top["row"]])) > 1e-3:
        assert top["textScore"] != pytest.approx(float(cohort_z[top["row"]]), abs=1e-4)


@pytest.fixture
def prepared(tmp_path):
    blobs = BlobIO(str(tmp_path))
    write_outfit(
        blobs,
        "e1",
        build_index("e1", "siglip_test@o1", "m1", ROWS, photos=3),
        VECTORS,
    )
    main_mod.set_store(OutfitStore(str(tmp_path)))
    yield tmp_path
    main_mod.set_store(None)
    siglip.set_bundle(None)


@pytest.fixture
def client(prepared):
    siglip.set_bundle(FakeBundle())
    main_mod.reset_calibration()
    main_mod.app.config.update(TESTING=True)
    return main_mod.app.test_client()


def _png(value: int, size=(8, 8)) -> bytes:
    from PIL import Image

    img = Image.new("RGB", size, (value, value, value))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_healthz_needs_no_models():
    siglip.set_bundle(None)
    main_mod.app.config.update(TESTING=True)
    res = main_mod.app.test_client().get("/healthz")
    assert res.status_code == 200
    assert res.get_json()["service"] == "outfit-tagger"


def test_status_reports_preparation(client):
    res = client.get("/status?event_id=e1")
    body = res.get_json()
    assert res.status_code == 200
    assert body["prepared"] is True
    assert body["crops"] == 4
    assert body["regions"] == {"person": 2, "head": 2}
    assert body["modelVersion"] == "siglip_test@o1"
    assert body["sourceModelVersion"] == "m1"


def test_status_of_an_unprepared_event_is_not_an_error(client):
    res = client.get("/status?event_id=nope")
    assert res.status_code == 200
    assert res.get_json()["prepared"] is False


def test_status_requires_an_event_id(client):
    assert client.get("/status").status_code == 400


def test_detect_requires_event_id_and_a_query(client):
    assert client.post("/detect", data={"text": "orange"}).get_json()["error"] == "missing_event_id"
    body = client.post("/detect", data={"event_id": "e1"}).get_json()
    assert body["error"] == "missing_query"


def test_detect_with_text_only(client):
    res = client.post("/detect", data={"event_id": "e1", "text": "abc"})
    body = res.get_json()
    assert res.status_code == 200
    assert body["scoreUnit"] == "zscore"
    # Text-only: no blend, so no weight is reported.
    assert body["textWeight"] is None
    assert body["sampleCount"] == 0
    # 'abc' → basis vector 3 → row 3 is p3, but p3's only crop is flagged small
    # and small crops are excluded by default.
    assert "p3" not in [r["photoId"] for r in body["results"]]


def test_include_small_admits_the_flagged_crop(client):
    body = client.post(
        "/detect", data={"event_id": "e1", "text": "abc", "include_small": "1"}
    ).get_json()
    assert "p3" in [r["photoId"] for r in body["results"]]


def test_detect_with_a_sample_upload(client):
    data = {"event_id": "e1", "file": (io.BytesIO(_png(1)), "sample.png")}
    res = client.post("/detect", data=data, content_type="multipart/form-data")
    body = res.get_json()
    assert res.status_code == 200
    assert body["sampleCount"] == 1
    assert body["results"], "a sample query should rank something"
    assert body["results"][0]["sampleScore"] is not None
    assert body["results"][0]["textScore"] is None


def test_detect_reuses_stored_vectors_for_sample_photo_ids(client):
    body = client.post(
        "/detect", data={"event_id": "e1", "sample_photo_ids": "p1"}
    ).get_json()
    # p1 has two crops (person + head), both folded into the prototype, and no
    # encoder pass was needed for either.
    assert body["sampleCount"] == 2
    assert body["samplePhotoIds"] == ["p1"]
    assert body["unknownPhotoIds"] == []


def test_unknown_sample_photo_ids_are_reported_not_fatal(client):
    body = client.post(
        "/detect", data={"event_id": "e1", "sample_photo_ids": "p1,ghost", "text": "abc"}
    ).get_json()
    assert body["unknownPhotoIds"] == ["ghost"]
    assert body["samplePhotoIds"] == ["p1"]


def test_only_unknown_samples_and_no_text_is_an_empty_query(client):
    res = client.post("/detect", data={"event_id": "e1", "sample_photo_ids": "ghost"})
    assert res.status_code == 400
    body = res.get_json()
    assert body["error"] == "empty_query"
    assert body["unknownPhotoIds"] == ["ghost"]


def test_region_filter_restricts_results_and_cohort(client):
    body = client.post(
        "/detect", data={"event_id": "e1", "text": "abc", "region": "person"}
    ).get_json()
    assert body["region"] == "person"
    assert body["cohortSize"] == 2
    assert all(r["region"] == "person" for r in body["results"])


def test_bad_region_is_rejected(client):
    res = client.post("/detect", data={"event_id": "e1", "text": "a", "region": "torso"})
    assert res.status_code == 400
    assert res.get_json()["error"] == "bad_region"


def test_blend_reports_the_weight(client):
    data = {
        "event_id": "e1",
        "text": "abc",
        "text_weight": "0.5",
        "file": (io.BytesIO(_png(1)), "s.png"),
    }
    body = client.post("/detect", data=data, content_type="multipart/form-data").get_json()
    assert body["textWeight"] == 0.5
    assert body["results"][0]["sampleScore"] is not None
    assert body["results"][0]["textScore"] is not None


def test_top_k_is_capped(client, monkeypatch):
    monkeypatch.setattr(main_mod, "MAX_TOP_K", 1)
    body = client.post("/detect", data={"event_id": "e1", "text": "abc", "top_k": "500"}).get_json()
    assert len(body["results"]) == 1


def test_min_score_gates_in_z_units(client):
    wide_open = client.post("/detect", data={"event_id": "e1", "text": "abc"}).get_json()
    gated = client.post(
        "/detect", data={"event_id": "e1", "text": "abc", "min_score": "100"}
    ).get_json()
    assert wide_open["results"]
    assert gated["results"] == []


def test_bad_numbers_are_rejected(client):
    res = client.post("/detect", data={"event_id": "e1", "text": "a", "top_k": "lots"})
    assert res.status_code == 400
    assert res.get_json()["error"] == "bad_number"


def test_unprepared_event_is_404(client):
    res = client.post("/detect", data={"event_id": "ghost", "text": "abc"})
    assert res.status_code == 404
    assert res.get_json()["error"] == "event_not_prepared"


def test_model_version_mismatch_refuses_rather_than_ranking_across_spaces(prepared):
    """Vectors from a different model live in a different space. Ranking across
    them yields plausible nonsense, so this must be an error the caller can act
    on rather than a silently bad result."""
    siglip.set_bundle(FakeBundle(version="siglip_other@o2"))
    main_mod.app.config.update(TESTING=True)
    res = main_mod.app.test_client().post("/detect", data={"event_id": "e1", "text": "abc"})
    assert res.status_code == 409
    assert res.get_json()["error"] == "model_version_mismatch"


def test_text_without_a_text_tower_is_a_clear_error(prepared):
    siglip.set_bundle(FakeBundle(with_text=False))
    main_mod.app.config.update(TESTING=True)
    res = main_mod.app.test_client().post("/detect", data={"event_id": "e1", "text": "abc"})
    assert res.status_code == 400
    assert res.get_json()["error"] == "text_unsupported"


def test_samples_still_work_without_a_text_tower(prepared):
    siglip.set_bundle(FakeBundle(with_text=False))
    main_mod.app.config.update(TESTING=True)
    res = main_mod.app.test_client().post(
        "/detect",
        data={"event_id": "e1", "file": (io.BytesIO(_png(1)), "s.png")},
        content_type="multipart/form-data",
    )
    assert res.status_code == 200


def test_weak_text_gets_an_advisory(client):
    body = client.post(
        "/detect", data={"event_id": "e1", "text": "open-ear headphones"}
    ).get_json()
    assert "headphone" in body["textAdvisory"]


def test_ordinary_text_gets_no_advisory(client):
    body = client.post("/detect", data={"event_id": "e1", "text": "orange singlet"}).get_json()
    assert "textAdvisory" not in body


def test_undecodable_sample_is_rejected(client):
    res = client.post(
        "/detect",
        data={"event_id": "e1", "file": (io.BytesIO(b"not an image"), "s.png")},
        content_type="multipart/form-data",
    )
    assert res.status_code == 400
    assert res.get_json()["error"] == "bad_image"


def test_too_many_samples_is_rejected(client, monkeypatch):
    monkeypatch.setattr(main_mod, "MAX_SAMPLES", 1)
    data = {
        "event_id": "e1",
        "file": [(io.BytesIO(_png(1)), "a.png"), (io.BytesIO(_png(2)), "b.png")],
    }
    res = client.post("/detect", data=data, content_type="multipart/form-data")
    assert res.status_code == 400
    assert res.get_json()["error"] == "too_many_samples"


def test_empty_event_returns_no_results(tmp_path):
    blobs = BlobIO(str(tmp_path))
    write_outfit(blobs, "e0", build_index("e0", "siglip_test@o1", "m1", [], photos=0),
                 np.zeros((0, DIM), np.float32))
    main_mod.set_store(OutfitStore(str(tmp_path)))
    siglip.set_bundle(FakeBundle())
    main_mod.app.config.update(TESTING=True)
    try:
        res = main_mod.app.test_client().post("/detect", data={"event_id": "e0", "text": "abc"})
        assert res.status_code == 200
        assert res.get_json()["results"] == []
    finally:
        main_mod.set_store(None)
        siglip.set_bundle(None)
