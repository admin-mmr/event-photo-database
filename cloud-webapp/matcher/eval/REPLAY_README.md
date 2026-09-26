# Replay tuning — cutoff, fusion weights, anchors, face quality

Replay past events against members' "That's me / Not me" votes to tune the
matcher: `MATCHER_NORM_THRESHOLD` (the T-norm cutoff), the fusion weights, and the
opt-in knobs (anchor suggestions, `FACE_QUALITY_WEIGHT`). T-norm has been live
since 2026-07-22; the cutoff went 4.0 → **4.5** on 2026-09-23 (see
[Last calibration](#last-calibration-2026-09-23)).

Check current per-event judged P@20 from the raw votes (no replay) any time with:

```
~/.venvs/findme-eval/bin/python eval/export_feedback_labels.py --project mmr-data-pipeline --out-dir /tmp/labels
```

## The monthly report does the no-selfie part for you

`monthly_calibration.py` runs as the `findme-calibration` job on the 1st of each month and
writes `gs://mmr-data-pipeline-derivatives/eval/calibration/<date>.md`: the badge re-fit, the
cutoff re-score below, per-event judged precision, and which events to replay. Read that first;
it proposes, it never applies. Run it by hand with
`gcloud run jobs execute findme-calibration --region=us-central1 --project=mmr-data-pipeline --wait`.

## First try it without selfies: `rescore_logged_runs.py`

Every search since 2026-09-23 logs its candidates' face/outfit z-scores, including the
near-miss band just under the cutoff. That is enough to re-test a cutoff or fusion weight
across every logged search with no selfies, no models and no Cloud Run job:

```
~/.venvs/findme-eval/bin/python eval/rescore_logged_runs.py --project mmr-data-pipeline \
  --cutoffs '4.0;4.5;5.0' --weights '0.85:0.15;1.0:0.0'
```

Raising the cutoff is scored exactly. Photos a lower cutoff would admit were mostly never
shown, so they are reported as *admitted, unjudged* — never as wrong. Use the full replay
below when you need what the logs can't give: a new model, anchors, or face quality.

## Pick events whose voters still have a selfie

**Selfies are deleted 90 days after UPLOAD** (lifecycle rule on the uploads
bucket, plus 7 days of soft delete) — not 90 days after the vote. An event searched
months ago has lost most of its queries even if its votes are recent. On
2026-09-23, `81a584f7` (the July baseline event) had a live selfie for only 25 of
its 102 voters. Its votes still count for judged P@20; it just can't be replayed.

`prepare_replay.py` falls back to a voter's newer selfie from another event (same
face) when the preferred one is gone, and `run_eval.py` **exits 2 below 50% query
coverage** (`--min-query-coverage`) — the survivors would be a biased sample. The
evidence bar (≥20 judged pairs / ≥5 users) counts only people actually scored.

## What a replay needs

1. **Judged labels** — the confirmed/wrong votes (`match_feedback`).
2. **A query per searcher** — their reference selfie(s) from the uploads bucket,
   embedded with the ONNX models.
3. **The event vectors** — read straight from `gs://<project>-derivatives`
   (`store.py` reads `gs://`).

`prepare_replay.py` assembles 1 + 2; `run_eval.py --judged-only --tnorm --prf`
does the ranking and the sweep.

## Recommended: run it in-cloud (selfies never touch a laptop)

```
EVAL_ARGS="--tnorm --anchor-promotion --face-quality-weight 0.25;0.5;1.0" \
REPORT_GCS=gs://mmr-data-pipeline-derivatives/eval/replay-$(date +%F).json \
./infra/scripts/run-replay-job.sh mmr-data-pipeline <event-id>,<event-id>,<event-id>
```

Several comma-separated events share one image build and run as sequential
executions; each gets `<report>-<event-id-prefix>.json`. `EVAL_ARGS` picks the
analyses (default `--tnorm --prf`).

Builds `eval/Dockerfile.replay` (matcher image + firestore + eval scripts, models
baked in), then runs a Cloud Run **job** (`api-runtime@` SA; scales to zero after
the single run). The biometric selfies are downloaded and embedded only inside
the ephemeral container. Save the JSON report with `REPORT_GCS=gs://…/report.json`.
Read the sweep from the job logs.

## Local alternative (needs the ~300 MB ONNX models on disk)

```
MODEL_DIR=/path/to/model_files ~/.venvs/findme-eval/bin/python eval/prepare_replay.py \
  --project mmr-data-pipeline --event-id <event> \
  --derivatives gs://mmr-data-pipeline-derivatives --out-dir /tmp/replay
# then run the run_eval.py command it prints
```
(The venv needs `google-cloud-firestore` + `google-cloud-storage` + the matcher
deps; downloads the selfies to `/tmp/replay/queries/` — delete when done, PRD §8.)

## Reading the result

The `--tnorm` output ends in an **operating-point table**: T-normed fused results
at fixed z cutoffs (3.0…6.0, including the production value) for several fusion
weights, each cell `P right/wrong`. That table, not the `Best:` line, is what a
config change should come from:

- **`Best: wF=… wP=…`** is the raw-cosine top-20 re-rank with no cutoff. It says
  which weights order results best, not what members see at the production cutoff.
  The anchor and face-quality passes currently run at those weights.
- **Compare weights at matched precision, not at one cutoff.** The columns keep
  `wF + wP = 1`, so lowering the outfit weight raises the face weight and every
  score with it; at one fixed cutoff, "face only" looks like it admits more of
  everything. Find the row where each column reaches the same precision and
  compare the right-match counts.
- Recall is unmeasurable from votes, so a higher cutoff always looks better on
  precision. Trade right matches lost against wrong matches removed, and watch the
  "see more" click rate after a change.

Apply a new cutoff by changing the default in `matcher/main.py` (a deploy uses
`--set-env-vars`, so an env override is wiped on the next deploy), and bump
`SEARCH_ALGO_VERSION` in `shared/src/schemas/findme.ts` so later votes separate.

## Last calibration (2026-09-23)

Events `5ff5ff5c` (63/66 voters with a selfie), `ecd530b9` (65/71), `c97aff22`
(27/30) — all with real yolov8n person crops. Reports:
`gs://mmr-data-pipeline-derivatives/eval/replay-2026-09-23-<event8>.json`.

| at wF/wP 0.85/0.15 | right | wrong | P |
|---|---|---|---|
| z ≥ 4.0 (was live) | 2,240 | 212 | 0.914 |
| **z ≥ 4.5 (now live)** | **2,053** | **114** | **0.947** |

- **Cutoff 4.0 → 4.5:** −8% right, −46% wrong, pooled (per event, wrong fell
  29% / 69% / 62%).
- **Fusion weights unchanged:** at matched precision the outfit weight was
  neutral on all three events. Outfit is now informative for ranking (person-only
  judged P@20 0.94 / 0.94 / 0.81, vs 0.50 in July on face-box crops), but not at
  the cutoff.
- **Anchor suggestions:** 39 right / 0 wrong / 30 unjudged; recall lift ≤ +0.016.
- **Face-quality weight:** inconclusive (`ecd530b9` has no quality fields; ±0.01–0.03
  on the others at small n) — `FACE_QUALITY_WEIGHT` stays 0.

## Filtering votes by pipeline generation (search_version)

Votes cast **before** the current algorithm (multi-selfie §1.1, PRF §1.2, T-norm
§1.3) went live were collected on weaker results, so they carry a much higher
"not me" rate (~32% vs ~8% for face on the current pipeline) that no longer
reflects reality. Every search run now records a `SEARCH_ALGO_VERSION`, and the
api denormalizes it onto each `match_feedback` vote as `searchVersion`.

To measure only current-pipeline votes, filter the export by the version prefix:

```
~/.venvs/findme-eval/bin/python eval/export_feedback_labels.py \
  --project mmr-data-pipeline --out-dir /tmp/labels --search-version 2026.07
```

Votes with no `searchVersion` (pre-versioning) sort to `''` and are dropped by
any non-empty filter — i.e. old-pipeline votes are excluded, not silently mixed
in. Bump `SEARCH_ALGO_VERSION` (shared `schemas/findme.ts`) on any material
ranking change so a future generation is likewise separable.
