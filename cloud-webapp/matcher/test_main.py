"""
test_main.py — matcher test suite (pattern follows cloud-run/test_main.py:
stub the heavy I/O — here, the ONNX models — and exercise everything else
for real).

Layers:
  1. Pure unit tests: letterbox/normalize/box helpers, fusion math,
     store cosine top-k + photo aggregation, manifest round-trip, quality.
  2. Endpoint tests for /healthz, /embed, /search with a deterministic
     FakeBundle injected via models.set_bundle — no model weights needed.

Real-model integration tests are gated on MODEL_DIR being present (skipped
otherwise), so CI stays green without the ~300 MB of ONNX files.

Run from cloud-webapp/matcher/:
    pip install -r requirements.txt -r requirements-test.txt
    pytest -v
"""

from __future__ import annotations

import io
import json
import os

import numpy as np
import pytest
from PIL import Image

import fusion as fusion_mod
import main as main_mod
import quality
from models import ModelBundle, set_bundle
from models.common import clamp_box, expand_face_to_person, l2_normalize, letterbox
from store import EmbeddingStore, EventEmbeddings, build_manifest, write_local

rng = np.random.default_rng(42)


# ──────────────────────────────────────────────────────────────────────────────
# Helpers / fakes
# ──────────────────────────────────────────────────────────────────────────────

def unit(v):
    v = np.asarray(v, dtype=np.float32)
    return v / np.linalg.norm(v)


def jpeg_bytes(w=320, h=240, sharp=True) -> bytes:
    """Sharp (noise) images pass the blur quality gate; flat ones don't."""
    buf = io.BytesIO()
    if sharp:
        arr = rng.integers(0, 255, (h, w, 3), dtype=np.uint8)
        Image.fromarray(arr, "RGB").save(buf, "JPEG", quality=95)
    else:
        Image.new("RGB", (w, h), (120, 90, 200)).save(buf, "JPEG")
    return buf.getvalue()


class FakeFaceDet:
    """Always reports one confident, large, centered face."""

    def detect(self, img_rgb, **kw):
        h, w = img_rgb.shape[:2]
        box = [w * 0.3, h * 0.2, w * 0.7, h * 0.8]
        kps = np.array(
            [[w * 0.4, h * 0.4], [w * 0.6, h * 0.4], [w * 0.5, h * 0.55],
             [w * 0.42, h * 0.68], [w * 0.58, h * 0.68]],
            dtype=np.float32,
        )
        return [{"box": box, "kps": kps, "score": 0.93}]


class NoFaceDet:
    def detect(self, img_rgb, **kw):
        return []


class FakeEmbedder:
    """Deterministic embedder: returns a fixed unit vector."""

    def __init__(self, vec):
        self._vec = unit(vec)
        self.dim = len(self._vec)

    def embed(self, *args, **kw):
        return self._vec.copy()


def make_bundle(face_vec, person_vec, face_det=None):
    return ModelBundle(
        face_det=face_det or FakeFaceDet(),
        face_emb=FakeEmbedder(face_vec),
        person_emb=FakeEmbedder(person_vec),
        person_det=None,  # exercises the face-expansion fallback
    )


DIM = 512


def basis(i, dim=DIM):
    v = np.zeros(dim, dtype=np.float32)
    v[i] = 1.0
    return v


@pytest.fixture(autouse=True)
def _reset_globals(monkeypatch):
    set_bundle(None)
    main_mod._store = None
    yield
    set_bundle(None)
    main_mod._store = None


@pytest.fixture
def client():
    main_mod.app.config["TESTING"] = True
    with main_mod.app.test_client() as c:
        yield c


@pytest.fixture
def seeded_store(tmp_path):
    """Local store with event 'ev1'. Face-query basis(0): pA=1.0, pB≈0.894.
    Person-query basis(1): pB=1.0, others 0. Fused 0.85/0.15 → pB (0.910)
    beats pA (0.85)."""
    faces = np.stack([basis(0), unit(basis(0) * 0.9 + basis(5) * 0.45), basis(7)])
    faces_meta = [
        {"photoId": "pA.jpg", "box": [0, 0, 50, 50], "score": 0.9},
        {"photoId": "pB.jpg", "box": [0, 0, 50, 50], "score": 0.9},
        {"photoId": "pC.jpg", "box": [0, 0, 50, 50], "score": 0.9},
    ]
    persons = np.stack([basis(1), basis(6), basis(8)])
    persons_meta = [
        {"photoId": "pB.jpg", "box": [0, 0, 80, 160], "score": 0.8, "source": "detector"},
        {"photoId": "pA.jpg", "box": [0, 0, 80, 160], "score": 0.8, "source": "detector"},
        {"photoId": "pC.jpg", "box": [0, 0, 80, 160], "score": 0.8, "source": "detector"},
    ]
    manifest = build_manifest("ev1", "test@v0", faces_meta, persons_meta)
    write_local(str(tmp_path / "ev1"), manifest, faces, persons)
    return str(tmp_path)


@pytest.fixture
def big_store(tmp_path):
    """Event 'big' where 250 distinct photos all match the face query strongly
    (cosine 1.0 → fused 0.85, well above the 0.25 threshold). Used to prove the
    result list is no longer capped at the old 50/200."""
    n = 250
    faces = np.stack([basis(0) for _ in range(n)])
    faces_meta = [{"photoId": f"p{i}.jpg", "box": [0, 0, 50, 50], "score": 0.9} for i in range(n)]
    persons = np.zeros((0, DIM), dtype=np.float32)
    manifest = build_manifest("big", "test@v0", faces_meta, [])
    write_local(str(tmp_path / "big"), manifest, faces, persons)
    return str(tmp_path)


# ──────────────────────────────────────────────────────────────────────────────
# 1. Pure helpers
# ──────────────────────────────────────────────────────────────────────────────

class TestCommon:
    def test_letterbox_shape_and_scale(self):
        img = np.zeros((100, 200, 3), dtype=np.uint8)
        canvas, scale, pad_x, pad_y = letterbox(img, 640)
        assert canvas.shape == (640, 640, 3)
        assert scale == pytest.approx(640 / 200)
        assert pad_x == 0 and pad_y == (640 - 320) // 2

    def test_letterbox_roundtrip_coords(self):
        img = np.zeros((480, 640, 3), dtype=np.uint8)
        _, scale, pad_x, pad_y = letterbox(img, 640)
        # a point at original (320, 240) maps into canvas and back
        cx, cy = 320 * scale + pad_x, 240 * scale + pad_y
        assert (cx - pad_x) / scale == pytest.approx(320)
        assert (cy - pad_y) / scale == pytest.approx(240)

    def test_l2_normalize(self):
        v = l2_normalize(np.array([3.0, 4.0]))
        assert np.linalg.norm(v) == pytest.approx(1.0)
        assert not np.any(np.isnan(l2_normalize(np.zeros(4))))

    def test_clamp_box(self):
        assert clamp_box([-5, -5, 700, 700], 640, 480) == [0.0, 0.0, 640.0, 480.0]

    def test_expand_face_to_person_within_bounds(self):
        box = expand_face_to_person([100, 100, 140, 150], 640, 480)
        x1, y1, x2, y2 = box
        assert 0 <= x1 < x2 <= 640 and 0 <= y1 < y2 <= 480
        assert (x2 - x1) > 40 and (y2 - y1) > 50  # bigger than the face


class TestQuality:
    def test_sharp_face_usable(self):
        img = rng.integers(0, 255, (200, 200, 3), dtype=np.uint8)  # noise = sharp
        det = {"box": [20, 20, 180, 180], "score": 0.9}
        q = quality.assess_face(img, det)
        assert q["usable"] and q["reasons"] == []

    def test_blurry_face_rejected(self):
        img = np.full((200, 200, 3), 128, dtype=np.uint8)  # flat = "blurry"
        det = {"box": [20, 20, 180, 180], "score": 0.9}
        q = quality.assess_face(img, det)
        assert not q["usable"] and "too_blurry" in q["reasons"]

    def test_small_face_rejected(self):
        img = rng.integers(0, 255, (200, 200, 3), dtype=np.uint8)
        det = {"box": [0, 0, 20, 20], "score": 0.9}
        assert "too_small" in quality.assess_face(img, det)["reasons"]

    def test_low_confidence_rejected(self):
        img = rng.integers(0, 255, (200, 200, 3), dtype=np.uint8)
        det = {"box": [20, 20, 180, 180], "score": 0.3}
        assert "low_confidence" in quality.assess_face(img, det)["reasons"]


class TestFusion:
    def test_score_fusion_weights(self):
        face = [{"photoId": "a", "score": 1.0}, {"photoId": "b", "score": 0.5}]
        person = [{"photoId": "b", "score": 1.0}]
        out = fusion_mod.fuse(face, person, w_face=0.7, w_person=0.3, threshold=0.0)
        scores = {h["photoId"]: h["score"] for h in out}
        assert scores["a"] == pytest.approx(0.7)
        assert scores["b"] == pytest.approx(0.7 * 0.5 + 0.3 * 1.0)
        assert out[0]["photoId"] == "a"  # 0.7 > 0.65

    def test_threshold_filters(self):
        face = [{"photoId": "a", "score": 0.2}]
        assert fusion_mod.fuse(face, [], threshold=0.25) == []

    def test_rrf_orders_by_rank(self):
        face = [{"photoId": "a", "score": 0.9}, {"photoId": "b", "score": 0.8}]
        person = [{"photoId": "b", "score": 0.9}]
        out = fusion_mod.fuse(face, person, method="rrf")
        assert out[0]["photoId"] == "b"  # appears in both lists

    def test_unknown_method_raises(self):
        with pytest.raises(ValueError):
            fusion_mod.fuse([], [], method="nope")


class TestStore:
    def test_roundtrip_and_topk(self, seeded_store):
        ev = EmbeddingStore(seeded_store).load_event("ev1")
        hits = ev.top_k("face", basis(0), k=2)
        assert hits[0]["photoId"] == "pA.jpg"
        assert hits[0]["score"] == pytest.approx(1.0)
        assert hits[0]["score"] >= hits[1]["score"]

    def test_top_photos_dedupes_by_photo(self, seeded_store):
        ev = EmbeddingStore(seeded_store).load_event("ev1")
        photos = [h["photoId"] for h in ev.top_photos("face", basis(0), k=10)]
        assert len(photos) == len(set(photos))

    def test_top_k_none_returns_all_sorted(self, seeded_store):
        ev = EmbeddingStore(seeded_store).load_event("ev1")
        hits = ev.top_k("face", basis(0), k=None)
        assert len(hits) == 3  # every crop, no cap
        scores = [h["score"] for h in hits]
        assert scores == sorted(scores, reverse=True)

    def test_top_photos_none_returns_every_photo(self, seeded_store):
        ev = EmbeddingStore(seeded_store).load_event("ev1")
        photos = [h["photoId"] for h in ev.top_photos("face", basis(0), k=None)]
        assert set(photos) == {"pA.jpg", "pB.jpg", "pC.jpg"}

    def test_query_normalization(self, seeded_store):
        ev = EmbeddingStore(seeded_store).load_event("ev1")
        a = ev.top_k("face", basis(0), k=1)[0]["score"]
        b = ev.top_k("face", basis(0) * 10, k=1)[0]["score"]  # unnormalized query
        assert a == pytest.approx(b)

    def test_missing_event_raises(self, seeded_store):
        with pytest.raises(FileNotFoundError):
            EmbeddingStore(seeded_store).load_event("nope")

    def test_cache_and_invalidate(self, seeded_store):
        store = EmbeddingStore(seeded_store)
        ev1 = store.load_event("ev1")
        assert store.load_event("ev1") is ev1
        store.invalidate("ev1")
        assert store.load_event("ev1") is not ev1

    def test_manifest_vector_mismatch_rejected(self):
        manifest = build_manifest("e", "v", [{"photoId": "x"}], [])
        with pytest.raises(ValueError):
            EventEmbeddings(manifest, np.zeros((2, 4), np.float32), np.zeros((0, 4), np.float32))

    def test_empty_kind_returns_empty(self):
        manifest = build_manifest("e", "v", [], [])
        ev = EventEmbeddings(manifest, np.zeros((0, 4), np.float32), np.zeros((0, 4), np.float32))
        assert ev.top_k("face", np.ones(4), k=5) == []


# ──────────────────────────────────────────────────────────────────────────────
# 2. Endpoints (fake bundle)
# ──────────────────────────────────────────────────────────────────────────────

class TestHealthz:
    def test_ok(self, client):
        resp = client.get("/healthz")
        assert resp.status_code == 200 and resp.get_json()["ok"] is True


class TestEmbed:
    def test_returns_face_and_person(self, client):
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post("/embed", data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg")})
        assert resp.status_code == 200
        body = resp.get_json()
        assert len(body["faces"]) == 1 and len(body["persons"]) == 1
        assert len(body["faces"][0]["embedding"]) == DIM
        assert body["persons"][0]["source"] == "face_expand"
        assert body["persons"][0]["faceIdx"] == 0

    def test_missing_file_400(self, client):
        resp = client.post("/embed", data={})
        assert resp.status_code == 400 and resp.get_json()["error"] == "missing_file"

    def test_garbage_image_400(self, client):
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post("/embed", data={"file": (io.BytesIO(b"not an image"), "x.jpg")})
        assert resp.status_code == 400 and resp.get_json()["error"] == "bad_image"


class TestSearch:
    def _env(self, monkeypatch, seeded_store):
        monkeypatch.setenv("EMBEDDINGS_ROOT", seeded_store)

    def test_fused_search_ranks_expected_photo_first(self, client, monkeypatch, seeded_store):
        self._env(monkeypatch, seeded_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "ev1"},
        )
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["mode"] == "fused" and body["indexModelVersion"] == "test@v0"
        # pA: face=1.0 → 0.85; pB: face≈0.894*0.85 + person=1.0*0.15 ≈ 0.91 — pB wins
        assert body["results"][0]["photoId"] == "pB.jpg"
        ids = [r["photoId"] for r in body["results"]]
        assert "pA.jpg" in ids

    def test_fused_search_uncapped_by_default(self, client, monkeypatch, big_store):
        monkeypatch.setenv("EMBEDDINGS_ROOT", big_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "big"},
        )
        assert resp.status_code == 200
        body = resp.get_json()
        # All 250 matching photos come back — no 50/200 truncation.
        assert len(body["results"]) == 250

    def test_explicit_top_k_still_caps(self, client, monkeypatch, big_store):
        monkeypatch.setenv("EMBEDDINGS_ROOT", big_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "big", "top_k": "10"},
        )
        assert resp.status_code == 200
        assert len(resp.get_json()["results"]) == 10

    def test_face_only_mode(self, client, monkeypatch, seeded_store):
        self._env(monkeypatch, seeded_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "ev1", "mode": "face"},
        )
        body = resp.get_json()
        assert resp.status_code == 200
        assert body["results"][0]["photoId"] == "pA.jpg"
        assert all(r["personScore"] is None for r in body["results"])

    def test_no_face_in_query_422(self, client, monkeypatch, seeded_store):
        self._env(monkeypatch, seeded_store)
        set_bundle(make_bundle(basis(0), basis(1), face_det=NoFaceDet()))
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "ev1"},
        )
        assert resp.status_code == 422 and resp.get_json()["error"] == "no_usable_face"

    def test_blurry_query_rejected_422(self, client, monkeypatch, seeded_store):
        self._env(monkeypatch, seeded_store)
        set_bundle(make_bundle(basis(0), basis(1)))  # face detected, but image is flat
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes(sharp=False)), "x.jpg"), "event_id": "ev1"},
        )
        assert resp.status_code == 422
        body = resp.get_json()
        assert body["error"] == "no_usable_face"
        assert "too_blurry" in body["faces"][0]["quality"]["reasons"]

    def test_unindexed_event_404(self, client, monkeypatch, seeded_store):
        self._env(monkeypatch, seeded_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "ghost"},
        )
        assert resp.status_code == 404 and resp.get_json()["error"] == "event_not_indexed"

    def test_missing_event_id_400(self, client):
        resp = client.post("/search", data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg")})
        assert resp.status_code == 400

    def test_bad_mode_400(self, client):
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "ev1", "mode": "psychic"},
        )
        assert resp.status_code == 400


# ──────────────────────────────────────────────────────────────────────────────
# 3. Real models (skipped unless MODEL_DIR exists with required files)
# ──────────────────────────────────────────────────────────────────────────────

_model_dir = os.environ.get("MODEL_DIR", "")
_have_models = _model_dir and os.path.exists(os.path.join(_model_dir, "det_10g.onnx"))


@pytest.mark.skipif(not _have_models, reason="MODEL_DIR with ONNX files not present")
class TestRealModels:
    def test_pipeline_runs_on_synthetic_image(self):
        from pipeline import decode_image, embed_image

        img = decode_image(jpeg_bytes(640, 480))
        result = embed_image(img)
        assert "faces" in result and "persons" in result  # may be empty: no real face
        assert result["model_version"]
