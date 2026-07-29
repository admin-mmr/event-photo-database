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


class TwoFaceDet:
    """A group-shot selfie: a bystander the detector is MORE confident about
    (0.97, left) plus the subject (0.90, right). The higher score wins when the
    query face is chosen, which is exactly why the searcher has to be warned."""

    def detect(self, img_rgb, **kw):
        h, w = img_rgb.shape[:2]

        def face(cx, half, score):
            kps = np.array(
                [[w * (cx - 0.05), h * 0.4], [w * (cx + 0.05), h * 0.4], [w * cx, h * 0.55],
                 [w * (cx - 0.04), h * 0.68], [w * (cx + 0.04), h * 0.68]],
                dtype=np.float32,
            )
            return {
                "box": [w * (cx - half), h * 0.2, w * (cx + half), h * 0.8],
                "kps": kps,
                "score": score,
            }

        return [face(0.25, 0.12, 0.97), face(0.70, 0.15, 0.90)]


class TurnedFaceDet:
    """One large, sharp, confident face — but looking away from the camera: the
    nose sits almost on top of one eye rather than between them."""

    def detect(self, img_rgb, **kw):
        h, w = img_rgb.shape[:2]
        kps = np.array(
            [[w * 0.4, h * 0.4], [w * 0.6, h * 0.4], [w * 0.59, h * 0.55],
             [w * 0.56, h * 0.68], [w * 0.6, h * 0.68]],
            dtype=np.float32,
        )
        return [{"box": [w * 0.3, h * 0.2, w * 0.7, h * 0.8], "kps": kps, "score": 0.93}]


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
    Person-query basis(1): pB=1.0, others 0. Fused 0.7/0.3 → pB (0.926)
    beats pA (0.7)."""
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


def _kps(left_eye, right_eye, nose):
    """5-point landmark array; only the first three matter for frontality."""
    return np.array([left_eye, right_eye, nose, (0.0, 0.0), (0.0, 0.0)], dtype=np.float32)


class TestAdvisoryWarnings:
    """`assess_face().warnings` — usable faces still worth flagging.

    Advisory, never blocking: each case asserts `usable` stays True. The codes
    and thresholds are the ones `selfie_advisories` uses, so the pick-time check
    and the post-search census can never contradict each other.
    """

    def test_good_face_has_no_warnings(self):
        img = rng.integers(0, 255, (400, 400, 3), dtype=np.uint8)
        det = {"box": [100, 100, 300, 300], "score": 0.9, "kps": _kps((160, 180), (240, 180), (200, 220))}
        q = quality.assess_face(img, det)
        assert q["usable"] and q["warnings"] == []

    def test_face_small_in_frame_warns(self):
        # 60px face: comfortably over MIN_FACE_PX, but 60/800 = 0.075 of the
        # short side, under SELFIE_ADVISE_FACE_FRAC.
        img = rng.integers(0, 255, (800, 800, 3), dtype=np.uint8)
        det = {"box": [100, 100, 160, 160], "score": 0.9, "kps": _kps((115, 120), (145, 120), (130, 135))}
        q = quality.assess_face(img, det)
        assert q["face_frac"] < quality.SELFIE_ADVISE_FACE_FRAC
        assert q["usable"] and q["warnings"] == ["face_small_in_frame"]

    def test_turned_face_warns_but_is_still_usable(self):
        # Nose 0.25 interocular widths off centre → frontality ≈ 0.29.
        img = rng.integers(0, 255, (400, 400, 3), dtype=np.uint8)
        det = {"box": [100, 100, 300, 300], "score": 0.9, "kps": _kps((160, 180), (240, 180), (220, 220))}
        q = quality.assess_face(img, det)
        assert q["frontality"] < quality.SELFIE_ADVISE_FRONTALITY
        assert q["usable"] and q["warnings"] == ["not_frontal"]

    def test_no_landmarks_means_no_frontality_warning(self):
        # Absent is "unmeasured", never "bad" — a pre-quality face isn't slandered.
        img = rng.integers(0, 255, (400, 400, 3), dtype=np.uint8)
        det = {"box": [100, 100, 300, 300], "score": 0.9}
        q = quality.assess_face(img, det)
        assert q["frontality"] is None and "not_frontal" not in q["warnings"]

    def test_warnings_match_the_pick_time_advisories(self):
        # The whole point of sharing face_advisories: /quality and /search agree.
        img = rng.integers(0, 255, (400, 400, 3), dtype=np.uint8)
        det = {"box": [100, 100, 300, 300], "score": 0.9, "kps": _kps((160, 180), (240, 180), (220, 220))}
        q = quality.assess_face(img, det)
        assert quality.selfie_advisories(q, 1) == q["warnings"]
        assert quality.selfie_advisories(q, 2) == ["multiple_faces", *q["warnings"]]


class TestFaceQualityMath:
    """frontality / face_fraction / quality_term (quality.py)."""

    @staticmethod
    def _kps(nose_x, eye_y=100.0, left_x=80.0, right_x=120.0):
        """5 landmarks with the nose shifted along the interocular axis."""
        return np.array(
            [[left_x, eye_y], [right_x, eye_y], [nose_x, eye_y + 15],
             [92.0, eye_y + 35], [108.0, eye_y + 35]],
            dtype=np.float32,
        )

    def test_nose_centred_is_frontal(self):
        assert quality.frontality(self._kps(100.0)) == pytest.approx(1.0)

    def test_turned_head_drops_toward_zero(self):
        # Nose 0.35 interocular widths off centre = YAW_FULL_PROFILE → 0.0.
        turned = quality.frontality(self._kps(100.0 + 0.35 * 40))
        half = quality.frontality(self._kps(100.0 + 0.175 * 40))
        assert turned == pytest.approx(0.0)
        assert half == pytest.approx(0.5, abs=0.01)

    def test_sign_of_turn_does_not_matter(self):
        left = quality.frontality(self._kps(100.0 - 0.2 * 40))
        right = quality.frontality(self._kps(100.0 + 0.2 * 40))
        assert left == pytest.approx(right)

    def test_a_rolled_head_is_not_mistaken_for_a_turned_one(self):
        # A head-on face rotated 90° in-plane. Measuring the nose offset in raw
        # x — rather than along the interocular axis — would call this a profile.
        rolled = np.array([[100, 80], [100, 120], [80, 100], [70, 92], [70, 108]],
                          dtype=np.float32)
        assert quality.frontality(rolled) == pytest.approx(1.0)

    def test_invariant_to_face_size(self):
        small = quality.frontality(self._kps(102.0, left_x=80.0, right_x=120.0))
        big = quality.frontality(
            np.array([[800, 1000], [1200, 1000], [1020, 1150], [920, 1350], [1080, 1350]],
                     dtype=np.float32)
        )
        assert small == pytest.approx(big, abs=0.01)

    def test_unmeasurable_returns_none(self):
        assert quality.frontality(None) is None                      # no landmarks at all
        assert quality.frontality(np.zeros((2, 2), np.float32)) is None  # no nose point
        eyes_coincident = np.array([[100, 100]] * 5, dtype=np.float32)
        assert quality.frontality(eyes_coincident) is None

    def test_face_fraction_uses_image_short_side(self):
        assert quality.face_fraction([0, 0, 100, 100], (2000, 3000, 3)) == pytest.approx(0.05)
        assert quality.face_fraction([0, 0, 100, 100], (0, 0, 3)) == 0.0

    def test_quality_term_is_multiplicative(self):
        # Small AND side-on is punished harder than either alone.
        both = quality.quality_term(0.5, quality.FULL_FACE_FRAC / 2)
        assert both == pytest.approx(0.25)
        assert quality.quality_term(1.0, quality.FULL_FACE_FRAC) == pytest.approx(1.0)
        assert quality.quality_term(1.0, 0.5) == pytest.approx(1.0)  # clamped, big face

    def test_quality_term_unknown_is_neutral(self):
        assert quality.quality_term(None, None) == pytest.approx(1.0)
        assert quality.quality_term(None, quality.FULL_FACE_FRAC / 2) == pytest.approx(0.5)

    def test_assess_face_reports_frac_and_frontality(self):
        img = rng.integers(0, 255, (200, 200, 3), dtype=np.uint8)
        det = {"box": [20, 20, 180, 180], "score": 0.9, "kps": self._kps(100.0)}
        q = quality.assess_face(img, det)
        assert q["face_frac"] == pytest.approx(160 / 200)
        assert q["frontality"] == pytest.approx(1.0)
        # A detector without landmarks (older callers) leaves frontality unset.
        assert quality.assess_face(img, {"box": [20, 20, 180, 180], "score": 0.9})["frontality"] is None


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
        # pA: face=1.0 → 0.7; pB: face≈0.89*0.7 + person=1.0*0.3 ≈ 0.93 — pB wins
        assert body["results"][0]["photoId"] == "pB.jpg"
        ids = [r["photoId"] for r in body["results"]]
        assert "pA.jpg" in ids

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

    def test_reference_faces_reported_for_a_lone_face(self, client, monkeypatch, seeded_store):
        self._env(monkeypatch, seeded_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "ev1"},
        )
        assert resp.status_code == 200
        (ref,) = resp.get_json()["referenceFaces"]
        assert ref["faces"] == 1 and ref["usableFaces"] == 1
        # Normalized to fractions of the image, matching FakeFaceDet's box.
        assert ref["selectedFace"] == pytest.approx([0.3, 0.2, 0.7, 0.8], abs=1e-6)

    def test_reference_faces_flags_a_group_shot(self, client, monkeypatch, seeded_store):
        self._env(monkeypatch, seeded_store)
        set_bundle(make_bundle(basis(0), basis(1), face_det=TwoFaceDet()))
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "ev1"},
        )
        assert resp.status_code == 200
        (ref,) = resp.get_json()["referenceFaces"]
        assert ref["faces"] == 2 and ref["usableFaces"] == 2
        # The outlined face is the one the query actually used — the higher
        # detector score (the left bystander), not simply the first or largest.
        assert ref["selectedFace"] == pytest.approx([0.13, 0.2, 0.37, 0.8], abs=1e-6)

    def test_reference_faces_reported_on_no_usable_face_422(
        self, client, monkeypatch, seeded_store
    ):
        self._env(monkeypatch, seeded_store)
        set_bundle(make_bundle(basis(0), basis(1), face_det=TwoFaceDet()))
        resp = client.post(  # flat image → both faces fail the blur gate
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes(sharp=False)), "x.jpg"), "event_id": "ev1"},
        )
        assert resp.status_code == 422
        (ref,) = resp.get_json()["referenceFaces"]
        assert ref["faces"] == 2 and ref["usableFaces"] == 0
        assert ref["selectedFace"] is None
        # Why, specifically — the api turns these into "the photo is too blurry"
        # rather than a generic "no clear face".
        assert ref["blockingReasons"] == ["too_blurry"]
        assert ref["selectedWarnings"] == []

    def test_reference_faces_reports_a_turned_away_face(self, client, monkeypatch, seeded_store):
        self._env(monkeypatch, seeded_store)
        set_bundle(make_bundle(basis(0), basis(1), face_det=TurnedFaceDet()))
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "ev1"},
        )
        # Advisory only: the search still runs and returns matches.
        assert resp.status_code == 200
        (ref,) = resp.get_json()["referenceFaces"]
        assert ref["usableFaces"] == 1
        assert ref["selectedWarnings"] == ["not_frontal"]
        assert ref["blockingReasons"] == []


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
