#!/usr/bin/env python3
"""
video_frames.py — Phase 0 spike for VIDEO_FRAME_EXTRACTION_DEV_PLAN.md §1.4:
pick, from a short clip, the handful of stills that look like deliberate
running photos.

This is the *spike* implementation. It lives under `eval/` on purpose — Phase 0
is a measurement exercise, and only a selector that clears the evidence bar
(§2.3 Phase 0) gets promoted to `indexer/video_frames.py` in Phase 1. Nothing
here is wired into the pipeline.

Three selectors are implemented so the plan's central claim — "no off-the-shelf
library solves this" — is tested rather than asserted:

  ours            two-stage: cheap OpenCV scan → shortlist → face/person embed
                  → identity+geometry diversity (§1.4)
  sharpness_only  stage A alone: best-N by variance-of-Laplacian with a minimum
                  temporal buffer. This is `sharp-frames`' `best-n --min-buffer`
                  strategy reimplemented (its notion of "different enough" is
                  purely temporal), so it is the honest no-neural-net baseline.
  katna_like      Katna's published pipeline reimplemented in numpy: brightness
                  + entropy filter → k-means on colour histograms → per-cluster
                  sharpest frame. Reimplemented rather than depended on: Katna's
                  last release is ~4 years old (see plan §1.2).

Decode is the ffmpeg CLI, deliberately (plan §1.2): it applies display-matrix
rotation automatically, which PyAV does not, and one process streams the whole
downscaled scan pass. Stage B re-seeks each shortlisted timestamp at native
resolution so no still is ever downscaled-then-upscaled.

Pure/injectable by design: `select()` takes its decoder and its embedder as
collaborators, so the selection logic is unit-testable without ffmpeg or ONNX
(same style as `job.run()` in the indexer).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from quality import BLUR_THRESHOLD, MIN_DET_SCORE, MIN_FACE_PX, blur_score  # noqa: E402

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")

# HDR transfer functions that need tonemapping to SDR or the stills come out
# washed out / dark (plan §1.3, iPhone gotchas).
HDR_TRANSFERS = {"smpte2084", "arib-std-b67"}
_TONEMAP = (
    "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
    "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
)


# ── Config ────────────────────────────────────────────────────────────────────


@dataclass
class Config:
    """Every threshold the plan asks to be a CLI flag.

    Defaults are starting points for Phase 0, NOT tuned values — the whole
    point of the phase is to replace them with measured ones.
    """

    # Stage A — cheap scan
    scan_fps: float = 3.0
    scan_width: int = 480
    min_brightness: float = 32.0          # mean gray; below this = too dark
    max_brightness: float = 240.0         # above this = blown out
    scan_min_blur: float = 12.0           # absolute floor on the 480px frame
    scan_blur_pct: float = 40.0           # …plus: drop the blurriest N% of the clip
    min_buffer_s: float = 0.6             # temporal spacing of the shortlist
    shortlist_mult: float = 3.0           # shortlist ≈ mult × budget

    # Budget: K = clamp(round(duration / seconds_per_frame), min, max)
    seconds_per_frame: float = 5.0
    min_budget: int = 3
    max_budget: int = 30
    max_scanned_duration_s: float = 0.0   # 0 = whole clip (Phase 4 guardrail)

    # Stage B — absolute quality gates. Defaults are IMPORTED from the
    # reference-selfie path so "publishable" starts out meaning the same thing it
    # does for a searcher's query photo — but they are re-applied here from the
    # raw measurements rather than read off `assess_face`'s verdict, because
    # `assess_face` bakes in MIN_FACE_PX=40 and a Phase 0 sweep has to be able to
    # move the threshold DOWN as well as up. Whether a query-quality floor is the
    # right publish floor is precisely the open question.
    min_face_px: int = MIN_FACE_PX
    min_face_blur: float = BLUR_THRESHOLD
    min_det_score: float = MIN_DET_SCORE
    require_face: bool = True             # a scenery frame is not a running photo

    # Stage B — score weights (normalised within the candidate set)
    w_face_blur: float = 0.45
    w_face_px: float = 0.30
    w_persons: float = 0.15
    w_frame_blur: float = 0.10
    iframe_bonus: float = 0.05
    persons_saturate: int = 3

    # Diversity — "same photo" test (plan §1.4: identity, not colour)
    identity_cos: float = 0.50            # ArcFace cosine: same person
    geom_iou: float = 0.50                # person-box IoU: same composition
    dup_gap_s: float = 2.0                # …and close in time

    # Output
    jpeg_quality: int = 2                 # ffmpeg -q:v (2 ≈ JPEG q95)
    tonemap_hdr: bool = True
    use_iframe_hint: bool = True


# ── Probe ─────────────────────────────────────────────────────────────────────


@dataclass
class VideoInfo:
    duration_s: float
    width: int                 # coded width
    height: int
    display_width: int         # after display-matrix rotation
    display_height: int
    fps: float
    rotation: int
    codec: str
    transfer: str
    is_hdr: bool

    @property
    def aspect(self) -> float:
        return self.display_width / max(1, self.display_height)


def _run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, **kw)


def have_ffmpeg() -> bool:
    return shutil.which(FFMPEG) is not None and shutil.which(FFPROBE) is not None


def probe(path: str) -> VideoInfo:
    proc = _run([FFPROBE, "-v", "error", "-print_format", "json",
                 "-show_format", "-show_streams", path], text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed on {path}: {proc.stderr.strip()}")
    data = json.loads(proc.stdout)
    vs = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    if vs is None:
        raise RuntimeError(f"no video stream in {path}")

    w, h = int(vs.get("width") or 0), int(vs.get("height") or 0)

    rotation = 0
    for sd in vs.get("side_data_list", []) or []:
        if "rotation" in sd:
            rotation = int(round(float(sd["rotation"]))) % 360
    if not rotation:
        tag_rot = (vs.get("tags") or {}).get("rotate")
        if tag_rot:
            rotation = int(round(float(tag_rot))) % 360

    dw, dh = (h, w) if rotation in (90, 270) else (w, h)

    fps = 0.0
    for key in ("avg_frame_rate", "r_frame_rate"):
        raw = vs.get(key) or "0/0"
        try:
            num, den = (float(x) for x in raw.split("/"))
            if den:
                fps = num / den
                break
        except ValueError:
            continue

    dur = float(vs.get("duration") or (data.get("format") or {}).get("duration") or 0.0)
    transfer = vs.get("color_transfer") or ""

    return VideoInfo(
        duration_s=dur, width=w, height=h, display_width=dw, display_height=dh,
        fps=fps, rotation=rotation, codec=vs.get("codec_name") or "",
        transfer=transfer, is_hdr=transfer in HDR_TRANSFERS,
    )


def iframe_times(path: str, limit: int = 20000) -> list[float]:
    """Presentation times of intra-coded frames.

    I-frames are visibly cleaner than the B-frames around them (plan §1.3), and
    ffprobe hands us `pict_type` for free, so it is worth having as a
    tie-breaker. Returns [] if ffprobe can't supply it — never fatal.
    """
    proc = _run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_frames",
                 "-show_entries", "frame=pts_time,pict_type", "-of", "csv=p=0", path],
                text=True)
    if proc.returncode != 0:
        return []
    out = []
    for line in proc.stdout.splitlines()[:limit]:
        parts = line.strip().split(",")
        if len(parts) < 2:
            continue
        ts, kind = parts[0], parts[-1]
        if kind == "I":
            try:
                out.append(float(ts))
            except ValueError:
                continue
    return out


# ── Stage A — cheap scan, no neural nets ──────────────────────────────────────


@dataclass
class ScanMetric:
    ts: float
    blur: float          # variance of Laplacian on the downscaled gray frame
    brightness: float    # mean gray
    diff: float          # mean abs diff vs the previous scanned frame
    hist: np.ndarray | None = None   # only populated for katna_like
    rejected: str = ""


def _scan_dims(info: VideoInfo, cfg: Config) -> tuple[int, int]:
    """Explicit even output dims so the raw byte stream can be reshaped.

    Deriving them here rather than letting ffmpeg pick (scale=W:-2) is what
    makes the rawvideo reshape safe — we must know the frame size exactly.
    """
    out_w = min(cfg.scan_width, info.display_width or cfg.scan_width) or cfg.scan_width
    out_w -= out_w % 2
    aspect = info.aspect if info.display_height else 16 / 9
    out_h = int(round(out_w / max(aspect, 1e-6)))
    out_h -= out_h % 2
    return max(out_w, 2), max(out_h, 2)


def _scan_filters(info: VideoInfo, cfg: Config, out_w: int, out_h: int,
                  tonemap: bool) -> str:
    parts = []
    if tonemap:
        parts.append(_TONEMAP)
    parts.append(f"fps={cfg.scan_fps}")
    parts.append(f"scale={out_w}:{out_h}:flags=area")
    return ",".join(parts)


def scan(path: str, info: VideoInfo, cfg: Config, want_hist: bool = False) -> list[ScanMetric]:
    """Decode the clip ONCE, downscaled, and measure every sampled frame.

    Cost is milliseconds per frame with no model loads — this is the reason the
    expensive stage only ever sees ~3×K frames (plan §2.4).
    """
    import cv2

    out_w, out_h = _scan_dims(info, cfg)
    frame_bytes = out_w * out_h * 3
    tonemap = cfg.tonemap_hdr and info.is_hdr

    def _cmd(tm: bool) -> list[str]:
        cmd = [FFMPEG, "-v", "error", "-i", path]
        if cfg.max_scanned_duration_s > 0:
            cmd += ["-t", str(cfg.max_scanned_duration_s)]
        return cmd + ["-vf", _scan_filters(info, cfg, out_w, out_h, tm),
                      "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]

    metrics: list[ScanMetric] = []
    for attempt_tonemap in ([True, False] if tonemap else [False]):
        metrics = []
        proc = subprocess.Popen(_cmd(attempt_tonemap), stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE)
        prev_gray = None
        idx = 0
        assert proc.stdout is not None
        while True:
            buf = proc.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break
            frame = np.frombuffer(buf, dtype=np.uint8).reshape(out_h, out_w, 3)
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            diff = 0.0 if prev_gray is None else float(
                np.mean(cv2.absdiff(gray, prev_gray)))
            hist = None
            if want_hist:
                hist = cv2.calcHist([frame], [0, 1, 2], None, [8, 8, 8],
                                    [0, 256] * 3).flatten()
                hist = hist / max(float(hist.sum()), 1.0)
            metrics.append(ScanMetric(
                ts=idx / cfg.scan_fps,
                blur=float(cv2.Laplacian(gray, cv2.CV_64F).var()),
                brightness=float(gray.mean()),
                diff=diff,
                hist=hist,
            ))
            prev_gray = gray
            idx += 1
        proc.stdout.close()
        err = (proc.stderr.read() or b"").decode(errors="replace") if proc.stderr else ""
        proc.wait()
        if metrics:
            return metrics
        # HDR tonemap needs libzimg; fall back to a plain decode rather than
        # failing the clip outright.
        if attempt_tonemap:
            print(f"  tonemap decode produced no frames, retrying without it"
                  f"{': ' + err.strip().splitlines()[-1] if err.strip() else ''}",
                  file=sys.stderr)
            continue
        raise RuntimeError(f"ffmpeg decoded no frames from {path}: {err.strip()[:400]}")
    return metrics


def budget_for(duration_s: float, cfg: Config) -> int:
    """K = clamp(round(duration / seconds_per_frame), min, max) — plan §1.4."""
    k = int(round(duration_s / max(cfg.seconds_per_frame, 1e-6)))
    return max(cfg.min_budget, min(cfg.max_budget, k))


def gate_scan(metrics: list[ScanMetric], cfg: Config) -> list[ScanMetric]:
    """Absolute brightness/sharpness floors, then a relative sharpness floor.

    The absolute floor matters because the sharpest of 45 blurry frames is
    still a bad photo (plan §1.3); the percentile floor is what adapts to a
    clip that is uniformly soft.
    """
    for m in metrics:
        if m.brightness < cfg.min_brightness:
            m.rejected = "too_dark"
        elif m.brightness > cfg.max_brightness:
            m.rejected = "blown_out"
        elif m.blur < cfg.scan_min_blur:
            m.rejected = "scan_too_blurry"
    survivors = [m for m in metrics if not m.rejected]
    if survivors and 0 < cfg.scan_blur_pct < 100:
        floor = float(np.percentile([m.blur for m in survivors], cfg.scan_blur_pct))
        for m in survivors:
            if m.blur < floor:
                m.rejected = "below_clip_blur_pct"
    return [m for m in metrics if not m.rejected]


def best_n_spaced(metrics: list[ScanMetric], n: int, min_buffer_s: float) -> list[ScanMetric]:
    """`sharp-frames`' best-n + --min-buffer selector: greedily take the
    sharpest frame that is at least `min_buffer_s` from everything taken."""
    chosen: list[ScanMetric] = []
    for m in sorted(metrics, key=lambda x: -x.blur):
        if len(chosen) >= n:
            break
        if all(abs(m.ts - c.ts) >= min_buffer_s for c in chosen):
            chosen.append(m)
    return sorted(chosen, key=lambda x: x.ts)


def katna_like_select(metrics: list[ScanMetric], n: int, seed: int = 0) -> list[ScanMetric]:
    """Katna's pipeline: k-means on colour histograms, sharpest per cluster.

    Reimplemented in numpy (Lloyd's, deterministic seed) rather than taking the
    dead dependency. Expected to under-perform on a single-scene running clip —
    consecutive frames of the same runner cluster together (plan §1.1). Falls
    back to sharpness ranking when histograms are unavailable.
    """
    usable = [m for m in metrics if m.hist is not None]
    if not usable:
        return sorted(sorted(metrics, key=lambda x: -x.blur)[:n], key=lambda x: x.ts)
    X = np.stack([m.hist for m in usable]).astype(np.float64)
    k = max(1, min(n, len(usable)))
    rng = np.random.default_rng(seed)
    centers = X[rng.choice(len(X), size=k, replace=False)]
    labels = np.zeros(len(X), dtype=int)
    for _ in range(25):
        d = ((X[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
        new_labels = d.argmin(axis=1)
        if np.array_equal(new_labels, labels) and _ > 0:
            break
        labels = new_labels
        for ci in range(k):
            members = X[labels == ci]
            if len(members):
                centers[ci] = members.mean(axis=0)
    chosen = []
    for ci in range(k):
        members = [m for m, lab in zip(usable, labels) if lab == ci]
        if members:
            chosen.append(max(members, key=lambda m: m.blur))
    return sorted(chosen, key=lambda x: x.ts)


# ── Stage B — expensive confirm, on the shortlist only ────────────────────────


@dataclass
class FrameCandidate:
    ts: float
    jpeg: bytes = b""
    width: int = 0
    height: int = 0
    frame_blur: float = 0.0
    is_iframe: bool = False
    faces: list[dict] = field(default_factory=list)      # publishable faces only
    detections: list[dict] = field(default_factory=list)  # EVERY detection + verdict
    persons: list[dict] = field(default_factory=list)
    score: float = 0.0
    scan_blur: float = 0.0
    reasons: list[str] = field(default_factory=list)     # why it was rejected
    dup_of: float | None = None

    @property
    def accepted(self) -> bool:
        return not self.reasons

    @property
    def best_face_px(self) -> int:
        return max((f["face_px"] for f in self.faces), default=0)

    @property
    def best_face_blur(self) -> float:
        return max((f["blur"] for f in self.faces), default=0.0)

    @property
    def near_miss(self) -> dict | None:
        """The biggest face the gates threw away.

        Without this a `no_publishable_face` rejection is unexplainable, and the
        gate can't be tuned from the report — which is the whole job of Phase 0.
        """
        dropped = [d for d in self.detections if d.get("dropped")]
        return max(dropped, key=lambda d: d["face_px"]) if dropped else None


def extract_still(path: str, ts: float, info: VideoInfo, cfg: Config) -> bytes:
    """One native-resolution JPEG at `ts`, encoded exactly once (plan §1.3).

    `-ss` precedes `-i` so ffmpeg fast-seeks and then decodes to the exact
    timestamp; rotation is applied automatically by the CLI.
    """
    vf = _TONEMAP if (cfg.tonemap_hdr and info.is_hdr) else None
    base = [FFMPEG, "-v", "error", "-ss", f"{ts:.3f}", "-i", path, "-frames:v", "1"]
    for filters in ([vf] if vf else []) + [None]:
        cmd = list(base)
        if filters:
            cmd += ["-vf", filters]
        cmd += ["-q:v", str(cfg.jpeg_quality), "-f", "image2pipe", "-vcodec", "mjpeg", "-"]
        proc = _run(cmd)
        if proc.returncode == 0 and proc.stdout:
            return proc.stdout
    return b""


def _iou(a: list[float], b: list[float]) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _cos(a, b) -> float:
    a = np.asarray(a, dtype=np.float64).ravel()
    b = np.asarray(b, dtype=np.float64).ravel()
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na < 1e-9 or nb < 1e-9:
        return 0.0
    return float(a @ b / (na * nb))


def analyse_candidate(ts: float, jpeg: bytes, cfg: Config, embed, is_iframe: bool = False,
                      scan_blur: float = 0.0) -> FrameCandidate:
    """Embed one still and apply the absolute publish gates.

    `embed` is injected (`pipeline.embed_image` in production, a stub in tests).
    """
    from pipeline import decode_image

    cand = FrameCandidate(ts=ts, jpeg=jpeg, is_iframe=is_iframe, scan_blur=scan_blur)
    if not jpeg:
        cand.reasons.append("extract_failed")
        return cand

    img = decode_image(jpeg)
    cand.height, cand.width = img.shape[:2]
    cand.frame_blur = blur_score(img)

    result = embed(img)
    for f in result.get("faces", []):
        q = f.get("quality") or {}
        face_px = int(q.get("face_px") or 0)
        blur = float(q.get("blur") or 0.0)
        det_score = float(f.get("score") or 0.0)
        rec = {
            "box": list(f["box"]), "det_score": det_score,
            "face_px": face_px, "blur": blur, "embedding": f.get("embedding"),
            "warnings": q.get("warnings") or [], "dropped": "",
        }
        # Gates are applied from the raw numbers, NOT from q["usable"]: that flag
        # already encodes MIN_FACE_PX=40, so honouring it would make
        # `min_face_px` a one-way ratchet that can only tighten. Any OTHER reason
        # assess_face refused the face (e.g. low_confidence) is still respected.
        other = [r for r in (q.get("reasons") or []) if r not in ("too_small", "too_blurry")]
        if other:
            rec["dropped"] = "assess_face:" + ",".join(other)
        elif det_score < cfg.min_det_score:
            rec["dropped"] = "low_confidence"
        elif face_px < cfg.min_face_px:
            rec["dropped"] = "face_too_small"
        elif blur < cfg.min_face_blur:
            rec["dropped"] = "face_too_soft"
        cand.detections.append(rec)
        if not rec["dropped"]:
            cand.faces.append(rec)
    cand.persons = [{"box": list(p["box"]), "score": float(p.get("score") or 0.0)}
                    for p in result.get("persons", [])]

    if cfg.require_face and not cand.faces:
        cand.reasons.append("no_publishable_face")
    return cand


def _norm(values: list[float]) -> list[float]:
    if not values:
        return []
    lo, hi = min(values), max(values)
    if hi - lo < 1e-9:
        return [1.0] * len(values)
    return [(v - lo) / (hi - lo) for v in values]


def score_candidates(cands: list[FrameCandidate], cfg: Config) -> None:
    """Score in place. Normalised WITHIN the clip: the question is which frame
    of this clip is best, and the absolute "is it good enough at all" question
    is already answered by the gates in `analyse_candidate`."""
    live = [c for c in cands if c.accepted]
    if not live:
        return
    n_face_blur = _norm([c.best_face_blur for c in live])
    n_face_px = _norm([float(c.best_face_px) for c in live])
    n_frame_blur = _norm([c.frame_blur for c in live])
    for c, fb, fp, gb in zip(live, n_face_blur, n_face_px, n_frame_blur):
        persons = min(len(c.persons), cfg.persons_saturate) / max(cfg.persons_saturate, 1)
        c.score = (cfg.w_face_blur * fb + cfg.w_face_px * fp
                   + cfg.w_persons * persons + cfg.w_frame_blur * gb
                   + (cfg.iframe_bonus if c.is_iframe else 0.0))


def same_photo(a: FrameCandidate, b: FrameCandidate, cfg: Config) -> bool:
    """"Is this the same photo I already kept?" — identity, then geometry, then time.

    All three must hold. A new runner entering frame changes the identity set;
    the same runner in a materially different position changes the geometry.
    That is the "different enough" test the plan says no library gives us.
    """
    if abs(a.ts - b.ts) >= cfg.dup_gap_s:
        return False
    if not a.faces or not b.faces:
        return False
    if len(a.faces) != len(b.faces):
        return False   # somebody entered or left the frame
    embs_b = [f["embedding"] for f in b.faces if f.get("embedding") is not None]
    if len(embs_b) != len(b.faces):
        return False   # no embeddings to compare — treat as different, keep both
    for f in a.faces:
        if f.get("embedding") is None:
            return False
        if max((_cos(f["embedding"], e) for e in embs_b), default=0.0) < cfg.identity_cos:
            return False   # a face here matches nobody there = different people
    boxes_a = [p["box"] for p in a.persons] or [f["box"] for f in a.faces]
    boxes_b = [p["box"] for p in b.persons] or [f["box"] for f in b.faces]
    ious = [max((_iou(ba, bb) for bb in boxes_b), default=0.0) for ba in boxes_a]
    if not ious:
        return False
    return float(np.mean(ious)) >= cfg.geom_iou


def select_diverse(cands: list[FrameCandidate], budget: int, cfg: Config) -> list[FrameCandidate]:
    """Greedy accept in score order, rejecting near-duplicates. Mutates
    `reasons`/`dup_of` on the losers so the report can explain every drop."""
    accepted: list[FrameCandidate] = []
    for c in sorted([c for c in cands if c.accepted], key=lambda x: -x.score):
        if len(accepted) >= budget:
            c.reasons.append("over_budget")
            continue
        dup = next((a for a in accepted if same_photo(c, a, cfg)), None)
        if dup is not None:
            c.reasons.append("near_dup")
            c.dup_of = dup.ts
            continue
        accepted.append(c)
    return sorted(accepted, key=lambda x: x.ts)


# ── Orchestration ─────────────────────────────────────────────────────────────


@dataclass
class SelectionResult:
    selector: str
    info: VideoInfo
    budget: int
    scanned: int
    gated: int
    shortlisted: int
    candidates: list[FrameCandidate]
    accepted: list[FrameCandidate]
    scan_metrics: list[ScanMetric] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def select(path: str, cfg: Config, selector: str = "ours", embed=None,
           info: VideoInfo | None = None,
           scan_fn=None) -> SelectionResult:
    """Run one selector over one clip.

    `embed` defaults to the real `pipeline.embed_image` bundle, loaded lazily so
    the cheap selectors and the unit tests never touch onnxruntime.
    """
    info = info or probe(path)
    scan_fn = scan_fn or scan
    cfg_used = cfg
    budget = budget_for(
        min(info.duration_s, cfg.max_scanned_duration_s) if cfg.max_scanned_duration_s > 0
        else info.duration_s, cfg)
    notes: list[str] = []
    if info.is_hdr:
        notes.append(f"hdr:{info.transfer}")
    if info.rotation:
        notes.append(f"rotation:{info.rotation}")

    metrics = scan_fn(path, info, cfg_used, selector == "katna_like")
    gated = gate_scan(metrics, cfg_used)

    if selector == "katna_like":
        shortlist = katna_like_select(gated, budget)
    elif selector == "sharpness_only":
        shortlist = best_n_spaced(gated, budget, cfg_used.min_buffer_s)
    elif selector == "ours":
        shortlist = best_n_spaced(gated, int(round(budget * cfg_used.shortlist_mult)),
                                  cfg_used.min_buffer_s)
    else:
        raise ValueError(f"unknown selector: {selector}")

    iframes: list[float] = []
    if cfg_used.use_iframe_hint:
        iframes = iframe_times(path)

    def _is_iframe(ts: float) -> bool:
        return any(abs(ts - t) <= 0.5 / max(info.fps or 30.0, 1.0) for t in iframes)

    if selector == "ours":
        if embed is None:
            from models import load_bundle
            from pipeline import embed_image
            bundle = load_bundle()
            embed = lambda img: embed_image(img, bundle)  # noqa: E731
        cands = [
            analyse_candidate(m.ts, extract_still(path, m.ts, info, cfg_used), cfg_used,
                              embed, is_iframe=_is_iframe(m.ts), scan_blur=m.blur)
            for m in shortlist
        ]
        score_candidates(cands, cfg_used)
        accepted = select_diverse(cands, budget, cfg_used)
    else:
        # Baselines publish their shortlist as-is: that IS their answer. No face
        # gate, no diversity test — which is exactly what we are measuring.
        cands = []
        for m in shortlist:
            c = FrameCandidate(ts=m.ts, jpeg=extract_still(path, m.ts, info, cfg_used),
                               is_iframe=_is_iframe(m.ts), scan_blur=m.blur,
                               score=m.blur)
            if not c.jpeg:
                c.reasons.append("extract_failed")
            cands.append(c)
        accepted = [c for c in cands if c.accepted][:budget]

    return SelectionResult(
        selector=selector, info=info, budget=budget, scanned=len(metrics),
        gated=len(gated), shortlisted=len(shortlist), candidates=cands,
        accepted=accepted, scan_metrics=metrics, notes=notes,
    )
