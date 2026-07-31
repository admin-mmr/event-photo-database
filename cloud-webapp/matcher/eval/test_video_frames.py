"""
test_video_frames.py — tests for the Phase 0 frame selector.

Selection logic is tested with hand-built candidates and an injected embedder,
so the interesting cases (near-dup vs new runner, absolute gates, budget) need
neither ffmpeg nor ONNX. The decode path is exercised separately against a tiny
clip synthesised at test time and skips when ffmpeg is absent — no video fixtures
in the repo (plan §2.3 Phase 1: "no fixtures over a few hundred KB").
"""

from __future__ import annotations

import os
import subprocess
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import video_frames as vf

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

# The selector measures sharpness through cv2 and decodes stills through PIL —
# both are matcher runtime deps, so a venv without them can't test any of this.
pytest.importorskip("cv2")
pytest.importorskip("PIL")

needs_ffmpeg = pytest.mark.skipif(not vf.have_ffmpeg(), reason="ffmpeg/ffprobe not on PATH")


# ── helpers ───────────────────────────────────────────────────────────────────


def _emb(seed: int, dim: int = 512) -> np.ndarray:
    """A deterministic unit vector standing in for an ArcFace embedding."""
    rng = np.random.default_rng(seed)
    v = rng.normal(size=dim).astype(np.float32)
    return v / np.linalg.norm(v)


def _cand(ts, score=0.5, faces=None, persons=None, blur=100.0):
    return vf.FrameCandidate(
        ts=ts, jpeg=b"x", width=1920, height=1080, frame_blur=blur, score=score,
        faces=faces if faces is not None else [],
        persons=persons if persons is not None else [],
    )


def _face(embedding, box=(100, 100, 200, 200), px=100, blur=90.0):
    return {"box": list(box), "det_score": 0.9, "face_px": px, "blur": blur,
            "embedding": embedding, "warnings": []}


def _metric(ts, blur, brightness=120.0, diff=5.0, hist=None):
    return vf.ScanMetric(ts=ts, blur=blur, brightness=brightness, diff=diff, hist=hist)


# ── budget ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("duration,expected", [
    (0.0, 3),      # floor
    (5.0, 3),      # 1 → floor
    (30.0, 6),
    (60.0, 12),
    (600.0, 30),   # ceiling
])
def test_budget_clamps(duration, expected):
    assert vf.budget_for(duration, vf.Config()) == expected


# ── stage A gating ────────────────────────────────────────────────────────────


def test_gate_rejects_dark_blown_and_blurry_with_reasons():
    cfg = vf.Config(scan_blur_pct=0)   # isolate the absolute floors
    metrics = [
        _metric(0.0, blur=200.0, brightness=5.0),      # too dark
        _metric(1.0, blur=200.0, brightness=250.0),    # blown out
        _metric(2.0, blur=1.0, brightness=120.0),      # too blurry
        _metric(3.0, blur=200.0, brightness=120.0),    # keeper
    ]
    kept = vf.gate_scan(metrics, cfg)
    assert [m.ts for m in kept] == [3.0]
    assert [m.rejected for m in metrics[:3]] == ["too_dark", "blown_out", "scan_too_blurry"]


def test_gate_percentile_floor_drops_the_softest_of_a_uniformly_soft_clip():
    cfg = vf.Config(scan_min_blur=0.0, scan_blur_pct=50.0)
    metrics = [_metric(float(i), blur=20.0 + i) for i in range(10)]
    kept = vf.gate_scan(metrics, cfg)
    assert len(kept) == 5
    assert all(m.blur >= 24.5 for m in kept)
    assert all(m.rejected == "below_clip_blur_pct" for m in metrics[:5])


# ── stage A selector (the sharp-frames baseline) ───────────────────────────────


def test_best_n_spaced_honours_the_min_buffer():
    metrics = [_metric(0.0, 500), _metric(0.1, 490), _metric(0.2, 480), _metric(5.0, 100)]
    chosen = vf.best_n_spaced(metrics, n=3, min_buffer_s=1.0)
    assert [m.ts for m in chosen] == [0.0, 5.0]   # the 0.1/0.2 neighbours are too close


def test_best_n_spaced_returns_in_time_order_but_picks_by_sharpness():
    metrics = [_metric(0.0, 10), _metric(2.0, 900), _metric(4.0, 500)]
    chosen = vf.best_n_spaced(metrics, n=2, min_buffer_s=1.0)
    assert [m.ts for m in chosen] == [2.0, 4.0]


def test_katna_like_picks_the_sharpest_of_each_colour_cluster():
    red = np.zeros(512, dtype=np.float64); red[0] = 1.0
    blue = np.zeros(512, dtype=np.float64); blue[300] = 1.0
    metrics = [
        _metric(0.0, 100, hist=red), _metric(0.5, 300, hist=red),
        _metric(3.0, 150, hist=blue), _metric(3.5, 50, hist=blue),
    ]
    chosen = vf.katna_like_select(metrics, n=2, seed=1)
    assert sorted(m.ts for m in chosen) == [0.5, 3.0]


def test_katna_like_falls_back_to_sharpness_without_histograms():
    metrics = [_metric(0.0, 10), _metric(1.0, 900), _metric(2.0, 500)]
    chosen = vf.katna_like_select(metrics, n=2)
    assert [m.ts for m in chosen] == [1.0, 2.0]


# ── stage B gates ─────────────────────────────────────────────────────────────


def test_analyse_candidate_rejects_a_frame_with_no_publishable_face():
    cfg = vf.Config()
    jpeg = _jpeg_bytes(np.full((240, 320, 3), 128, dtype=np.uint8))
    cand = vf.analyse_candidate(1.0, jpeg, cfg, embed=lambda img: {"faces": [], "persons": []})
    assert cand.reasons == ["no_publishable_face"]
    assert not cand.accepted


def test_analyse_candidate_drops_faces_below_the_absolute_gates():
    """A tiny or soft face must not count, even if the detector was confident —
    these are the photo-path thresholds, so 'publishable' means the same thing
    here as it does for a searcher's reference photo."""
    cfg = vf.Config()
    jpeg = _jpeg_bytes(np.full((240, 320, 3), 128, dtype=np.uint8))

    def embed(_img):
        return {
            "faces": [
                # usable per assess_face, but under our own size gate
                {"box": [0, 0, 20, 20], "score": 0.9, "embedding": _emb(1),
                 "quality": {"usable": True, "face_px": 20, "blur": 900.0, "warnings": []}},
                # big and sharp, but assess_face already refused it
                {"box": [0, 0, 300, 300], "score": 0.9, "embedding": _emb(2),
                 "quality": {"usable": False, "face_px": 300, "blur": 10.0,
                             "reasons": ["too_blurry"], "warnings": []}},
                # the keeper
                {"box": [10, 10, 130, 130], "score": 0.9, "embedding": _emb(3),
                 "quality": {"usable": True, "face_px": 120, "blur": 300.0, "warnings": []}},
            ],
            "persons": [{"box": [0, 0, 200, 240], "score": 0.8}],
        }

    cand = vf.analyse_candidate(1.0, jpeg, cfg, embed=embed)
    assert cand.accepted
    assert [f["face_px"] for f in cand.faces] == [120]
    assert cand.best_face_px == 120


def _embed_one_face(face_px: int, blur: float, det_score: float = 0.9,
                    assess_reasons: list[str] | None = None):
    """An embedder returning a single face, with assess_face's verdict spelled out
    the way the real pipeline reports it."""
    reasons = assess_reasons if assess_reasons is not None else (
        (["too_small"] if face_px < 40 else []) + (["too_blurry"] if blur < 45.0 else []))
    side = max(face_px, 1)

    def embed(_img):
        return {"faces": [{"box": [0, 0, side, side], "score": det_score,
                           "embedding": _emb(1),
                           "quality": {"usable": not reasons, "face_px": face_px,
                                       "blur": blur, "reasons": reasons,
                                       "warnings": []}}],
                "persons": []}
    return embed


def test_min_face_px_can_be_LOOSENED_not_just_tightened():
    """Regression: assess_face bakes in MIN_FACE_PX=40, so reading its `usable`
    flag made --min-face-px a one-way ratchet — lowering it changed nothing and
    the Phase 0 sweep silently measured the same run twice."""
    jpeg = _jpeg_bytes(np.full((240, 320, 3), 128, dtype=np.uint8))
    embed = _embed_one_face(face_px=30, blur=300.0)

    strict = vf.analyse_candidate(1.0, jpeg, vf.Config(min_face_px=40), embed=embed)
    assert not strict.accepted
    assert strict.near_miss["dropped"] == "face_too_small"

    loose = vf.analyse_candidate(1.0, jpeg, vf.Config(min_face_px=25), embed=embed)
    assert loose.accepted, "lowering the gate must recover a 30px face"
    assert loose.best_face_px == 30


def test_min_face_blur_can_be_loosened_too():
    jpeg = _jpeg_bytes(np.full((240, 320, 3), 128, dtype=np.uint8))
    embed = _embed_one_face(face_px=120, blur=20.0)
    assert not vf.analyse_candidate(1.0, jpeg, vf.Config(), embed=embed).accepted
    assert vf.analyse_candidate(1.0, jpeg, vf.Config(min_face_blur=10.0),
                               embed=embed).accepted


def test_non_size_assess_face_reasons_are_still_respected():
    """Loosening size/blur must not smuggle past a face the detector itself
    wasn't confident about."""
    jpeg = _jpeg_bytes(np.full((240, 320, 3), 128, dtype=np.uint8))
    embed = _embed_one_face(face_px=200, blur=500.0, det_score=0.2,
                            assess_reasons=["low_confidence"])
    cand = vf.analyse_candidate(1.0, jpeg, vf.Config(min_face_px=1, min_face_blur=0.0),
                                embed=embed)
    assert not cand.accepted
    assert cand.near_miss["dropped"] == "assess_face:low_confidence"


def test_low_det_score_is_gated_even_when_assess_face_stayed_quiet():
    jpeg = _jpeg_bytes(np.full((240, 320, 3), 128, dtype=np.uint8))
    embed = _embed_one_face(face_px=200, blur=500.0, det_score=0.3, assess_reasons=[])
    cand = vf.analyse_candidate(1.0, jpeg, vf.Config(min_det_score=0.5), embed=embed)
    assert cand.near_miss["dropped"] == "low_confidence"
    assert vf.analyse_candidate(1.0, jpeg, vf.Config(min_det_score=0.25),
                               embed=embed).accepted


def test_analyse_candidate_marks_a_failed_extract():
    cand = vf.analyse_candidate(1.0, b"", vf.Config(), embed=lambda img: {})
    assert cand.reasons == ["extract_failed"]


def test_require_face_off_keeps_a_faceless_frame():
    cfg = vf.Config(require_face=False)
    jpeg = _jpeg_bytes(np.full((240, 320, 3), 128, dtype=np.uint8))
    cand = vf.analyse_candidate(1.0, jpeg, cfg, embed=lambda img: {"faces": [], "persons": []})
    assert cand.accepted


# ── scoring ───────────────────────────────────────────────────────────────────


def test_score_prefers_the_sharper_bigger_face():
    cfg = vf.Config()
    soft = _cand(0.0, faces=[_face(_emb(1), px=60, blur=60.0)])
    sharp = _cand(3.0, faces=[_face(_emb(1), px=200, blur=400.0)])
    vf.score_candidates([soft, sharp], cfg)
    assert sharp.score > soft.score


def test_iframe_breaks_a_tie():
    cfg = vf.Config()
    a = _cand(0.0, faces=[_face(_emb(1))])
    b = _cand(3.0, faces=[_face(_emb(1))])
    b.is_iframe = True
    vf.score_candidates([a, b], cfg)
    assert b.score > a.score
    assert b.score - a.score == pytest.approx(cfg.iframe_bonus)


def test_rejected_candidates_are_not_scored():
    """A rejected frame must not be normalised against — otherwise a gate
    failure would drag the whole clip's score range around."""
    cfg = vf.Config()
    bad = _cand(0.0, score=0.0, blur=1e6, faces=[_face(_emb(1), px=9999, blur=1e6)])
    bad.reasons.append("no_publishable_face")
    good = _cand(1.0, score=0.0, faces=[_face(_emb(1))])
    vf.score_candidates([bad, good], cfg)
    assert bad.score == 0.0, "rejected candidates keep their score untouched"
    assert good.score == pytest.approx(
        cfg.w_face_blur + cfg.w_face_px + cfg.w_frame_blur
        + cfg.w_persons * 0.0), "the sole live candidate normalises to the top of each term"


# ── diversity: the piece no library gives us ──────────────────────────────────


def test_same_person_same_place_close_in_time_is_a_near_dup():
    cfg = vf.Config()
    e = _emb(7)
    a = _cand(1.0, score=0.9, faces=[_face(e)], persons=[{"box": [0, 0, 300, 800], "score": 0.9}])
    b = _cand(1.4, score=0.5, faces=[_face(e)], persons=[{"box": [5, 5, 305, 805], "score": 0.9}])
    assert vf.same_photo(b, a, cfg)
    kept = vf.select_diverse([a, b], budget=5, cfg=cfg)
    assert [c.ts for c in kept] == [1.0]
    assert b.reasons == ["near_dup"] and b.dup_of == 1.0


def test_a_new_runner_entering_frame_is_not_a_dup():
    cfg = vf.Config()
    a = _cand(1.0, score=0.9, faces=[_face(_emb(7))],
              persons=[{"box": [0, 0, 300, 800], "score": 0.9}])
    b = _cand(1.3, score=0.5, faces=[_face(_emb(7)), _face(_emb(8), box=(500, 100, 600, 200))],
              persons=[{"box": [0, 0, 300, 800], "score": 0.9},
                       {"box": [450, 50, 700, 800], "score": 0.9}])
    assert not vf.same_photo(b, a, cfg)
    assert len(vf.select_diverse([a, b], budget=5, cfg=cfg)) == 2


def test_a_different_person_is_not_a_dup():
    cfg = vf.Config()
    a = _cand(1.0, score=0.9, faces=[_face(_emb(7))],
              persons=[{"box": [0, 0, 300, 800], "score": 0.9}])
    b = _cand(1.2, score=0.5, faces=[_face(_emb(99))],
              persons=[{"box": [0, 0, 300, 800], "score": 0.9}])
    assert not vf.same_photo(b, a, cfg)


def test_same_person_moved_across_the_frame_is_not_a_dup():
    """Geometry is the second half of the test: the same runner in a materially
    different position is a different photograph."""
    cfg = vf.Config()
    e = _emb(7)
    a = _cand(1.0, score=0.9, faces=[_face(e, box=(100, 100, 200, 200))],
              persons=[{"box": [50, 50, 350, 900], "score": 0.9}])
    b = _cand(1.3, score=0.5, faces=[_face(e, box=(1500, 100, 1600, 200))],
              persons=[{"box": [1450, 50, 1750, 900], "score": 0.9}])
    assert not vf.same_photo(b, a, cfg)


def test_far_apart_in_time_is_never_a_dup():
    cfg = vf.Config(dup_gap_s=2.0)
    e = _emb(7)
    a = _cand(1.0, score=0.9, faces=[_face(e)], persons=[{"box": [0, 0, 300, 800], "score": 1.0}])
    b = _cand(9.0, score=0.5, faces=[_face(e)], persons=[{"box": [0, 0, 300, 800], "score": 1.0}])
    assert not vf.same_photo(b, a, cfg)


def test_select_diverse_respects_the_budget_and_keeps_the_best():
    cfg = vf.Config()
    cands = [_cand(float(i) * 5, score=i / 10, faces=[_face(_emb(i))]) for i in range(1, 8)]
    kept = vf.select_diverse(cands, budget=3, cfg=cfg)
    assert len(kept) == 3
    assert sorted(c.score for c in kept) == pytest.approx([0.5, 0.6, 0.7])
    assert all("over_budget" in c.reasons for c in cands if c not in kept)


def test_select_diverse_ignores_already_rejected_candidates():
    cfg = vf.Config()
    bad = _cand(0.0, score=1.0)
    bad.reasons.append("no_publishable_face")
    good = _cand(5.0, score=0.1, faces=[_face(_emb(1))])
    assert [c.ts for c in vf.select_diverse([bad, good], budget=5, cfg=cfg)] == [5.0]


def test_missing_embeddings_never_collapse_two_frames():
    """Unknown identity must not be treated as 'same person' — publishing two
    similar frames is a smaller failure than dropping a distinct one."""
    cfg = vf.Config()
    a = _cand(1.0, score=0.9, faces=[_face(None)])
    b = _cand(1.2, score=0.5, faces=[_face(None)])
    assert not vf.same_photo(b, a, cfg)


# ── scan dims / probe plumbing ────────────────────────────────────────────────


def test_scan_dims_are_even_and_keep_aspect():
    info = vf.VideoInfo(duration_s=10, width=1920, height=1080, display_width=1920,
                        display_height=1080, fps=30, rotation=0, codec="h264",
                        transfer="", is_hdr=False)
    w, h = vf._scan_dims(info, vf.Config(scan_width=481))
    assert w % 2 == 0 and h % 2 == 0
    assert abs((w / h) - (1920 / 1080)) < 0.05


def test_scan_dims_never_upscale_a_small_clip():
    info = vf.VideoInfo(duration_s=10, width=320, height=240, display_width=320,
                        display_height=240, fps=30, rotation=0, codec="h264",
                        transfer="", is_hdr=False)
    w, _ = vf._scan_dims(info, vf.Config(scan_width=480))
    assert w == 320


def test_portrait_rotation_swaps_the_display_dims():
    info = vf.VideoInfo(duration_s=10, width=1920, height=1080, display_width=1080,
                        display_height=1920, fps=30, rotation=90, codec="hevc",
                        transfer="", is_hdr=False)
    w, h = vf._scan_dims(info, vf.Config(scan_width=480))
    assert h > w


def test_iou_edges():
    assert vf._iou([0, 0, 10, 10], [0, 0, 10, 10]) == pytest.approx(1.0)
    assert vf._iou([0, 0, 10, 10], [100, 100, 110, 110]) == 0.0
    assert vf._iou([0, 0, 0, 0], [0, 0, 10, 10]) == 0.0


def test_cos_handles_zero_vectors():
    assert vf._cos(np.zeros(4), np.ones(4)) == 0.0
    assert vf._cos(np.ones(4), np.ones(4)) == pytest.approx(1.0)


# ── end-to-end over a synthesised clip (needs ffmpeg) ─────────────────────────


def _jpeg_bytes(bgr: np.ndarray) -> bytes:
    import cv2
    ok, buf = cv2.imencode(".jpg", bgr)
    assert ok
    return buf.tobytes()


def _make_clip(path: str, frames: list[np.ndarray], fps: int = 10) -> None:
    """Encode BGR frames to an mp4 via ffmpeg's rawvideo input."""
    h, w = frames[0].shape[:2]
    cmd = [vf.FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
           "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
           "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path]
    proc = subprocess.run(cmd, input=b"".join(f.tobytes() for f in frames),
                          capture_output=True)
    assert proc.returncode == 0, proc.stderr.decode()[:400]


def _sharp_frame(w=320, h=240, cell=8) -> np.ndarray:
    ys, xs = np.mgrid[0:h, 0:w]
    checks = (((xs // cell) + (ys // cell)) % 2 * 255).astype(np.uint8)
    return np.dstack([checks] * 3)


@needs_ffmpeg
def test_probe_reads_geometry_from_a_real_clip(tmp_path):
    path = str(tmp_path / "clip.mp4")
    _make_clip(path, [_sharp_frame() for _ in range(20)], fps=10)
    info = vf.probe(path)
    assert (info.display_width, info.display_height) == (320, 240)
    assert info.fps == pytest.approx(10, abs=0.6)
    assert info.duration_s == pytest.approx(2.0, abs=0.4)
    assert not info.is_hdr


@needs_ffmpeg
def test_probe_raises_on_a_non_video(tmp_path):
    path = str(tmp_path / "not-a-video.mp4")
    with open(path, "wb") as fh:
        fh.write(b"definitely not a video")
    with pytest.raises(RuntimeError):
        vf.probe(path)


@needs_ffmpeg
def test_scan_measures_dark_and_sharp_frames_and_the_gate_drops_the_dark_ones(tmp_path):
    import cv2
    path = str(tmp_path / "mixed.mp4")
    sharp = _sharp_frame()
    dark = np.zeros_like(sharp)
    blurry = cv2.GaussianBlur(sharp, (0, 0), 6)
    # 1s sharp, 1s black, 1s blurred, at 10 fps
    _make_clip(path, [sharp] * 10 + [dark] * 10 + [blurry] * 10, fps=10)

    info = vf.probe(path)
    cfg = vf.Config(scan_fps=5.0, scan_blur_pct=0)
    metrics = vf.scan(path, info, cfg)
    assert len(metrics) >= 10

    kept = vf.gate_scan(metrics, cfg)
    assert kept, "the sharp second should survive"
    assert any(m.rejected == "too_dark" for m in metrics)
    # the sharp segment must out-measure the blurred one
    sharp_blur = max(m.blur for m in metrics if m.ts < 1.0)
    blurred = [m.blur for m in metrics if m.ts >= 2.0]
    if blurred:
        assert sharp_blur > max(blurred) * 2


@needs_ffmpeg
def test_extract_still_returns_a_full_resolution_jpeg(tmp_path):
    import cv2
    path = str(tmp_path / "clip.mp4")
    _make_clip(path, [_sharp_frame(640, 480) for _ in range(20)], fps=10)
    info = vf.probe(path)
    jpeg = vf.extract_still(path, 1.0, info, vf.Config())
    assert jpeg[:2] == b"\xff\xd8", "not a JPEG"
    img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    assert img.shape[:2] == (480, 640), "stills must come out at native resolution"


@needs_ffmpeg
def test_extract_still_out_of_range_timestamp_is_empty_not_a_crash(tmp_path):
    path = str(tmp_path / "clip.mp4")
    _make_clip(path, [_sharp_frame() for _ in range(10)], fps=10)
    info = vf.probe(path)
    assert vf.extract_still(path, 999.0, info, vf.Config()) == b""


@needs_ffmpeg
def test_select_end_to_end_with_a_stub_embedder(tmp_path):
    """The whole 'ours' path over a real clip, with the neural stage stubbed:
    proves the decode → scan → shortlist → analyse → dedup wiring holds."""
    path = str(tmp_path / "clip.mp4")
    sharp = _sharp_frame(640, 480)
    _make_clip(path, [sharp] * 60, fps=10)

    calls = {"n": 0}

    def embed(img):
        calls["n"] += 1
        # Every frame shows the same person in the same place → all but one of
        # the accepted stills should be culled as near-dups.
        return {"faces": [{"box": [100, 100, 260, 260], "score": 0.95,
                           "embedding": _emb(42),
                           "quality": {"usable": True, "face_px": 160, "blur": 500.0,
                                       "warnings": []}}],
                "persons": [{"box": [80, 80, 300, 470], "score": 0.9}]}

    cfg = vf.Config(scan_fps=4.0, use_iframe_hint=False, dup_gap_s=100.0)
    result = vf.select(path, cfg, selector="ours", embed=embed)

    assert calls["n"] == result.shortlisted > 0
    assert result.shortlisted <= result.scanned
    assert len(result.accepted) == 1, "an unchanging clip should yield exactly one still"
    assert result.accepted[0].jpeg[:2] == b"\xff\xd8"
    assert sum(1 for c in result.candidates if "near_dup" in c.reasons) >= 1


@needs_ffmpeg
def test_baseline_selectors_need_no_embedder(tmp_path):
    path = str(tmp_path / "clip.mp4")
    _make_clip(path, [_sharp_frame(640, 480) for _ in range(40)], fps=10)
    cfg = vf.Config(scan_fps=4.0, use_iframe_hint=False)
    for selector in ("sharpness_only", "katna_like"):
        result = vf.select(path, cfg, selector=selector, embed=None)
        assert result.accepted, selector
        assert len(result.accepted) <= result.budget
        assert all(c.jpeg[:2] == b"\xff\xd8" for c in result.accepted)


@needs_ffmpeg
def test_unknown_selector_is_rejected(tmp_path):
    path = str(tmp_path / "clip.mp4")
    _make_clip(path, [_sharp_frame() for _ in range(10)], fps=10)
    with pytest.raises(ValueError, match="unknown selector"):
        vf.select(path, vf.Config(scan_fps=2.0, use_iframe_hint=False),
                  selector="nope", embed=lambda img: {})
