# FACE_RECOGNITION_IMPROVEMENT_ANALYSIS.md

**Status:** analysis drafted 2026-06-23. Scope: improving accuracy and recall of
the "Find Me" matcher, plus adding a runner-bib signal for race events. This is
an options/roadmap doc, not a committed plan — items are ranked by return on
effort so they can be slotted into the existing `FACE_MATCHING_DEV_PLAN.md`
milestones.

---

## 0. Current pipeline (as read from the repo)

Source reviewed: `cloud-webapp/matcher/{pipeline,fusion,quality,main,store}.py`,
`cloud-webapp/matcher/models/*`, and `EVAL_FEEDBACK_LOOP.md`.

| Stage | Implementation | Key params |
|---|---|---|
| Face detection | SCRFD `det_10g` (buffalo_l), standalone ONNX | `score_thresh=0.5`, single 640 letterbox |
| Face alignment | 5-point similarity transform (`estimateAffinePartial2D`) → 112×112 | ArcFace canonical template |
| Face embedding | ArcFace `w600k_r50` (buffalo_l), 512-d, L2-normalized | — |
| Person ("outfit") | YOLOv8n detector + OSNet `x0_25` ReID (512-d) | det `score_thresh=0.4`, ImageNet norm |
| Quality gate | min face 40px, det score 0.5, blur (Laplacian var) ≥ 45 | binary keep/drop |
| Store / search | Flat `.npy` per event, brute-force in-memory cosine | zero-cost, event-scoped |
| Fusion | Weighted score: face 0.85 / person 0.15, threshold 0.25 | RRF available but unused by default |
| Query selection | Single most-confident usable face + its person crop | one reference only |
| HITL / eval | `match_feedback` confirm/not_me, judged P@20, "see more" expander | target P@20 ≥ 0.85 |

The stack is solid and standard. The gains below come from how signals are
*used*, not from the models being wrong.

---

## 1. Code-only wins (no new models — biggest ROI)

### 1.1 Use more than one query face
`main.py search()` picks `query_face = max(usable_faces, key=score)` — a single
reference. Let users upload several selfies and build a query **centroid** (mean
of L2-normalized embeddings) plus a **max-over-references** score. Nearly free,
and one of the largest recall jumps available because it averages out pose/blur
in any single reference shot.

### 1.2 Pseudo-relevance feedback (query expansion from confirmations)
When a user taps "Confirmed", those photos are clean, in-domain references. Fold
their face embeddings back into the query centroid and re-search the event.
Recall on the *remaining* photos climbs sharply. The data already exists in
`match_feedback` — this reuses it.

### 1.3 Score normalization (T-norm / cohort normalization)
A fixed cosine cutoff (0.25 fused) treats a "generic-looking" face the same as a
distinctive one, which drives false positives. Subtract each query's mean
similarity to a background cohort of event faces before thresholding. Borrowed
from speaker verification; lets you **lower** the threshold (recall) without
losing precision. Cost: one extra dot-product pass per query — negligible at
event scale.

---

## 2. Detection is the recall ceiling

If SCRFD misses a face, **no embedding is ever written** and the person is
unrecoverable in that photo — no downstream trick helps. At races this bites on
small/distant faces in crowd shots, motion blur, and profile turns.

- **Decouple index-side from query-side thresholds.** Index at a lower
  `score_thresh` / `MIN_DET_SCORE` (high recall — keep everything), keep the
  query side strict. Today both sit at 0.5.
- **Tiled / multi-scale detection** on large group photos: run SCRFD on
  overlapping crops and merge with NMS, or feed `det_10g` at higher input than
  640, or step up to **SCRFD-34G**. The indexer is a batch job, so the extra
  cost lands there, not on user-facing latency.

---

## 3. New algorithms / packages

### 3.1 Offline identity clustering — biggest single recall mechanism
Cluster all event face embeddings (already stored as flat `.npy`) with
**HDBSCAN** or dlib **Chinese-whispers**. A query then matches a *cluster*, and
you return the whole cluster — so low-quality faces that individually fall below
threshold ride in on their good neighbors. Also powers the HITL ideas in §4.
Packages: `hdbscan`, `scikit-learn` (DBSCAN), or `dlib` (chinese_whispers).

### 3.2 Upgrade the embedder
Two grounded paths (both ONNX, drop into the existing standalone loader):

- **antelopev2 / `glintr100`** — R100 trained on Glint360K. Clearly stronger on
  profile views (CFP-FP) and age gap than `w600k_r50`. ~2× CPU.
- **AdaFace** (ir101, WebFace12M) — *quality-adaptive* margin: higher true-positive
  rate and fewer false positives than ArcFace specifically on **low-quality**
  faces (blur, distance, crowd) — i.e. exactly event conditions. Most on-target
  upgrade for this use case. ONNX export available from the repo.

### 3.3 Face quality / pose weighting
`quality.py` computes blur + size but only as a binary gate. Add a yaw estimate
from the 5 landmarks and a face-image-quality score (**CR-FIQA** or **SER-FIQ**),
then **weight** embeddings rather than dropping them — de-prioritize profile/blur
instead of discarding usable signal.

### 3.4 ANN — not yet
`faiss` / `hnswlib` / `usearch` only matter once events outgrow brute force.
At a few thousand photos cosine is milliseconds; skip for now.

### 3.5 Outfit — low priority
OSNet `x0_25` is the smallest variant; `x1_0` or a transformer ReID is stronger,
but outfit only helps same-day. Lower ROI than everything above.

### Cost note (ties to CLAUDE.md zero-idle / free-tier policy)
AdaFace-ir101 and R100 roughly **double** indexer vCPU/GiB-seconds — watch the
450k GiB-s/month binding constraint on Cloud Run Jobs. Clustering, multi-ref
query, and score-norm are nearly free.

---

## 4. Human-in-the-loop

Building on the existing feedback loop and "see more" expander:

- **Cluster confirmation.** Show the user a whole cluster ("these 40 photos look
  like you — confirm?"). One tap labels many photos and lets borderline members
  through (recall), instead of judging one photo at a time.
- **Active learning on the boundary.** Surface near-threshold pairs *first* for
  labeling — those labels move calibration the most. Formalizes what the
  expander already gestures at.
- **Hard-negative mining** from "not me" votes to set **per-event** thresholds
  rather than one global 0.25.

---

## 5. Runner bibs — add as a third, high-precision signal

For a race photo DB this is high-value: when a bib is visible and legible,
**OCR'd bib number → registered runner is a near-exact match**, far more reliable
than face, and it rescues back-turned / no-face / motion-blurred shots where face
recognition has nothing to work with.

Treat it as a high-precision **booster, not a replacement** — bibs get occluded,
folded, hidden under jackets, or aren't worn at all. Face stays the recall
backbone.

### Recommended build (reuses existing infra)
- **Detector:** fine-tune **YOLOv8/v11** for bibs — same ONNX loader and
  inference path already used for person detection.
- **OCR:** **PaddleOCR** or **docTR** for the digits (both strong on natural-scene
  text, ONNX-able); **EasyOCR** as the quick starting point. Avoid Tesseract —
  weak on in-the-wild scene text.
- **Integration:** store `bibNumbers: [...]` per photo in the manifest during
  indexing; at search time, if the runner's bib is known, exact/fuzzy-match and
  auto-confirm or strongly boost those photos in fusion. Bib also disambiguates
  look-alike runners.

### Existing projects to mine (approach + labeled data)
- ericBayless/bib-detector — two-stage YOLO (bib, then digits); closest to the
  recommended build. https://github.com/ericBayless/bib-detector
- Lwhieldon/BibObjectDetection — YOLOv4 bib detection in natural scenes.
  https://github.com/Lwhieldon/BibObjectDetection
- alexcu/rbnr — full recognition pipeline. https://github.com/alexcu/rbnr
- gheinrich/bibnumber — staged HOG+SVM. https://github.com/gheinrich/bibnumber
- KateRita/bib-tagger — SWT + Tesseract (dated). https://github.com/KateRita/bib-tagger

### Datasets
- Roboflow "bib number labeling": https://universe.roboflow.com/marco-cheung/bib-number-labeling
- HF TrainingDataPro/race-numbers-detection-and-ocr:
  https://huggingface.co/datasets/TrainingDataPro/race-numbers-detection-and-ocr
- MIT RBNR dataset: https://people.csail.mit.edu/talidekel/RBNR.html

---

## 6. Suggested sequencing

1. **Quick wins first (days, code-only):** multi-reference query (§1.1),
   pseudo-relevance feedback (§1.2), score normalization (§1.3). Measure against
   judged P@20 + the expander click-rate recall proxy.
2. **Detection recall (§2):** decouple index/query thresholds; pilot tiled
   detection on a known crowd-heavy event.
3. **Clustering (§3.1) + cluster-confirm HITL (§4):** biggest recall step;
   re-run judged eval per `model_version`.
4. **Embedder upgrade (§3.2):** A/B AdaFace vs antelopev2 on accumulated labels
   before committing (watch the GiB-s free-tier budget).
5. **Bib signal (§5):** detector + OCR spike on one race event; add `bibNumbers`
   to the manifest and a hard-match boost in fusion.

---

## 7. References
- AdaFace: Quality Adaptive Margin (CVPR 2022) — https://ar5iv.labs.arxiv.org/html/2204.00964 ;
  repo https://github.com/mk-minchul/adaface
- InsightFace model zoo — https://github.com/deepinsight/insightface/blob/master/model_zoo/README.md ;
  model-choice guide https://www.insightface.ai/guides/choose-face-recognition-model-and-evaluate
- Bib detection/OCR repos and datasets: linked inline in §5.
