# PEOPLE_RECOGNITION_QUALITY_PLAN.md — improving Find-Me match quality

**Status:** drafted 2026-07-19. Concrete, sequenced work derived from
`FACE_RECOGNITION_IMPROVEMENT_ANALYSIS.md` (see its §8 July-2026 update). This plan
turns that options/roadmap doc into buildable items, led by a small PRD for
capture-time-conditional outfit fusion (Item 1), then additional quality items in
return-on-effort order.

## Current pipeline (recap, as built)

Production match/fusion is the **matcher Python service** (`MATCHER_URL`, private Cloud
Run): `matcher/main.py search()` embeds the query, retrieves per-crop cosine top-k from
`matcher/store.py`, and fuses via `matcher/fusion.py fuse()` (face 0.85 / person 0.15,
fused threshold 0.25). Vectors + `manifest.json` are flat per-event files written by the
indexer; each manifest row is `{photoId, box, score, ...extra}`. Capture time is already
extracted per photo by the indexer's `capture_time` module and stored as Firestore
`takenAt` / `takenAtSource` (see `CAPTURE_TIME_SORT_DESIGN.md`) — but is **not yet in the
matcher manifest.**

## Guardrails (apply to every item)

- **Eval per change.** Re-run the judged eval (`EVAL_FEEDBACK_LOOP.md`): judged P@20 ≥
  0.85, with the evidence bar (≥20 judged pairs / ≥5 users per event) before a number
  gates anything. Embedding-model changes bump `model_version` and re-run per version;
  fusion/threshold changes are **offline sweeps, human-approved**, never auto-tuned.
- **Zero-idle / free-tier.** The indexer is a CPU-ONNX Cloud Run Job billed on
  vCPU/GiB-seconds (450k GiB-s/mo binding constraint per `CLAUDE.md`). Prefer changes that
  are compute-neutral or compute-gated; note the cost delta of anything that isn't.
- **Precision-first on auto-assignment.** A wrong tag in Find-Me is worse than a miss —
  flag/expander over silent false positives (PRD §2, feedback-loop §4b).
- **License hygiene.** Ship only permissive (MIT/Apache) weights in production. Open flags
  tracked inline (AGPL YOLO, non-commercial LVFace).

---

# Item 1 — PRD: capture-time-conditional outfit fusion

**Why first:** cheapest change (mostly logic, compute-negligible) that hits the "outfits
sometimes change" reality head-on, and it converts the static 0.15 person weight from a
liability into a *conditional* asset.

## Problem

The outfit/person (OSNet ReID) signal is fused at a **fixed** weight regardless of when
the candidate photo was taken. Appearance only indicates identity when the query
reference and the candidate are **temporally close** (same session → same outfit).
Consequences of the fixed weight:

- **Over-trust across time gaps → false positives.** A runner photographed in the morning
  and again after a jacket/shirt change hours later has *different* appearance; meanwhile a
  *different* attendee in similar kit scores a spurious outfit boost. The weight can't tell
  these apart.
- **Under-use within a burst.** When reference and candidate are seconds/minutes apart,
  outfit is a *strong* same-person signal, but a 0.15 cap under-exploits it.

## Goals / non-goals

- **Goal:** scale the person contribution by temporal proximity between the query anchor
  time and each candidate photo's capture time; degrade gracefully to today's behavior
  when capture time is unavailable.
- **Goal:** no regression when timestamps are missing (old/edited query selfies, photos
  without EXIF).
- **Non-goal:** clustering, co-occurrence constraints, or GEFF (tracked as Items 9–10).
- **Non-goal:** changing the face signal or embeddings.

## Design

**Data plumbing.**
- Indexer: emit per-photo capture time into the matcher manifest. Add `takenAtMs`
  (epoch ms, UTC-normalized) and `takenAtSource` to each `faces`/`persons` manifest row
  (or a compact per-`photoId` map alongside — avoids duplicating on multi-crop photos).
  Source is the value `capture_time` already computes for Firestore `takenAt`; reuse it,
  don't re-parse EXIF. Bump manifest `version` 1 → 2; the matcher must read v1 (no times)
  and v2 alike.
- Query anchor time: parse the uploaded selfie's EXIF `DateTimeOriginal` in
  `matcher/main.py`. If absent/unparseable → `anchor = None`.

**Weighting.** In `fuse()`, replace the scalar person weight with an effective per-photo
weight:

```
w_person_eff(t_cand) = w_person * decay(|t_cand - anchor|)
decay(dt) = 1.0                         if dt <= W_FULL
          = linear/exp fade 1.0 → FLOOR if W_FULL < dt <= W_ZERO
          = FLOOR                        if dt >  W_ZERO
```

- Defaults (config, tunable via sweep): `W_FULL ≈ 45 min`, `W_ZERO ≈ 3 h`, `FLOOR ≈ 0.0`.
- `anchor is None` **or** candidate `takenAtMs is None` → `w_person_eff = w_person`
  (today's static behavior — no regression).
- Face weight is unchanged; keep the fusion additive (do not renormalize) so a strong face
  match still carries the score exactly as it does now (`fusion.py` docstring rationale).

**Implementation points.**
- `matcher/fusion.py`: `fuse()` accepts an optional `person_weight_fn(photoId) -> float`
  (or pre-scaled person scores). Keep the existing scalar signature working (default fn
  returns `w_person`).
- `matcher/main.py search()`: compute `anchor`, build the per-photo weight fn from manifest
  `takenAtMs`, pass into `fuse()`. Return `personWeight` alongside `faceScore`/`personScore`
  in results for debuggability/eval.
- `matcher/store.py`: `build_manifest()` carries the new per-photo time; `EventEmbeddings`
  exposes it.
- Config: `PERSON_TIME_W_FULL_MIN`, `PERSON_TIME_W_ZERO_MIN`, `PERSON_TIME_FLOOR` (env),
  plus a `FUSION_CONFIG_VERSION` string recorded on `match_runs` so eval can group by it.

**Timezone/robustness.** Normalize all times to UTC epoch ms at extraction (EXIF is
often naïve local time — reuse `capture_time`'s existing handling). Guard against absurd
deltas (camera clock wrong → treat as missing rather than forcing FLOOR).

## Eval & rollout

- Feature-flag (`FUSION_TIME_CONDITIONAL=true|false`); default off until swept.
- A/B on accumulated judged labels once ≥2 events meet the evidence bar: sweep
  `W_FULL`/`W_ZERO`/`FLOOR`; human-approve; measure **judged P@20**, **FP rate**, and the
  **expander click-rate** recall proxy. Report per `FUSION_CONFIG_VERSION`.
- No `model_version` bump (embeddings unchanged) — but manifest `version` 2 requires a
  one-time re-index (or a lazy backfill of `takenAtMs` into existing manifests).

## Cost / risk / effort

- **Cost:** negligible at query time (one scalar per candidate); indexer adds one field.
- **Risks:** unreliable query EXIF (mitigated by the `anchor is None` fallback); events
  where nobody's capture time survived (falls back to static weight — no worse than today).
- **Effort:** ~2–4 days incl. eval wiring.

---

# Additional quality items (sequenced)

Ordered fast/free → heavier. Each notes the constraint it targets:
**[recall] [precision] [no-face] [outfit-change]**.

## Item 2 — Score normalization / T-norm  **[precision]**
Subtract each query's mean similarity to a background cohort of event faces before
thresholding (`FACE_RECOGNITION_IMPROVEMENT_ANALYSIS.md §1.3`). Lets us *lower* the
threshold for recall without adding false positives, and reduces reliance on large labeled
sets — a **better lever than nudging the global 0.25 from a few "wrong" annotations**.
Change: `matcher/main.py`/`store.py` (one extra dot-product pass). Compute-negligible.
Effort ~1–2 days.

## Item 3 — Multi-reference query + pseudo-relevance feedback  **[recall]**
Let users upload several selfies → query **centroid** (mean of L2-normalized embeddings) +
max-over-references score (§1.1). Fold "Confirmed" photos' face embeddings back into the
centroid and re-search (§1.2) — reuses `match_feedback`. One of the largest recall jumps,
nearly free. Change: `matcher/main.py search()`. Effort ~2–3 days.

## Item 4 — SAHI tiled detection on high-res crowd photos  **[recall]**
Keep SCRFD; add optional slicing-aided inference (overlapping tiles → NMS merge) on
large/sparse-detection photos so tiny/distant faces in packs get an embedding written
(§2, §8). **Compute-gated** (full-frame first; tile only when few/small detections or
resolution is high) to protect the free-tier. Change: indexer detection stage. Effort
~3–5 days; watch GiB-s on tiled events.

## Item 5 — CR-FIQA quality weighting  **[precision][recall]**
Add CR-FIQA (ONNX, cheap) and **weight** faces by quality in fusion instead of the current
binary drop in `matcher/quality.py`; also use it to pick the best reference selfie. §3.3,
§8. Modest indexer cost. Effort ~3–4 days.

## Item 6 — Bib signal (roster-matched, co-primary)  **[no-face][precision]**
Highest-value for "bibs not always worn" — rescues back-turned / no-face / motion-blurred
shots, and a confident bib read matches the **participant roster** → near-certain identity.
Build (§5, §8): fine-tune **YOLOv11-n/s** bib detector → crop → **RapidOCR (PP-OCRv6, pure
ONNX, Apache-2.0)** with a digit whitelist/regex + confidence gate → store `bibNumbers[]`
per photo in the manifest → at search time exact/partial-match to the runner's known bib
and **auto-confirm / strongly boost** in fusion; support **partial** bib matches
(occlusion/glare). **Flag, don't guess** on low-confidence reads (expected 5–15% no-read
tail; optional hosted-VLM fallback on flagged crops only). **⚠ Resolve the Ultralytics
AGPL-3.0 license before shipping.** Effort ~1–2 weeks (spike on one race first).

## Item 7 — AdaFace IR-50 embedder A/B  **[recall][precision]**
Swap ArcFace `w600k_r50` → **AdaFace IR-50** (WebFace12M, MIT, ONNX, ~1× cost) — its
quality-adaptive margin targets our low-quality/blur/profile regime (§3.2, §8). **Re-tune
the fused threshold** (AdaFace cosine distribution differs) and re-run the judged eval per
`model_version`. Indexer cost ≈ neutral. Effort ~3–5 days incl. A/B.

## Item 8 — Per-event thresholds via hard-negative mining  **[precision]**
Use "Not me" annotations (incl. the incorrect-tag reports in the DB) to set **per-event**
thresholds instead of one global 0.25 (§4). This is the defensible use of a small,
one-sided negative set — pairs with Item 2. Human-in-the-loop. Effort ~2–3 days once
enough negatives accumulate.

## Item 9 — Identity clustering + cluster-confirm HITL  **[recall]**
Cluster event face embeddings (HDBSCAN, with a DBSCAN/single-cluster fallback; optionally
A/B Chinese Whispers — §3.1, §8). A query matches a *cluster* → return the whole cluster so
low-quality faces ride in on good neighbors; "these 40 look like you — confirm?" labels
many photos per tap (§4). Add **co-occurrence** constraints to fight over-splitting
(Immich lesson, §8). Biggest recall step; offline/batch. Effort ~1–2 weeks.

## Item 10 — GEFF: face-anchored appearance gallery  **[outfit-change]**
Enrich the appearance/ReID gallery with face features (GEFF, arXiv 2211.13807, §8) so face
bridges identity across a clothing change while appearance covers face-not-visible shots.
Natural follow-on to Items 1 + 9. Offline. Effort ~1 week.

---

## Suggested sequencing

1. **Now (days, ~free):** Item 1 (capture-time fusion), Item 2 (T-norm), Item 3
   (multi-ref + PRF). Measure against judged P@20 + expander click-rate.
2. **Recall push:** Item 4 (SAHI), Item 5 (CR-FIQA).
3. **No-face coverage:** Item 6 (bib signal) — spike on one race; settle AGPL first.
4. **Embedder + calibration:** Item 7 (AdaFace A/B), Item 8 (per-event thresholds).
5. **Structural recall / outfit-change:** Item 9 (clustering + HITL), Item 10 (GEFF).

Constraint coverage: **bibs-not-always → 6** (+ face/burst fallback); **outfits-change →
1, 10**; **recall → 3, 4, 9**; **precision/calibration → 2, 5, 8**.
