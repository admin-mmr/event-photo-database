# Video → best running photos: library research + dev plan

Status: **research complete, plan proposed, nothing implemented.**
Date: 2026-07-26.

Goal: when a volunteer uploads a short clip (reel, 5–60 s, phone or action cam),
automatically extract a handful of **stills that look like deliberate running
photos** — sharp, one or more runners clearly visible, and *different enough from
each other* to be worth keeping as separate photos — then feed them into the
existing face-search pipeline so a runner searching their selfie finds them.

---

## Part 1 — Research: what exists off the shelf

### 1.1 The honest headline

**No maintained library solves this task end to end.** Every generic
"keyframe extraction" tool optimises for a *visual summary of a video* (find the
shot boundaries / the most representative frames of differing content). Our
objective is different and narrower:

> among near-identical frames of the same continuous action, pick the ones a
> photographer would have pressed the shutter for — sharp, well-exposed, subject
> framed, faces usable for recognition — and spread them over *different
> subjects/moments* rather than different *scenes*.

A running clip is typically **one scene**, so scene-change detectors have almost
nothing to fire on. Colour-histogram clustering (Katna's diversity signal) will
also under-perform: consecutive frames of the same runner against the same
background cluster together even when they show completely different runners
entering the frame.

The good news: **this repo already owns the right diversity signal.** The matcher
bundle does SCRFD face detection + ArcFace 512-d embeddings + YOLOv8n person
detection ([matcher/pipeline.py:90](cloud-webapp/matcher/pipeline.py:90)), and
the sharpness/face-quality gate already exists in
[matcher/quality.py](cloud-webapp/matcher/quality.py:1) (`blur_score` =
variance-of-Laplacian, `assess_face` = det score + face px + blur). So the
build is "compose 4 well-understood pieces with our own embeddings", not "train
something".

### 1.2 Candidate libraries evaluated

| Library | What it does | License / health | Verdict for us |
|---|---|---|---|
| **[Katna](https://github.com/keplerlab/katna)** (`pip install katna`) | The closest turnkey match: frame diff in LUV colourspace → brightness + entropy/contrast filter → **K-means on image histograms** → per-cluster best frame by **variance of Laplacian** (blur) | MIT. **Inactive** — last release 0.9.2, ~4 years old; documented memory leaks on py3.6/3.7, slow on >2000 px images, needs ffmpeg | **Use as the reference algorithm, don't take the dependency.** Its pipeline is ~80 lines of OpenCV we can reimplement against our own (face-based) diversity signal, on modern Python, without inheriting a dead dep. |
| **[sharp-frames](https://github.com/Reflct/sharp-frames-python)** (`pip install sharp-frames`) | Extract at N fps then select by sharpness with three strategies: **best-N with `--min-buffer` temporal spacing**, **batched** (sharpest per batch), **outlier removal** (drop frames blurrier than neighbours). Handles HDR→SDR via ffmpeg `zscale`. Emits a JSON of per-frame sharpness scores | Python 3.10+, active (196★), needs ffmpeg/ffprobe, CLI/TUI-first | **Best available prior art, and the closest thing to "just use a library".** `best-n + min-buffer` *is* our stage-A selector. Realistic options: (a) shell out to the CLI, (b) vendor the ~200 lines of selector logic. Its notion of "different enough" is purely *temporal spacing*, not content — that's the gap we fill. |
| **[PySceneDetect](https://github.com/Breakthrough/PySceneDetect)** | Shot/transition detection (`ContentDetector`, `AdaptiveDetector`, `ThresholdDetector`, histogram/hash detectors); `save-images` exports frames per cut | BSD-3-Clause, **very healthy** — v0.7.1 released 2026-07-21, ~1.7k commits | **Optional, low priority.** Genuinely useful only for multi-shot clips (an edited reel with cuts). For a single continuous run it will report one scene. Cheap to add later as a candidate-window generator; not needed for v1. |
| **[video-keyframe-detector](https://github.com/joelibaceta/video-keyframe-detector)** | Peak detection on inter-frame difference | Small, stale | Skip — the peak-of-motion frame is often the *most* motion-blurred one. |
| **[video-to-keyframes](https://github.com/davidj-brewster/video-to-keyframes)** | Motion + contrast/sharpness + SSIM scoring | Small, single-author | Skip as a dep; SSIM-vs-previous-kept-frame is a useful *idea* for near-dup rejection. |
| **[pyiqa / IQA-PyTorch](https://iqa-pytorch.readthedocs.io/)** (NIMA, MUSIQ, TOPIQ, CLIP-IQA, BRISQUE, NIQE) | No-reference *aesthetic/technical* quality scores | Active, research-grade | **Phase 4 option only.** Would give a real "is this photo-worthy" score, but pulls in torch (image size, cold-start, CPU seconds) against our zero-idle-cost policy. `NIQE`/`BRISQUE` are training-free and cheap-ish if we ever want more than Laplacian. |
| **Hosted/commercial** ([BestFrame](https://bestframe.pro/), Imagen, Frame Capture, [Sharp Frames app](https://sharp-frames.reflct.app/)) | AI "sharpest + most aesthetic frame" pickers, native-res export | Closed, per-video pricing, upload required | Rejected: sends attendee footage to a third party (consent/PII problem), no batch API fit, recurring cost. |
| **Decoders** — [PyAV](https://pyav.org/) vs ffmpeg subprocess | PyAV = Cython bindings to libav*, precise PTS-accurate seeking, no process spawn; ffmpeg CLI = simpler, applies rotation metadata automatically, `-ss` fast seek | Both healthy | **Both, deliberately:** ffmpeg CLI for the cheap downscaled scan pass (one process, streams to stdout), PyAV or a second targeted ffmpeg call for exact-timestamp full-res extraction of the shortlist. Frame-accurate output rate matters here — subprocess fps-based decimation is not exact. |

### 1.3 Frame quality: what's actually achievable

- **Resolution is fine, motion blur is the limit.** 1080p = 2.1 MP, 4K = 8.3 MP —
  8 MP is comparable to a phone photo and prints small very well. What makes an
  extracted still look "like a video grab" is (a) motion blur from a video-length
  shutter (typically 1/50–1/60 s at 30 fps, versus 1/1000 s a sports photographer
  would use), (b) 4:2:0 chroma subsampling, (c) inter-frame compression artefacts.
- Practical consequences for us:
  - **Prefer I-frames when the score is close.** I-frames are fully intra-coded and
    visibly cleaner than the B-frames around them; `ffprobe` gives us
    `pict_type` per frame at no extra cost, so use it as a tie-breaker.
  - **Never re-encode twice.** Extract at native resolution, encode once as JPEG
    q≈95 (or PNG for the archival original if storage allows). Do the existing
    `web`/`thumb` derivative encodes from that, exactly as the photo path does
    ([indexer/derivatives.py](cloud-webapp/indexer/derivatives.py:12)).
  - **Sharpness threshold must be absolute, not just relative.** Picking the
    "sharpest of 45 blurry frames" from a shaky 720p clip yields a bad photo.
    Gate on `blur_score` and on face pixel size using the existing
    `assess_face` constants (`MIN_FACE_PX=40`, `BLUR_THRESHOLD=45.0`) before
    accepting anything at all — publishing nothing is a valid outcome for a bad clip.
  - **Volunteer guidance is the highest-leverage "feature":** record at the
    highest resolution available, 60 fps if offered, in bright light. This buys
    more quality than any selection algorithm.
- **iPhone-specific gotchas to handle in Phase 0:** HEVC in `.mov`, HDR (HLG/PQ)
  needing `zscale` tonemapping to SDR or the stills come out washed out/dark, and
  **display-matrix rotation** — the ffmpeg CLI autorotates by default, PyAV does
  not, so a PyAV path must apply rotation manually or portrait clips land sideways.
  Verify both on real footage before choosing the decode path.

### 1.4 Recommended algorithm (compose, don't adopt)

Two-stage cheap→expensive, because the NN stage is the cost driver:

**Stage A — cheap scan, no neural nets.** Decode the whole clip once at reduced
resolution (~480 px wide) via a single ffmpeg process at a fixed stride
(2–4 fps). Per frame compute: `blur_score` (variance of Laplacian), mean
brightness, and frame-difference-vs-previous-kept. Reject frames below absolute
brightness/sharpness floors, then run `sharp-frames`-style **best-N with a
minimum temporal buffer** to shortlist ≈ 3 × the target frame count. Cost:
milliseconds per frame, no model loads.

**Stage B — expensive confirm, on the shortlist only.** Re-decode *just those
timestamps* at native resolution, then for each: run the existing
`embed_image()` bundle → require ≥1 face passing `assess_face` (this is what
makes it a *people* photo rather than a scenery frame) → compute a frame score
combining face-crop sharpness, largest-face px, person-box count and I-frame bonus.

**Diversity = identity, not colour.** Greedily accept frames in score order,
rejecting a candidate when it is "the same photo" as one already accepted:
the same set of face identities (cosine similarity of ArcFace embeddings above
the matcher's own threshold) *and* similar person-box geometry (IoU high) *and*
within a small time gap. A new runner entering frame, or the same runner in a
materially different position, both pass. This is the piece no off-the-shelf
library gives us, and it is the exact thing the user asked for ("different
enough").

**Budget.** Frames per video scales with duration: `K = clamp(round(duration_s / 5), 3, 30)`,
hard-capped per video and per batch.

---

## Part 2 — Dev plan: adding video processing to user uploads

### 2.1 Where this lands in the current system

Today, videos are accepted, stored, and then **invisible to face search**:

- The volunteer upload session allows `video/mp4` and `video/quicktime`
  ([volunteerUpload.ts:299](cloud-webapp/api/src/routes/volunteerUpload.ts:299)); images cap at
  `MAX_IMAGE_UPLOAD_FILE_BYTES` = 1 GiB
  ([shared/src/schemas/upload.ts:41](cloud-webapp/shared/src/schemas/upload.ts:41)) while videos ride the
  absolute ceiling up to ~10 GiB.
- Bytes go browser → GCS staging → Cloud Tasks → `POST /api/internal/process-batch`,
  which copies to Drive (chunked resumable for anything over the 64 MiB inline
  threshold, [volunteerUploadService.ts:337](cloud-webapp/api/src/services/volunteerUploadService.ts:337))
  and then triggers the indexer (`UPLOAD_ASYNC_QUEUE_DESIGN.md`).
- Drive-side, videos get shortcut'd into the per-scope `Videos/` and `Album/`
  folders ([specialFoldersService.ts:73](cloud-webapp/api/src/services/specialFoldersService.ts:73)).
- **The indexer skips them:** its Drive listing only keeps `image/*`
  ([indexer/drive.py:211](cloud-webapp/indexer/drive.py:211)). So a clip is archived but
  un-searchable.

The plan therefore adds one new stage — *video → candidate JPEGs in Drive* —
and changes nothing downstream.

### 2.2 Key design decision: write frames back to Drive as normal photos

Extracted frames are written into the event's `Photos_NNN` Drive folder as
ordinary JPEGs (`<videoBaseName>_f01.jpg`, …), so the **existing** indexer
picks them up on its next scan and everything downstream works unmodified:
face/person embedding, gallery, capture-time sort, signed-URL originals, ZIP
download, duplicates/trash, Sheet logging.

Why not keep frames only in the derivatives bucket with a `sourceVideoId`
pointer? Because gallery, download, dedup, and trash all assume a Drive-backed
photo, so that route means touching every one of them. Writing to Drive also
respects the project's "Drive/Sheet stays the source of truth" rule and gives
admins a familiar way to delete a bad frame.

Trade-offs accepted: extra Drive storage (~1–3 MB × K per clip) and Drive write
quota. Provenance is preserved in Firestore + `Upload_Log` (see D3) so frames
remain distinguishable from real photographs.

### 2.3 Phases

**Phase 0 — offline spike + eval harness (no cloud, no wiring).** *The gate for everything else.*
1. Collect ~10 real clips spanning the hard cases: phone portrait HEVC/HDR, 4K
   60 fps action cam, shaky low-light, a multi-cut edited reel, a clip with many
   runners, a clip with none.
2. Standalone script under `cloud-webapp/matcher/eval/` (matches the existing
   eval-loop convention) implementing §1.4, with every threshold a CLI flag.
3. Also run **Katna** and **sharp-frames** on the same clips as baselines — this
   is the empirical check on §1.1's claim that neither is sufficient alone. If
   `sharp-frames` output is judged good enough on its own, adopt it and delete
   most of stage B; that outcome is a win, not a failure.
4. Judge output the way the face-matching work is judged: eyeball a contact
   sheet, score each frame keep/reject, and record **precision of accepted
   frames** ("would a volunteer have published this?") plus **near-dup rate**.
   Evidence bar: ≥80 % of accepted frames judged keepable, ≤10 % near-dups,
   ≥1 usable frame from every clip that contains a clearly visible runner.
5. Resolve the decode questions concretely: HEVC/HDR tonemapping, rotation
   metadata, PyAV vs ffmpeg CLI, and measure vCPU-seconds per clip-second.
**Deliverables:** chosen thresholds, chosen decode path, measured cost per
minute of video, contact sheets. **Do not proceed if the evidence bar fails** —
report and re-tune instead.

**Phase 1 — `extractor` module, pure and unit-tested.**
- New `cloud-webapp/indexer/video_frames.py`:
  `select_frames(local_path, budget, cfg) -> [FrameCandidate{ts_ms, jpeg_bytes, score, faces, reasons}]`,
  with the model bundle and the decoder injected (same collaborator-injection
  style as `job.run()`, so it is testable without ffmpeg or ONNX).
- Reuse `quality.blur_score` / `quality.assess_face` and `pipeline.embed_image`;
  do **not** duplicate thresholds — import them.
- `test_video_frames.py` with a tiny synthetic clip generated at test time
  (sharp/blurry/black frames) — deterministic, no fixtures over a few hundred KB.
- Add `av` (or nothing, if the ffmpeg-CLI path wins Phase 0) to
  `indexer/requirements.txt`; add `ffmpeg` via apt in the indexer Dockerfile.
  **Rely on the glob `COPY indexer/*.py`** — per CLAUDE.md, a hand-kept COPY list
  is how `capture_time.py` shipped missing; also check `.gcloudignore` /
  `cloud-webapp/.dockerignore` don't exclude the new module.

**Phase 2 — Cloud Run Job mode + trigger.**
- Add a `MODE=video` path to the existing `photo-indexer` job rather than a new
  service: the image already carries the matcher pipeline, ONNX runtime and
  OpenCV, and Jobs bill only while running (zero idle cost, no min-instances).
  Env overrides: `VIDEO_FILE_IDS` (Drive ids), `FRAME_BUDGET`, `EXTRACTOR_VERSION`.
- Per video: download from Drive to the job's local disk (streamed, never fully
  in memory — clips reach 10 GiB), run `select_frames`, upload accepted JPEGs to
  the event's `Photos_NNN` folder with `photographerName` and consent metadata
  copied from the source video's upload record, then delete the temp file.
- **Idempotency:** a `videoFrames/{driveFileId}` Firestore doc records
  `{extractorVersion, chosenTsMs[], frameFileIds[], status, updatedAt}`. A
  re-run with the same extractor version is a no-op; a bumped version re-extracts
  and supersedes (old frames trashed, not hard-deleted). Neither existing dedup
  layer covers this: the indexer's md5 dedup and the (eventId, content-hash)
  claim in `uploadDedupService.ts` both collapse only *byte-identical* copies, so
  a re-encode at the same timestamp would slip through and duplicate every frame.
  Frames should still be written through the same content-hash claim as volunteer
  uploads, so a concurrent re-extract can't race itself.
- Trigger from the upload worker after the video lands in Drive, via the existing
  Jobs-API-with-overrides call (`api-runtime@` already holds `roles/run.developer`
  for `run.jobs.runWithOverrides`). If per-clip triggers prove too chatty, switch
  to the **queue + scheduled drain** pattern already proven by
  `folderRebuildBatches` / `findme-folder-rebuild` — a `videoExtractBatches`
  collection plus a ~2 min drain that is a single-query no-op when idle. Note
  that pattern needs its composite index added to `infra/firestore.indexes.json`
  (the drain 500'd every tick when that was missed for folder rebuilds).
- Then trigger the normal index scan so the new frames get embedded.

**Phase 3 — provenance, UI, and admin review.**
- Manifest/Firestore: `fromVideo: {driveFileId, tsMs, extractorVersion}` on
  frame-derived photos.
- Gallery: a small "from video" badge, and the clip's timestamp offset in the
  lightbox detail. No change to search ranking — a frame is just a photo.
- Admin: list frames per source video with approve/reject; reject trashes the
  Drive file (existing duplicates/trash flow) and records the rejection on the
  `videoFrames` doc so a re-extract doesn't resurrect it.
- Volunteer upload: after a video is accepted, show "we'll pull the best stills
  from this clip" so the extra photos aren't a surprise.
- `Upload_Log` row for the extraction, per the audit convention.

**Phase 4 — cost guardrails and tuning.**
- Per-event and per-batch frame caps; a max processed duration per clip (sample
  across the whole clip rather than truncating).
- Log accepted/rejected counts and vCPU-seconds per clip; watch against the Jobs
  free tier (240k vCPU-s / 450k GiB-s per month in us-central1). Raise
  CPU/`INDEX_CONCURRENCY` freely, but **do not raise memory** without a matching
  runtime drop — memory is the binding free-tier constraint.
- Only if quality complaints persist: evaluate a cheap NR-IQA score (`NIQE`/
  `BRISQUE` via pyiqa) as an extra term, measured against the Phase-0 judgments.

### 2.4 Cost sanity check (why stage A exists)

Calibrating from CLAUDE.md's measured indexer run (~1,134 photos ≈ 9,600 vCPU-s
at `--cpu=8`, concurrency 8) gives roughly **8.5 vCPU-s per full embed**.

- Naïve "embed every sampled frame": a 15 s clip at 3 fps = 45 frames ≈ **380 vCPU-s
  per clip** — ~630 clips would exhaust the monthly free tier, and a single event's
  clips could cost more than all its photos.
- Two-stage: stage A is pure OpenCV on downscaled frames (well under 1 vCPU-s
  total for the clip), stage B embeds only ≈ 3 × K ≈ 12 frames ≈ **100 vCPU-s
  per clip** — a ~4× saving that scales with clip length.

Phase 0 must replace these estimates with measurements before Phase 2 ships.

### 2.5 Risks

| Risk | Mitigation |
|---|---|
| Frames look like video grabs next to real photos | Absolute sharpness/face-size gates; I-frame preference; publish nothing rather than something bad; admin reject flow |
| Gallery flooded with near-identical frames | Identity+geometry+time dedup (§1.4); conservative per-clip budget `K` |
| Face recognition quality drops on soft frames | The frame must already pass `assess_face`; monitor via the existing judged eval sets before/after |
| Cost blowout on long clips | Per-clip duration cap and frame budget; two-stage design; free-tier monitoring |
| Consent/attribution lost in the video→photo hop | Copy `photographerName` + consent policy version from the source upload; `fromVideo` provenance; `Upload_Log` row |
| Re-runs duplicating frames | `videoFrames/{driveFileId}` doc keyed on extractor version |
| 10 GiB clips OOM the job | Stream Drive→local disk, never buffer whole clips in memory |

---

## Sources

- [Katna (GitHub)](https://github.com/keplerlab/katna) · [Katna docs](https://katna.readthedocs.io/) · [Katna on PyPI](https://pypi.org/project/katna/) · [Snyk health](https://snyk.io/advisor/python/katna) · [Tattle's analysis](https://tattle.co.in/blog/2020-05-25-analysing-the-katna-library-for-video-key-frame-extraction/)
- [sharp-frames (GitHub)](https://github.com/Reflct/sharp-frames-python) · [sharp-frames on PyPI](https://pypi.org/project/sharp-frames/) · [Reflct Sharp Frame Selector write-up](https://radiancefields.com/reflct-sharp-frame-selector)
- [PySceneDetect (GitHub)](https://github.com/Breakthrough/PySceneDetect)
- [video-keyframe-detector](https://github.com/joelibaceta/video-keyframe-detector) · [video-to-keyframes](https://github.com/davidj-brewster/video-to-keyframes)
- [IQA-PyTorch / pyiqa docs](https://iqa-pytorch.readthedocs.io/)
- [FFmpeg thumbnail filter](https://ayosec.github.io/ffmpeg-filters-docs/8.0/Filters/Video/thumbnail.html) · [Mux: extract thumbnails with FFmpeg](https://www.mux.com/articles/extract-thumbnails-from-a-video-with-ffmpeg) · [I-frame / scene selection](https://www.bogotobogo.com/FFMpeg/ffmpeg_thumbnails_select_scene_iframe.php)
- [PyAV cookbook](https://pyav.org/docs/develop/cookbook/basics.html) · [PyAV for video processing](https://jdhao.github.io/2021/11/04/pyav-video-processing/)
- [Extracting stills from 4K video (Digital Camera World)](https://www.digitalcameraworld.com/tutorials/capture-a-precise-moment-in-time-by-extracting-stills-from-4k-video) · [gary luhm photography](https://garyluhm.net/extracting-stills-from-4k/) · [Mozaik UW](https://www.housingcamera.com/blog/underwater-photography/how-to-extract-perfect-still-photos-from-4k-video)
- [BestFrame](https://bestframe.pro/) · [Sharp Frames app](https://sharp-frames.reflct.app/) (commercial, evaluated and rejected)
