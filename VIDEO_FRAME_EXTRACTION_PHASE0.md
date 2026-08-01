# Phase 0 — video → running stills: harness, and what the first run measured

Status: **harness built and run on 10 real clips. Human judging not done yet, so
the evidence bar is NOT yet decided.** Everything below is measured, not estimated.
Date: 2026-07-29. Companion to `VIDEO_FRAME_EXTRACTION_DEV_PLAN.md` (§2.3 Phase 0).

Phase 0 exists to answer one question before any of this is wired into the
pipeline: **are the extracted stills good enough and distinct enough that a
runner would download them as photographs?** The harness makes that answerable;
the numbers here say where the answer currently sits.

---

## 1. What was built

| Path | What it is |
|---|---|
| [matcher/eval/video_frames.py](cloud-webapp/matcher/eval/video_frames.py) | The selector. Three arms (below), every threshold in one `Config`, decoder + embedder injected so selection logic tests without ffmpeg or ONNX. |
| [matcher/eval/run_video_spike.py](cloud-webapp/matcher/eval/run_video_spike.py) | Runs every arm over a folder of clips; writes stills, `report.json`, per-clip CPU cost, and a **face-gate sensitivity** readout. Every `Config` field is a CLI flag. |
| [matcher/eval/make_frame_review_page.py](cloud-webapp/matcher/eval/make_frame_review_page.py) | Contact sheet. Arms side by side per clip, keep/reject per still, near-dup tick, per-clip "does this show a runner". Saves to localStorage, exports `judgments.csv`. |
| [matcher/eval/score_video_frames.py](cloud-webapp/matcher/eval/score_video_frames.py) | Judgments → precision / near-dup rate / coverage, PASS-FAIL against the §2.3 bar, per arm. |
| [matcher/scripts/sample_drive_videos.py](cloud-webapp/matcher/scripts/sample_drive_videos.py) | Pulls real clips from a Drive event folder (same keyless-DWD auth as `sample_drive_folder.py`). `--list-only` inventories without downloading. |
| [matcher/eval/test_video_frames.py](cloud-webapp/matcher/eval/test_video_frames.py) | 43 tests, all green. Selection logic on hand-built candidates; decode path on a clip synthesised at test time (skips without ffmpeg — no video fixtures in the repo). |

### The three arms

- **`ours`** — plan §1.4: cheap OpenCV scan → best-N shortlist → native-res
  re-extract → face/person embed → gates → identity+geometry diversity.
- **`sharpness_only`** — `sharp-frames`' `best-n --min-buffer` strategy
  reimplemented. Its "different enough" is *temporal spacing only*. This is the
  honest no-neural-net baseline.
- **`katna_like`** — Katna's published pipeline in numpy (brightness/entropy
  filter → k-means on colour histograms → sharpest per cluster). Reimplemented,
  not depended on: Katna's last release is ~4 years old.

Reimplementing the two baselines rather than installing them is a deliberate
call, and it is a caveat on the comparison: it tests their *algorithms*, not
their packaging. Both are small, well-documented selectors and the parts that
matter (sharpness ranking, temporal buffer, histogram clustering) are faithful —
but if a baseline ends up winning, install the real package before adopting it.

---

## 2. The corpus is not what the plan assumed

`sample_drive_videos.py --list-only` over the events root: **125 clips, 27.7 GB.**
The 10-clip sample (spread across the size range, `--max-mb 300`) came out:

| | |
|---|---|
| Resolutions | 5 × 720×1280, 4 × 1080×1920, 1 × 3840×2160 |
| Orientation | **9 of 10 rotated** (portrait phone footage, `rotation: 90/270`) |
| HDR | 2 of 10 HLG (`arib-std-b67`), both HEVC `.mov` |
| Duration | 4.3 s – 21.4 s in the sample; the full inventory has **many 1–7 s clips** |

**The plan assumed 5–60 s; the real corpus skews much shorter.** That matters
because the budget `K = clamp(round(duration/5), 3, 30)` bottoms out at its floor
of 3 for anything under ~8 s — so on most real clips the *budget*, not quality,
decides how many stills come out. Worth revisiting `seconds_per_frame` and the
floor together once judging says how many stills a 5 s clip really supports.

---

## 3. What the first run measured

Command (10 clips, all three arms):

```bash
MODEL_DIR=/path/to/model_files python eval/run_video_spike.py --clips ~/event-clips --out ~/video-spike
```

| arm | stills kept | clips yielding nothing | cpu-s per video-s | total cpu-s / 93.3 s of video |
|---|---|---|---|---|
| `ours` | 19 | 1 of 10 | **1.52** | 141.9 |
| `sharpness_only` | 31 | 0 | 0.79 | 73.3 |
| `katna_like` | 31 | 0 | 0.78 | 72.5 |

Per-clip `ours` cost ran 6.7–31.1 cpu-s; the 4K/60 fps clip is the outlier
(31.1 cpu-s for 7.9 s). Measured on an Apple-silicon laptop, so **Cloud Run vCPUs
will be slower — assume 2–3×** until measured in-cloud.

**Cost: the plan's §2.4 estimate was pessimistic.** It projected ≈100 vCPU-s per
clip for stage B; measured is ~7–31 cpu-s per clip on these (short) clips, i.e.
roughly 3–6× cheaper. The two-stage design is still doing its job — the cheap
arms cost half of `ours`, and that gap is the neural stage — but cost is not the
constraint on this corpus. **Re-measure in-cloud before Phase 2 sizing.**

### 3.1 The decode-path calls in the plan held up

- **ffmpeg CLI over PyAV was right.** 9 of 10 clips carry a display-matrix
  rotation and every still came out upright with no rotation code of our own.
  PyAV would have needed it handled by hand.
- **Native-resolution stills, encoded once.** Verified: a 1080×1920 clip yields
  1080×1920 JPEGs (test asserts this so it can't regress).

### 3.2 HDR: tonemapping is not available everywhere, and that turned out fine

Homebrew's **ffmpeg 8.1.2 is built without libzimg**, so there is no `zscale` and
the plan's tonemap chain dies with `Filter not found`. The fallback (decode
without tonemapping, warn) engaged and the HLG stills came out **well-exposed and
natural-looking, not washed out** — HLG's SDR-compatible base is why.

Consequences to carry into Phase 1/2: keep the fallback, and have the indexer
image install an ffmpeg **with** libzimg (Debian's package has it) so the proper
path is used in production — then compare a tonemapped still against a fallback
one on the same frame before deciding tonemapping is even worth the filter cost.

### 3.3 Motion blur was NOT the limiting factor — the plan expected it to be

Plan §1.3 leads with motion blur as the thing that makes an extracted still look
like a video grab. On this corpus: **zero frames were rejected for face blur.**
Daylight, 30–60 fps, and stage A's sharpness gating between them mean sharpness
is simply not where stills are lost.

### 3.4 What actually governs yield: face SIZE

Of 45 `no_publishable_face` rejections, **43 lost their best face to
`assess_face:too_small`** (2 had no face at all). Sizes of the biggest face
thrown away:

```
  0–20px:  10 frames
 20–30px:  16 frames
 30–40px:  17 frames
```

So the entire 19-vs-31 gap between `ours` and the baselines is essentially one
constant: `MIN_FACE_PX = 40`. Volunteers film runners from the roadside, and at
720p that framing puts faces in the 20–40 px band.

**That constant was imported from the reference-selfie path** — where the photo
is a *query* and 40 px is a generous floor for "can we match on this face". The
plan says to import thresholds rather than duplicate them, which is right for
consistency, but it silently transplanted a query-quality threshold into a
*publish* decision. Those are different questions. **This is the main open
decision (§5).**

Re-running `ours` with `--min-face-px 25`, everything else identical:

| | 40 px (default) | 25 px |
|---|---|---|
| stills published | 19 | **30** |
| clips yielding nothing | 1 of 10 | **0** |
| frames still lost to face size | 43 | 17 (10 of them sub-20 px) |
| cpu-s per video-s | 1.58 | 1.54 |

So the coverage bar is unreachable at 40 px on this corpus and reachable at 25 px,
at no extra cost. Spot-checking the stills the looser gate recovers — including
the only frame from the clip that previously yielded nothing — they are ordinary,
sharp, well-composed roadside running photos, not junk. Whether they are
*findable* is the other half of the question (§5).

> **Harness bug found and fixed while measuring this.** The first `--min-face-px 25`
> run returned byte-identical results to the default. Cause: `analyse_candidate`
> read `assess_face`'s `usable` flag, and `assess_face` applies its own hardcoded
> `MIN_FACE_PX = 40` *inside* `embed_image` — so the flag was a one-way ratchet
> that could only tighten, and the sweep silently measured the same run twice. The
> gates are now re-applied from the raw `face_px` / `blur` / `det_score` numbers,
> with the imported constants as defaults; other `assess_face` reasons (e.g.
> `low_confidence`) are still respected. Four regression tests cover it. Any
> threshold sweep run before this fix is void.

### 3.5 The diversity claim holds — and it is the real differentiator

Plan §1.1 argues temporal spacing alone won't say "different enough". Confirmed
on real footage: on `Misty_Mountain_云_IMG_6423`, `sharpness_only` published two
stills **0.67 s apart** showing the same runners in near-identical composition.
`ours` kept one. Both stills are individually decent photos — the problem is only
visible as a pair, which is exactly what a per-frame sharpness score cannot see.

---

## 4. How to run the rest of Phase 0

```bash
cd cloud-webapp/matcher
python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt -r requirements-test.txt
```

ffmpeg is required (`brew install ffmpeg`). Models: reuse an existing
`model_files/` via `MODEL_DIR`, or `python scripts/fetch_models.py --dir model_files`.

Inventory, then pull a sample:

```bash
.venv/bin/python scripts/sample_drive_videos.py <EVENTS_ROOT_OR_EVENT_FOLDER_ID> --list-only
```

```bash
.venv/bin/python scripts/sample_drive_videos.py <FOLDER_ID> --out ~/event-clips --n 10 --max-mb 300
```

Run all three arms:

```bash
MODEL_DIR=$PWD/model_files .venv/bin/python eval/run_video_spike.py --clips ~/event-clips --out ~/video-spike
```

Judge — this is the part a human has to do:

```bash
.venv/bin/python eval/make_frame_review_page.py --report ~/video-spike/report.json
```

```bash
open ~/video-spike/review.html
```

Mark every still keep/reject on "would a volunteer have published this?", tick
near-dups, mark each clip runner / no-runner, then **Download judgments.csv** and
save it into `~/video-spike/`. Score it:

```bash
.venv/bin/python eval/score_video_frames.py --report ~/video-spike/report.json --judgments ~/video-spike/judgments.csv
```

The bar (all three, per arm): precision ≥ 0.80, near-dups ≤ 0.10, coverage 1.00
of clips that clearly show a runner. Re-tune with flags and re-judge; e.g. the
face-gate experiment in §5:

```bash
MODEL_DIR=$PWD/model_files .venv/bin/python eval/run_video_spike.py --clips ~/event-clips --out ~/video-spike-px25 --selectors ours --min-face-px 25
```

Tests:

```bash
.venv/bin/python -m pytest eval/test_video_frames.py -q
```

**The clips are real attendee footage on a laptop.** Delete them when Phase 0 is
done (`rm -rf ~/event-clips ~/video-spike*`), same hygiene as the M0 photo spike.

---

## 5. The open decision: what face size is publishable

At 40 px, `ours` drops 43 otherwise-good frames and one whole clip entirely, and
**cannot clear the coverage bar**. At 25 px it publishes 30 stills from all 10
clips at the same cost. Two coherent positions:

- **Keep 40 px.** A still whose faces are all sub-40 px can't be face-matched, so
  a runner can never *find* it by selfie. Publishing it only adds gallery volume,
  and the plan's own risk table says "publish nothing rather than something bad".
- **Lower it to ~25 px.** The photo is still downloadable and shareable, and the
  matcher has a **person/outfit (OSNet) channel** that can retrieve a runner
  without a usable face — so "unmatchable" overstates it. A 25 px face is also
  enough for someone to recognise *themselves*, which is what a gallery is for.

This is a product call, not a tuning detail, and it decides whether `ours` clears
the bar at all. Both runs are already sitting on disk with review pages built
(`~/video-spike` at 40 px, `~/video-spike-px25` at 25 px) — judge them and let
`score_video_frames.py` decide.

### 5.1 Can the matcher retrieve a 25–40 px face? — measured, partly

[face_size_retrieval.py](cloud-webapp/matcher/eval/face_size_retrieval.py) (+ 9
tests) answers this two ways. The match floor is derived from the matcher's own
constants, not hardcoded: fusion reports at fused ≥ 0.25 and face carries 0.85 of
it, so a face-only match needs cosine ≥ **0.294**.

**Arm 1 — controlled downscale (N = 556 reference faces, 100 real event photos).**
Take a large clear face, shrink the whole photo until that face is 40/35/30/25/20
px, re-detect, re-embed, and compare to its own full-size embedding. Identity is
ground truth by construction. Impostors are drawn from *other faces in the same
photo*, so they are guaranteed to be different people.

| target | detected | genuine cos p50 | genuine cos p10 | impostor p95 | ≥ floor | > impostor p95 |
|---|---|---|---|---|---|---|
| 40 px | 99% | 0.935 | 0.883 | 0.240 | 99% | 99% |
| 35 px | 99% | 0.916 | 0.853 | 0.242 | 99% | 99% |
| 30 px | 98% | 0.888 | 0.816 | 0.237 | 98% | 98% |
| 25 px | 99% | 0.837 | 0.744 | 0.244 | 99% | 99% |
| 20 px | 99% | 0.750 | 0.635 | 0.247 | 98% | 98% |

SCRFD still *finds* the face ~99% of the time down to 20 px, and ArcFace degrades
gracefully: at 25 px the median genuine cosine is 0.837 against an impostor p95 of
0.244 — nowhere near the 0.294 floor. **On this evidence, face size alone is not
what makes a still unmatchable.**

**Arm 2 — native distant faces: inconclusive, and it disagrees in direction.**
The downscale arm is optimistic by construction (it keeps a close-up's focus and
lighting), so the second arm tracks real runners through a clip and compares each
one's smallest and largest face — a genuinely distant face against a genuinely
near one. It does not support a conclusion:

- Position-only tracking **swapped identities** in the race pack. The first run
  reported 5 of 34 pairs retrieved, but the endpoint crops showed why: one
  "track" ran from a young man's 18 px face to an elderly man's 175 px face. The
  near-zero cosines were right; the identities were wrong. Linking now also
  requires size continuity and OSNet **outfit** agreement (a different model from
  ArcFace, so it does not beg the question), which cut 34 pairs to 8 — and
  eyeballing those crops still finds ambiguous ones where two runners overlap.
- What survives verification is thin: **one confirmed same-runner pair at 37 px
  vs 77 px, cosine 0.472 — retrieved.** One more at 62 px vs 175 px (0.644),
  above the band of interest.
- The signal worth noting: verified native cosines (0.47) run *far* below the
  downscale arm's equivalent (0.92 at 35 px). That is consistent with the stated
  caveat — a truly distant face is degraded well beyond a shrunken close-up — but
  with one verified pair it cannot be quantified.

**Verdict: the downscale arm removes "a small face is unmatchable" as a
first-principles argument, but it does not establish that these particular stills
get found.** Do not settle the 40-vs-25 px gate on Arm 1 alone.

### 5.2 Replay against real searchers — frames DO get retrieved

[frame_retrieval_probe.py](cloud-webapp/matcher/eval/frame_retrieval_probe.py)
answers the question against real people with real votes, on **2026 NYRR Team
Champs** (`ecd530b9…`) — 812 votes from 68 searchers, and the event 5 of our
sample clips came from.

**No selfies were used, and none were needed.** The in-cloud replay exists because
biometric reference selfies must not touch a laptop (PRD §8). But the event's
vector store already holds an embedding for every photo, and `match_feedback`
says which photos each searcher confirmed as *themselves* — so a searcher's
identity can be reconstructed from ordinary gallery photos they already vouched
for: take every face in their confirmed photos, and the one that recurs across
the most of them is the searcher (in a race photo everyone else is a stranger).
That query is then folded the way the matcher folds multiple selfies. Cheaper
than the cloud job, verifiable by eye, and no biometrics leave the gallery.

15 stills (the 25 px gate, 5 clips, faces 12–58 px) scored against 50 searchers
whose identity could be reconstructed (18 of the 68 had too few confirmed photos):

| band | score |
|---|---|
| searcher's own confirmed photos (true positives) | median **0.855** |
| random other faces in the event (negatives) | p95 **0.153** |
| best frame per searcher | median **0.234**, max **0.495** |
| **searchers with ≥1 frame above the 0.294 floor** | **12 / 50 (24%)** |

**The top hit is verified true, by bib number rather than by my judgment of a
face.** Searcher `nyAfgYtrYyZR` matched `IMG_6431/f03_t006000.jpg` at 0.495. Their
confirmed photo shows two women in red Misty Mountain tops wearing bibs **D 898**
and **D 1202** — and the video still shows *the same two bibs*. The runner really
is in the frame, and the matcher really would return it to her.

Two honest limits on this result:

- **The weak hits are unverified.** Six searchers matched that same still, which
  is plausible — it is a crowd frame with 15+ people — but hits near the floor
  (0.295–0.35) could not be checked: the searcher's confirmed photos are
  start-line crowd shots where I cannot tell which person they are. Only the
  strong hit is confirmed.
- **Identity reconstruction is a proxy for a selfie.** A gallery photo is a
  cleaner, more frontal query than a real selfie, so 24% is plausibly optimistic.

### 5.3 What this means for the gate

Both the "keep 40 px" arguments now fail on real data: a 25 px face embeds fine
(§5.1), and frame-derived stills genuinely surface for real searchers (§5.2).
**The evidence favours lowering the gate to ~25 px** — which is also the only
setting that clears the coverage bar.

Two findings that should shape Phase 2/3 regardless of the gate:

- **Frames rank far below real photographs** (0.234 median vs 0.855 for a
  searcher's own photos). They will land at the bottom of a result set rather
  than displacing real photos — reassuring for the "gallery flooded with video
  grabs" risk in the plan's risk table, and an argument against any ranking boost
  for frames.
- **Yield is modest**: 15 stills covering a few seconds of one race reached 24% of
  searchers. Frames supplement a gallery; they do not carry one.

Still outstanding, and now the *only* thing between here and the Phase 0 gate:
**human judging of whether these stills are publishable photos.** The retrieval
question is answered; the "would a volunteer publish this" question is not, and
it cannot be answered by a measurement — see
[HUMAN_REVIEW_LOOP_PLAN.md](HUMAN_REVIEW_LOOP_PLAN.md).

Two smaller open items, both cheap to settle once judging is done: the budget
floor on short clips (§2), and whether tonemapping is worth it at all (§3.2).

---

## 6. Known limits of this harness

- **`ours` needs `yolov8n.onnx`** for real person boxes. Without it the bundle
  falls back to face-box expansion (the runner warns), which weakens the
  `w_persons` score term and the geometry half of the diversity test. The local
  `model_files/` used for this run has no `yolov8n.onnx`, so **the diversity test
  ran on the weaker signal and can only improve** with it staged.
- **Stage B re-seeks by timestamp**, so the still can land ±1 frame from the one
  stage A scored. Harmless (quality is re-measured on what was actually
  extracted) but it means `report.json`'s `scan_blur` and `frame_blur` describe
  possibly-adjacent frames.
- **Baselines are reimplementations** (§1). Install the real packages before
  adopting one.
- **Cost is laptop cost.** Not Cloud Run vCPU-seconds.
- **One judge.** The face-matching eval had the same limitation; two judges on a
  disputed subset would be cheap insurance if the result lands near the bar.
