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
    (0.97, left) plus the subject (0.90, right). The higher score wins in
    _select_reference, which is exactly why the searcher has to be warned."""

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


# Anchor for the capture-time fusion tests: a fixed query capture time. pX was
# taken 10 min after (within W_FULL → full outfit weight), pY 6 h after (beyond
# W_ZERO=3h → outfit weight decays to the floor, 0.0).
from datetime import datetime, timezone  # noqa: E402

CT_ANCHOR_MS = int(datetime(2026, 6, 20, 12, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)


@pytest.fixture
def timed_store(tmp_path):
    """Event 'tev': pX and pY have identical face AND outfit to the query, so
    without capture-time decay they tie. pX's takenAt is near the query anchor;
    pY's is hours later, so decay should strip pY's outfit boost only."""
    faces = np.stack([basis(0), basis(0)])
    faces_meta = [
        {"photoId": "pX.jpg", "box": [0, 0, 1, 1], "score": 0.9},
        {"photoId": "pY.jpg", "box": [0, 0, 1, 1], "score": 0.9},
    ]
    persons = np.stack([basis(1), basis(1)])
    persons_meta = [
        {"photoId": "pX.jpg", "box": [0, 0, 1, 1], "score": 0.8, "source": "detector"},
        {"photoId": "pY.jpg", "box": [0, 0, 1, 1], "score": 0.8, "source": "detector"},
    ]
    manifest = build_manifest("tev", "test@v0", faces_meta, persons_meta)
    manifest["photos"] = {
        "pX.jpg": {"takenAt": "2026-06-20T12:10:00"},  # +10 min (within W_FULL)
        "pY.jpg": {"takenAt": "2026-06-20T18:00:00"},  # +6 h  (beyond W_ZERO)
    }
    write_local(str(tmp_path / "tev"), manifest, faces, persons)
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

    def test_person_weight_fn_overrides_scalar(self):
        # Capture-time fusion: a per-photo person weight function replaces the
        # flat w_person (score method only).
        face = [{"photoId": "a", "score": 0.5}]
        person = [{"photoId": "a", "score": 1.0}]
        out = fusion_mod.fuse(
            face, person, w_face=0.85, w_person=0.15, threshold=0.0,
            person_weight_fn=lambda pid: 0.0,  # fully suppress outfit
        )
        assert out[0]["score"] == pytest.approx(0.85 * 0.5)  # person contributes nothing
        assert out[0]["personWeight"] == pytest.approx(0.0)

    def test_ties_break_on_photo_id_not_set_order(self):
        # `fuse` iterates a SET of photoIds, whose order varies per process
        # (str hash randomization). Tied scores must still rank deterministically.
        face = [{"photoId": p, "score": 1.0} for p in ("echo", "alpha", "delta", "bravo")]
        out = fusion_mod.fuse(face, [], threshold=0.0)
        assert [h["photoId"] for h in out] == ["alpha", "bravo", "delta", "echo"]

    def test_tied_top_k_truncation_is_deterministic(self):
        # The regression that matters: with a cap, a nondeterministic tie order
        # returns a DIFFERENT photo run to run for the very same query.
        face = [{"photoId": p, "score": 1.0} for p in ("echo", "alpha", "delta", "bravo")]
        assert fusion_mod.fuse(face, [], threshold=0.0, top_k=1)[0]["photoId"] == "alpha"

    def test_tie_break_does_not_disturb_score_order(self):
        # Alphabetical order only applies WITHIN a score tie.
        face = [{"photoId": "zulu", "score": 0.9}, {"photoId": "alpha", "score": 0.2}]
        out = fusion_mod.fuse(face, [], threshold=0.0)
        assert [h["photoId"] for h in out] == ["zulu", "alpha"]


class TestTimeDecay:
    W_FULL = 45 * 60_000
    W_ZERO = 180 * 60_000

    def test_full_weight_within_window(self):
        assert fusion_mod.time_decay(0, self.W_FULL, self.W_ZERO) == 1.0
        assert fusion_mod.time_decay(self.W_FULL, self.W_FULL, self.W_ZERO) == 1.0
        assert fusion_mod.time_decay(-10_000, self.W_FULL, self.W_ZERO) == 1.0  # abs()

    def test_floor_beyond_zero_window(self):
        assert fusion_mod.time_decay(self.W_ZERO, self.W_FULL, self.W_ZERO, floor=0.0) == 0.0
        assert fusion_mod.time_decay(10 * self.W_ZERO, self.W_FULL, self.W_ZERO, floor=0.1) == 0.1

    def test_linear_fade_midpoint(self):
        mid = (self.W_FULL + self.W_ZERO) / 2
        assert fusion_mod.time_decay(mid, self.W_FULL, self.W_ZERO, floor=0.0) == pytest.approx(0.5)

    def test_none_delta_is_neutral(self):
        # Unknown capture time → 1.0 so the caller keeps the static weight.
        assert fusion_mod.time_decay(None, self.W_FULL, self.W_ZERO) == 1.0


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

    def test_one_crop_heavy_photo_does_not_crowd_out_others(self, tmp_path):
        # `top_photos` pools the top max(k*4, 200) CROPS before deduping to
        # photos. A single group shot owning more crops than the pool used to
        # fill it entirely, so genuine lower-ranked photos vanished.
        n_crowd = 240
        faces = np.stack(
            [basis(0)] * n_crowd + [unit(basis(0) * 0.99 + basis(1) * 0.5)]
        )
        faces_meta = [{"photoId": "crowd.jpg", "box": [0, 0, 9, 9], "score": 0.9}] * n_crowd
        faces_meta = [dict(m) for m in faces_meta]
        faces_meta.append({"photoId": "other.jpg", "box": [0, 0, 9, 9], "score": 0.9})
        manifest = build_manifest("crowded", "test@v0", faces_meta, [])
        write_local(str(tmp_path / "crowded"), manifest, faces, np.zeros((0, DIM), np.float32))

        ev = EmbeddingStore(str(tmp_path)).load_event("crowded")
        photos = [h["photoId"] for h in ev.top_photos("face", basis(0), k=5)]
        assert photos == ["crowd.jpg", "other.jpg"]

    def test_top_k_zero_or_negative_returns_nothing(self, seeded_store):
        # The k >= n guard falls through to `k = max(k, 1)`, which used to turn
        # "give me no crops" into "give me one crop".
        ev = EmbeddingStore(seeded_store).load_event("ev1")
        assert ev.top_k("face", basis(0), k=0) == []
        assert ev.top_k("face", basis(0), k=-3) == []
        assert len(ev.top_k("face", basis(0), k=1)) == 1  # k=1 still works

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

    def test_embeddings_for_photo_returns_that_photos_crops(self, seeded_store):
        ev = EmbeddingStore(seeded_store).load_event("ev1")
        crops = ev.embeddings_for_photo("face", "pB.jpg")
        assert crops.shape == (1, DIM)
        assert np.allclose(crops[0], ev.vectors["face"][1])  # pB is row 1

    def test_embeddings_for_photo_collects_multiple_crops(self):
        faces = np.stack([basis(0), basis(1), basis(2)])
        meta = [
            {"photoId": "grp.jpg", "box": [0, 0, 1, 1], "score": 0.9},
            {"photoId": "grp.jpg", "box": [1, 1, 2, 2], "score": 0.9},
            {"photoId": "solo.jpg", "box": [0, 0, 1, 1], "score": 0.9},
        ]
        ev = EventEmbeddings(build_manifest("e", "v", meta, []), faces, np.zeros((0, DIM), np.float32))
        assert ev.embeddings_for_photo("face", "grp.jpg").shape == (2, DIM)
        assert ev.embeddings_for_photo("face", "solo.jpg").shape == (1, DIM)

    def test_embeddings_for_photo_unknown_is_empty(self, seeded_store):
        ev = EmbeddingStore(seeded_store).load_event("ev1")
        crops = ev.embeddings_for_photo("face", "nope.jpg")
        assert crops.shape == (0, DIM)

    def test_taken_at_ms_from_photos_map(self):
        # Capture time comes from the manifest `photos` map (indexer), parsed as
        # UTC. Unknown photo / no photos map → None (→ static outfit weight).
        m = build_manifest("ev", "m@v0", [], [])
        m["photos"] = {"p1": {"takenAt": "2026-06-20T14:30:52"}, "p2": {"takenAt": None}}
        ev = EventEmbeddings(m, np.zeros((0, 4), np.float32), np.zeros((0, 4), np.float32))
        from datetime import datetime, timezone
        expect = int(datetime(2026, 6, 20, 14, 30, 52, tzinfo=timezone.utc).timestamp() * 1000)
        assert ev.taken_at_ms("p1") == expect
        assert ev.taken_at_ms("p2") is None      # takenAt None
        assert ev.taken_at_ms("missing") is None  # photo not in map
        # build_manifest() alone (no photos key) → empty map, always None.
        ev2 = EventEmbeddings(build_manifest("ev", "m@v0", [], []),
                              np.zeros((0, 4), np.float32), np.zeros((0, 4), np.float32))
        assert ev2.taken_at_ms("p1") is None

    def test_tnorm_preserves_order_but_rescales(self, seeded_store):
        ev = EmbeddingStore(seeded_store).load_event("ev1")
        raw = ev.top_k("face", basis(0), k=None)
        norm = ev.top_k("face", basis(0), k=None, tnorm=True)
        assert [h["photoId"] for h in raw] == [h["photoId"] for h in norm]  # order unchanged
        assert norm[0]["score"] != pytest.approx(raw[0]["score"])  # but z-scored
        # z-score of the whole cohort has ~zero mean.
        assert float(np.mean([h["score"] for h in norm])) == pytest.approx(0.0, abs=1e-5)


class TestMeanUnit:
    def test_empty_is_none(self):
        assert main_mod._mean_unit([]) is None

    def test_single_vector_normalized(self):
        out = main_mod._mean_unit([basis(0) * 5.0])  # unnormalized input
        assert np.allclose(out, basis(0))
        assert np.linalg.norm(out) == pytest.approx(1.0)

    def test_centroid_is_unit_and_between(self):
        out = main_mod._mean_unit([basis(0), basis(1)])
        assert np.linalg.norm(out) == pytest.approx(1.0)
        assert out[0] == pytest.approx(out[1])  # equidistant from both refs
        assert out[0] == pytest.approx(1 / np.sqrt(2))

    def test_opposite_vectors_collapse_to_none(self):
        assert main_mod._mean_unit([basis(0), -basis(0)]) is None


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

    def test_multiple_reference_files(self, client, monkeypatch, seeded_store):
        self._env(monkeypatch, seeded_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post(
            "/search",
            data={
                "file": [
                    (io.BytesIO(jpeg_bytes()), "a.jpg"),
                    (io.BytesIO(jpeg_bytes()), "b.jpg"),
                ],
                "event_id": "ev1",
            },
        )
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["numReferences"] == 2
        assert body["results"][0]["photoId"] == "pB.jpg"  # same ranking as single ref

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

    def test_reference_faces_are_per_uploaded_file(self, client, monkeypatch, seeded_store):
        self._env(monkeypatch, seeded_store)
        set_bundle(make_bundle(basis(0), basis(1), face_det=TwoFaceDet()))
        resp = client.post(
            "/search",
            data={
                "file": [
                    (io.BytesIO(jpeg_bytes()), "a.jpg"),
                    (io.BytesIO(jpeg_bytes()), "b.jpg"),
                ],
                "event_id": "ev1",
            },
        )
        assert resp.status_code == 200
        refs = resp.get_json()["referenceFaces"]
        assert [r["faces"] for r in refs] == [2, 2]

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

    def test_missing_file_400(self, client, monkeypatch, seeded_store):
        self._env(monkeypatch, seeded_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post("/search", data={"event_id": "ev1"})
        assert resp.status_code == 400 and resp.get_json()["error"] == "missing_file"

    def test_normalize_flag_reported_and_thresholds(self, client, monkeypatch, seeded_store):
        self._env(monkeypatch, seeded_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        # The 3-photo test cohort yields small z-scores, so drop the (prod-sized)
        # NORM_THRESHOLD to exercise the T-norm gate rather than the magnitude.
        monkeypatch.setattr(main_mod, "NORM_THRESHOLD", 0.5)
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "ev1", "normalize": "1"},
        )
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["normalized"] is True
        assert body["results"][0]["photoId"] == "pB.jpg"  # strong match clears the z-threshold
        assert all(r["score"] >= 0.5 for r in body["results"])  # gated on the T-norm threshold

    def test_prf_folds_confirmed_photo(self, client, monkeypatch, seeded_store):
        self._env(monkeypatch, seeded_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post(
            "/search",
            data={
                "file": (io.BytesIO(jpeg_bytes()), "x.jpg"),
                "event_id": "ev1",
                "mode": "face",
                "prf_photo_ids": "pC.jpg",
            },
        )
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["numPrfPhotos"] == 1
        # pC's face is basis(7); folding it pulls the centroid off basis(0)
        # toward basis(7), so pC now scores above 0 and joins the ranking.
        pc = next((r for r in body["results"] if r["photoId"] == "pC.jpg"), None)
        assert pc is not None and pc["score"] > 0.0


class TestCaptureTimeFusion:
    """Capture-time-conditional outfit fusion (flag off by default).

    pX and pY are identical in face AND outfit to the query, so they tie without
    decay. With the flag on and an anchor near pX's takenAt, pY's outfit boost
    decays to the floor (0.0) while pX keeps it — pX pulls ahead, and neither
    face score is touched. read_capture_time_ms is stubbed so the query's anchor
    is deterministic without encoding EXIF into the test JPEG."""

    def test_off_by_default_keeps_static_weight(self, client, monkeypatch, timed_store):
        monkeypatch.setenv("EMBEDDINGS_ROOT", timed_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "tev"},
        )
        assert resp.status_code == 200
        by = {r["photoId"]: r for r in resp.get_json()["results"]}
        # No decay → both keep the full 0.15 outfit weight and tie at 1.0.
        assert by["pX.jpg"]["score"] == pytest.approx(0.85 + 0.15)
        assert by["pY.jpg"]["score"] == pytest.approx(0.85 + 0.15)
        assert by["pY.jpg"]["personWeight"] == pytest.approx(0.15)

    def test_decay_suppresses_far_in_time_outfit(self, client, monkeypatch, timed_store):
        monkeypatch.setenv("EMBEDDINGS_ROOT", timed_store)
        monkeypatch.setattr(main_mod, "FUSION_TIME_CONDITIONAL", True)
        monkeypatch.setattr(main_mod, "read_capture_time_ms", lambda data: CT_ANCHOR_MS)
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "tev"},
        )
        assert resp.status_code == 200
        body = resp.get_json()
        by = {r["photoId"]: r for r in body["results"]}
        assert by["pX.jpg"]["score"] == pytest.approx(0.85 + 0.15 * 1.0)  # full outfit
        assert by["pY.jpg"]["score"] == pytest.approx(0.85)               # outfit decayed away
        assert by["pX.jpg"]["personWeight"] == pytest.approx(0.15)
        assert by["pY.jpg"]["personWeight"] == pytest.approx(0.0)
        assert by["pX.jpg"]["faceScore"] == pytest.approx(by["pY.jpg"]["faceScore"])  # face untouched
        assert body["results"][0]["photoId"] == "pX.jpg"

    def test_flag_on_but_no_query_exif_falls_back_to_static(self, client, monkeypatch, timed_store):
        # No parseable anchor (query selfie without EXIF) → static weight, no
        # regression: pX and pY tie again even with the flag on.
        monkeypatch.setenv("EMBEDDINGS_ROOT", timed_store)
        monkeypatch.setattr(main_mod, "FUSION_TIME_CONDITIONAL", True)
        monkeypatch.setattr(main_mod, "read_capture_time_ms", lambda data: None)
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "tev"},
        )
        assert resp.status_code == 200
        by = {r["photoId"]: r for r in resp.get_json()["results"]}
        assert by["pX.jpg"]["score"] == pytest.approx(by["pY.jpg"]["score"])


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


class TestSelfieGrading:
    """selfie_score / selfie_advisories (quality.py)."""

    def test_score_rewards_frontal_big_sharp(self):
        good = quality.selfie_score(
            {"frontality": 1.0, "face_frac": 0.30, "blur": 4 * quality.BLUR_THRESHOLD}
        )
        poor = quality.selfie_score(
            {"frontality": 0.2, "face_frac": 0.05, "blur": quality.BLUR_THRESHOLD}
        )
        assert good == pytest.approx(1.0)
        assert poor < 0.45

    def test_unmeasured_frontality_scores_between(self):
        unknown = quality.selfie_score({"frontality": None, "face_frac": 0.30, "blur": 999})
        frontal = quality.selfie_score({"frontality": 1.0, "face_frac": 0.30, "blur": 999})
        turned = quality.selfie_score({"frontality": 0.1, "face_frac": 0.30, "blur": 999})
        assert turned < unknown < frontal

    def test_advisories_flag_fixable_problems(self):
        adv = quality.selfie_advisories(
            {"frontality": 0.3, "face_frac": 0.04, "blur": 2 * quality.BLUR_THRESHOLD}, 2
        )
        assert adv == ["multiple_faces", "not_frontal", "face_small_in_frame", "slightly_soft"]

    def test_clean_single_selfie_has_no_advisories(self):
        assert quality.selfie_advisories(
            {"frontality": 0.9, "face_frac": 0.3, "blur": 10 * quality.BLUR_THRESHOLD}, 1
        ) == []

    def test_unmeasured_fields_advise_nothing(self):
        assert quality.selfie_advisories({}, 1) == []


class TestQualityEndpoint:
    """POST /quality — the pick-time check, before any search."""

    def test_grades_each_picked_file(self, client):
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post(
            "/quality",
            data={"file": [(io.BytesIO(jpeg_bytes()), "a.jpg"), (io.BytesIO(jpeg_bytes()), "b.jpg")]},
        )
        assert resp.status_code == 200
        body = resp.get_json()
        assert [f["index"] for f in body["files"]] == [0, 1]
        assert body["anyUsable"] is True and body["bestIndex"] in (0, 1)
        first = body["files"][0]
        assert first["usable"] is True and first["reasons"] == []
        assert first["faceCount"] == 1 and first["frontality"] == pytest.approx(1.0)
        assert 0.0 <= first["selfieScore"] <= 1.0

    def test_best_index_picks_the_higher_scoring_selfie(self, client, monkeypatch):
        set_bundle(make_bundle(basis(0), basis(1)))
        # FakeFaceDet reports a face at a fixed FRACTION of the image, so the
        # smaller image yields the smaller face in absolute px but the same frac;
        # stub the score so the ranking is unambiguous and still goes through the
        # endpoint's own selection.
        scores = iter([0.30, 0.95])
        monkeypatch.setattr(quality, "selfie_score", lambda q, _s=scores: next(_s))
        resp = client.post(
            "/quality",
            data={"file": [(io.BytesIO(jpeg_bytes()), "a.jpg"), (io.BytesIO(jpeg_bytes()), "b.jpg")]},
        )
        assert resp.get_json()["bestIndex"] == 1

    def test_no_face_is_reported_not_an_error(self, client):
        set_bundle(make_bundle(basis(0), basis(1), face_det=NoFaceDet()))
        resp = client.post("/quality", data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg")})
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["files"][0]["reasons"] == ["no_face"]
        assert body["anyUsable"] is False and body["bestIndex"] is None

    def test_blurry_selfie_is_unusable_with_a_reason(self, client):
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post(
            "/quality", data={"file": (io.BytesIO(jpeg_bytes(sharp=False)), "x.jpg")}
        )
        body = resp.get_json()
        assert body["files"][0]["usable"] is False
        assert "too_blurry" in body["files"][0]["reasons"]
        assert body["anyUsable"] is False

    def test_undecodable_file_reported_per_file(self, client):
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post(
            "/quality",
            data={"file": [(io.BytesIO(b"not an image"), "a.jpg"), (io.BytesIO(jpeg_bytes()), "b.jpg")]},
        )
        assert resp.status_code == 200  # one bad pick must not fail the batch
        body = resp.get_json()
        assert body["files"][0]["reasons"] == ["bad_image"]
        assert body["files"][1]["usable"] is True
        assert body["bestIndex"] == 1

    def test_missing_file_400(self, client):
        assert client.post("/quality", data={}).status_code == 400

    def test_a_second_face_makes_the_selfie_unusable(self, client):
        # Hard stop, not a hint: with a bystander in frame the query face would
        # be chosen by detector confidence, which is a coin flip.
        set_bundle(make_bundle(basis(0), basis(1), face_det=TwoFaceDet()))
        resp = client.post("/quality", data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg")})
        assert resp.status_code == 200
        f = resp.get_json()["files"][0]
        assert f["faceCount"] == 2
        assert f["usable"] is False
        assert f["reasons"][0] == "multiple_faces"
        # Reported once, as a reason — never also as an advisory.
        assert "multiple_faces" not in f["advisories"]
        assert resp.get_json()["anyUsable"] is False
        assert resp.get_json()["bestIndex"] is None

    def test_a_multi_face_pick_never_becomes_best(self, client):
        set_bundle(make_bundle(basis(0), basis(1), face_det=TwoFaceDet()))
        resp = client.post(
            "/quality",
            data={"file": [(io.BytesIO(jpeg_bytes()), "group.jpg"),
                           (io.BytesIO(jpeg_bytes()), "solo.jpg")]},
        )
        body = resp.get_json()
        # Both picks came from TwoFaceDet, so neither is selectable.
        assert body["anyUsable"] is False and body["bestIndex"] is None

    def test_indexed_faces_are_untouched_by_the_selfie_rule(self):
        """The multi-face stop is endpoint-scoped. `assess_face` is shared with
        the indexer, where a photo full of faces is the normal case."""
        img = rng.integers(0, 255, (400, 400, 3), dtype=np.uint8)
        det = {"box": [100, 100, 300, 300], "score": 0.9}
        assert quality.assess_face(img, det)["usable"] is True

    def test_reports_the_face_box_for_a_crop_preview(self, client):
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post("/quality", data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg")})
        # FakeFaceDet's box, as fractions of the image — the client crops to it
        # to ask "is this you?" without knowing the pixel dimensions.
        assert resp.get_json()["files"][0]["faceBox"] == pytest.approx([0.3, 0.2, 0.7, 0.8], abs=1e-6)

    def test_unreadable_and_faceless_picks_have_no_box(self, client):
        set_bundle(make_bundle(basis(0), basis(1), face_det=NoFaceDet()))
        resp = client.post(
            "/quality",
            data={"file": [(io.BytesIO(b"not an image"), "a.jpg"), (io.BytesIO(jpeg_bytes()), "b.jpg")]},
        )
        files = resp.get_json()["files"]
        assert files[0].get("faceBox") is None  # bad_image short-circuits
        assert files[1].get("faceBox") is None  # no_face short-circuits

    def test_computes_no_embeddings(self, client, monkeypatch):
        """The pick-time check must stay detection-only (cost + no biometrics)."""
        bundle = make_bundle(basis(0), basis(1))

        def fail(*_a, **_kw):
            raise AssertionError("embedder must not run for a quality check")

        monkeypatch.setattr(bundle.face_emb, "embed", fail)
        monkeypatch.setattr(bundle.person_emb, "embed", fail)
        set_bundle(bundle)
        assert client.post("/quality", data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg")}).status_code == 200


class TestStoreQualityWeighting:
    """Item 5 attenuation is opt-in and only ever demotes."""

    @staticmethod
    def _event():
        faces = np.stack([basis(0), basis(0), basis(0)])
        meta = [
            {"photoId": "clean.jpg", "box": [0, 0, 400, 400], "score": 0.9,
             "quality": {"frontality": 1.0, "face_frac": 0.25, "usable": True}},
            {"photoId": "tiny_side.jpg", "box": [0, 0, 30, 30], "score": 0.6,
             "quality": {"frontality": 0.4, "face_frac": 0.02, "usable": False}},
            {"photoId": "legacy.jpg", "box": [0, 0, 200, 200], "score": 0.9},  # pre-quality manifest
        ]
        return EventEmbeddings(build_manifest("q", "v", meta, []), faces,
                               np.zeros((0, DIM), np.float32))

    def test_off_by_default_is_a_plain_tie(self):
        hits = self._event().top_photos("face", basis(0), k=None)
        assert {h["photoId"] for h in hits} == {"clean.jpg", "tiny_side.jpg", "legacy.jpg"}
        assert all(h["score"] == pytest.approx(1.0) for h in hits)

    def test_weight_demotes_small_side_on_face(self):
        hits = self._event().top_photos("face", basis(0), k=None, quality_weight=1.0)
        by = {h["photoId"]: h["score"] for h in hits}
        assert by["clean.jpg"] == pytest.approx(1.0)          # frontal + big → untouched
        assert by["tiny_side.jpg"] == pytest.approx(0.1)      # 0.4 × (0.02/0.08)
        assert by["legacy.jpg"] == pytest.approx(1.0)         # no quality recorded → no penalty
        assert hits[0]["photoId"] != "tiny_side.jpg"

    def test_partial_weight_scales_the_penalty(self):
        hits = self._event().top_photos("face", basis(0), k=None, quality_weight=0.5)
        by = {h["photoId"]: h["score"] for h in hits}
        assert by["tiny_side.jpg"] == pytest.approx(1.0 - 0.5 * (1.0 - 0.1))

    def test_negative_scores_are_not_promoted(self):
        # basis(7) is orthogonal-ish: attenuating a negative z would raise it.
        ev = self._event()
        plain = ev.top_k("face", -basis(0), k=None)
        weighted = ev.top_k("face", -basis(0), k=None, quality_weight=1.0)
        assert all(a["score"] == pytest.approx(b["score"]) for a, b in zip(plain, weighted))

    def test_row_index_helpers(self):
        ev = self._event()
        assert ev.face_count("clean.jpg") == 1
        assert ev.face_count("missing.jpg") == 0
        assert ev.rows_for_photo("face", "tiny_side.jpg") == [1]
        assert ev.crop_meta("face", 0)["photoId"] == "clean.jpg"


@pytest.fixture
def anchor_store(tmp_path):
    """Event 'aev' with three shapes of result for the same face query basis(0):

      pSolo  — one big frontal face; the ideal anchor. Outfit basis(2).
      pSide  — one big face but turned away (frontality 0.30) → gated out.
      pCrowd — six faces, one small and side-on; a crowd shot → gated out.

    The query selfie's outfit is basis(1), which matches NOTHING in the event —
    so any person score above zero proves the anchor's outfit reached the query.
    """
    faces = np.stack([
        basis(0),                                    # pSolo
        basis(0),                                    # pSide
        unit(basis(0) * 0.9 + basis(5) * 0.45),      # pCrowd (matched face)
        *[basis(10 + i) for i in range(5)],          # pCrowd (bystanders)
    ])
    faces_meta = [
        {"photoId": "pSolo.jpg", "box": [100, 100, 500, 500], "score": 0.95,
         "quality": {"frontality": 0.95, "face_frac": 0.22, "usable": True}},
        {"photoId": "pSide.jpg", "box": [100, 100, 500, 500], "score": 0.9,
         "quality": {"frontality": 0.30, "face_frac": 0.20, "usable": True}},
        {"photoId": "pCrowd.jpg", "box": [10, 10, 50, 50], "score": 0.7,
         "quality": {"frontality": 0.25, "face_frac": 0.02, "usable": False}},
        *[{"photoId": "pCrowd.jpg", "box": [60 + 40 * i, 10, 100 + 40 * i, 50], "score": 0.7,
           "quality": {"frontality": 0.5, "face_frac": 0.02, "usable": False}} for i in range(5)],
    ]
    persons = np.stack([basis(2), basis(3), basis(4)])
    persons_meta = [
        # Contains pSolo's face centre (300, 300).
        {"photoId": "pSolo.jpg", "box": [80, 90, 560, 900], "score": 0.8, "source": "detector"},
        {"photoId": "pSide.jpg", "box": [80, 90, 560, 900], "score": 0.8, "source": "detector"},
        # Contains pCrowd's matched face centre (30, 30) but not the bystanders'.
        {"photoId": "pCrowd.jpg", "box": [0, 0, 55, 400], "score": 0.8, "source": "detector"},
    ]
    manifest = build_manifest("aev", "test@v0", faces_meta, persons_meta)
    write_local(str(tmp_path / "aev"), manifest, faces, persons)
    return str(tmp_path)


class TestAnchorSuggestion:
    """`anchorSuggestion` nominates a clean, in-domain photo to re-query with."""

    def test_prefers_the_solo_frontal_photo(self, client, monkeypatch, anchor_store):
        monkeypatch.setenv("EMBEDDINGS_ROOT", anchor_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "aev"},
        )
        assert resp.status_code == 200
        sug = resp.get_json()["anchorSuggestion"]
        assert sug["photoId"] == "pSolo.jpg"
        assert sug["faceCount"] == 1 and sug["qualityKnown"] is True
        assert sug["frontality"] == pytest.approx(0.95)

    def test_turned_away_and_crowd_shots_are_never_suggested(self, client, monkeypatch, anchor_store):
        monkeypatch.setenv("EMBEDDINGS_ROOT", anchor_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        # Drop pSolo from contention by demanding a frontality it can't meet, so
        # the only remaining candidates are the side-on and crowd photos.
        monkeypatch.setattr(main_mod, "ANCHOR_MIN_FRONTALITY", 0.99)
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "aev"},
        )
        assert resp.get_json()["anchorSuggestion"] is None

    def test_crowd_shot_rejected_on_face_count_alone(self, client, monkeypatch, anchor_store):
        monkeypatch.setenv("EMBEDDINGS_ROOT", anchor_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        # Neutralize the quality gates; the 6-face count must still exclude it.
        monkeypatch.setattr(main_mod, "ANCHOR_MIN_FRONTALITY", 0.0)
        monkeypatch.setattr(main_mod, "ANCHOR_MIN_FACE_FRAC", 0.0)
        monkeypatch.setattr(main_mod, "ANCHOR_MAX_FACES", 2)
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "aev", "mode": "face"},
        )
        assert resp.get_json()["anchorSuggestion"]["photoId"] != "pCrowd.jpg"

    def test_weak_match_is_not_offered_as_a_reference(self, client, monkeypatch, anchor_store):
        monkeypatch.setenv("EMBEDDINGS_ROOT", anchor_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        monkeypatch.setattr(main_mod, "ANCHOR_MIN_FACE_SCORE", 1.5)  # unreachable cosine
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "aev"},
        )
        assert resp.get_json()["anchorSuggestion"] is None

    def test_can_be_switched_off(self, client, monkeypatch, anchor_store):
        monkeypatch.setenv("EMBEDDINGS_ROOT", anchor_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        monkeypatch.setattr(main_mod, "ANCHOR_SUGGEST", False)
        resp = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "aev"},
        )
        assert resp.get_json()["anchorSuggestion"] is None

    def test_applied_anchor_is_not_suggested_again(self, client, monkeypatch, anchor_store):
        monkeypatch.setenv("EMBEDDINGS_ROOT", anchor_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post(
            "/search",
            data={
                "file": (io.BytesIO(jpeg_bytes()), "x.jpg"),
                "event_id": "aev",
                "anchor_photo_ids": "pSolo.jpg",
            },
        )
        body = resp.get_json()
        assert body["anchorPhotoIds"] == ["pSolo.jpg"]
        assert body["anchorSuggestion"] is None  # only pSolo qualified


class TestAnchorQuery:
    """Applying an anchor re-queries from the index — no re-embedding."""

    def test_anchor_outfit_replaces_the_selfie_outfit(self, client, monkeypatch, anchor_store):
        monkeypatch.setenv("EMBEDDINGS_ROOT", anchor_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        plain = client.post(
            "/search",
            data={"file": (io.BytesIO(jpeg_bytes()), "x.jpg"), "event_id": "aev"},
        ).get_json()
        # The selfie's outfit matches nothing: every person score is 0.
        assert all((r["personScore"] or 0.0) == pytest.approx(0.0) for r in plain["results"])

        anchored = client.post(
            "/search",
            data={
                "file": (io.BytesIO(jpeg_bytes()), "x.jpg"),
                "event_id": "aev",
                "anchor_photo_ids": "pSolo.jpg",
            },
        ).get_json()
        by = {r["photoId"]: r for r in anchored["results"]}
        # pSolo's own outfit row is now the person query → it scores 1.0 and the
        # photo overtakes pSide, which ties it on face alone.
        assert by["pSolo.jpg"]["personScore"] == pytest.approx(1.0)
        assert anchored["results"][0]["photoId"] == "pSolo.jpg"

    def test_blend_mode_keeps_both_outfits(self, client, monkeypatch, anchor_store):
        monkeypatch.setenv("EMBEDDINGS_ROOT", anchor_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        monkeypatch.setattr(main_mod, "ANCHOR_PERSON_MODE", "blend")
        body = client.post(
            "/search",
            data={
                "file": (io.BytesIO(jpeg_bytes()), "x.jpg"),
                "event_id": "aev",
                "anchor_photo_ids": "pSolo.jpg",
            },
        ).get_json()
        by = {r["photoId"]: r for r in body["results"]}
        # Centroid of the selfie's basis(1) and the anchor's basis(2): cos = 1/√2.
        assert by["pSolo.jpg"]["personScore"] == pytest.approx(0.7071, abs=1e-3)

    def test_anchor_pairs_the_outfit_by_geometry_not_rank(self, client, monkeypatch, anchor_store):
        monkeypatch.setenv("EMBEDDINGS_ROOT", anchor_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        body = client.post(
            "/search",
            data={
                "file": (io.BytesIO(jpeg_bytes()), "x.jpg"),
                "event_id": "aev",
                "anchor_photo_ids": "pCrowd.jpg",
            },
        ).get_json()
        by = {r["photoId"]: r for r in body["results"]}
        # pCrowd holds six faces but only one person box, the one containing the
        # matched face — so the outfit folded in is basis(3), not a bystander's.
        assert body["anchorPhotoIds"] == ["pCrowd.jpg"]
        assert by["pCrowd.jpg"]["personScore"] == pytest.approx(1.0)

    def test_unknown_anchor_is_ignored_not_fatal(self, client, monkeypatch, anchor_store):
        monkeypatch.setenv("EMBEDDINGS_ROOT", anchor_store)
        set_bundle(make_bundle(basis(0), basis(1)))
        resp = client.post(
            "/search",
            data={
                "file": (io.BytesIO(jpeg_bytes()), "x.jpg"),
                "event_id": "aev",
                "anchor_photo_ids": "nope.jpg,pSolo.jpg",
            },
        )
        assert resp.status_code == 200
        assert resp.get_json()["anchorPhotoIds"] == ["pSolo.jpg"]

    def test_anchor_face_weight_shifts_the_centroid(self, client, monkeypatch, anchor_store):
        monkeypatch.setenv("EMBEDDINGS_ROOT", anchor_store)
        # Selfie face is basis(6) — nothing in the event matches it — so only a
        # weighted anchor face can pull the query onto basis(0).
        set_bundle(make_bundle(basis(6), basis(1)))
        body = client.post(
            "/search",
            data={
                "file": (io.BytesIO(jpeg_bytes()), "x.jpg"),
                "event_id": "aev",
                "mode": "face",
                "anchor_photo_ids": "pSolo.jpg",
            },
        ).get_json()
        by = {r["photoId"]: r["score"] for r in body["results"]}
        # Centroid of basis(6) and basis(0) at equal weight → cos = 1/√2.
        assert by["pSolo.jpg"] == pytest.approx(0.7071, abs=1e-3)


class TestWeightedCentroid:
    def test_weights_bias_the_mean(self):
        heavy = main_mod._mean_unit([basis(0), basis(1)], [3.0, 1.0])
        assert heavy is not None
        assert float(heavy @ basis(0)) > float(heavy @ basis(1))

    def test_uniform_weights_match_the_plain_mean(self):
        plain = main_mod._mean_unit([basis(0), basis(1)])
        weighted = main_mod._mean_unit([basis(0), basis(1)], [1.0, 1.0])
        assert np.allclose(plain, weighted)

    def test_length_mismatch_is_an_error(self):
        with pytest.raises(ValueError):
            main_mod._mean_unit([basis(0), basis(1)], [1.0])

    def test_zero_total_weight_returns_none(self):
        assert main_mod._mean_unit([basis(0)], [0.0]) is None


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
