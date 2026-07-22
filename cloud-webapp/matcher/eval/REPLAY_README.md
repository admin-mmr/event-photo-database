# Replay tuning — T-norm threshold + PRF lift (§1.2 / §1.3)

Once Find Me has real "That's me / Not me" votes, replay a past event to (a) pick
`MATCHER_NORM_THRESHOLD` for T-norm and (b) confirm PRF actually lifts recall,
**before** enabling `FINDME_TNORM` in prod.

Baseline to beat, from the raw votes (no replay): the biggest event
`81a584f7-b9e8-4f18-9744-8002693364ba` sits at judged **P@20 = 0.684**
(1,713 pairs / 99 users). Check current numbers any time with:

```
~/.venvs/findme-eval/bin/python eval/export_feedback_labels.py --project mmr-data-pipeline --out-dir /tmp/labels
```

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
./infra/scripts/run-replay-job.sh mmr-data-pipeline 81a584f7-b9e8-4f18-9744-8002693364ba
```

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

## Reading the result → setting the threshold

`--tnorm` prints, at the best fusion weights, fused P@K raw-vs-normalized and a
precision/recall-vs-threshold sweep for each. **Pick the `tnorm` row that beats
0.684 precision with the highest recall** — its threshold is `MATCHER_NORM_THRESHOLD`.
`--prf` prints base vs +PRF recall@k and the lift.

Then, only if T-norm wins: set `MATCHER_NORM_THRESHOLD` on the matcher and
`FINDME_TNORM=1` on the api, and redeploy. Leave off if it doesn't beat baseline.

> Tip: you just asked members to vote — let the labeled set grow for a week or
> two, then replay, so the threshold is tuned on more than today's votes.

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
