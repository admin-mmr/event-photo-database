# outfit-tagger

Finds the photos in an event that show a particular **outfit or accessory**, given
**sample crops** and/or a **text description**.

This is a separate service from the Find-Me matcher — separate Cloud Run
deployment, separate URL, separate Docker build context, separate vector store.
It exists so that "find the runner in the orange singlet" can be built and
iterated on without any risk to face search.

---

## What it can and can't do

| Query | How well it works |
|---|---|
| A few tight sample crops of the garment/accessory | **Strong.** This is the modality that carries the signal. |
| Coarse text: "orange singlet", "yellow visor", "pink shorts" | **Usable.** Colour + garment type is what the text tower knows. |
| Fine-grained gear text: "open-ear headphones", "bone conduction", a brand name | **Weak.** Those words barely occur in the training captions. `/detect` returns a `textAdvisory` when it sees one — supply samples instead. |

Two more limits worth stating plainly:

- **Scale decides visibility.** An outfit fills a person crop; an accessory at the
  ear does not. That is why every photo is embedded twice — once as a `person`
  crop, once as a tighter `head` crop expanded from the face box. Accessory
  queries should use `region=head`.
- **This is a shortlist, not an identity.** Scores are z-scores against the
  event's own crops, there is no default threshold, and "wears the same kit as
  the sample" is true of everyone wearing that kit. Use it to narrow a set for a
  human to look at; never to auto-confirm who someone is.

## How it works

```
indexer (already ran)                        outfit-tagger
─────────────────────                        ─────────────
<eventId>/embeddings/manifest.json  ──┐
  person boxes (YOLO)                 │   job.py: cut each box out of the
  face boxes (SCRFD)                  ├──▶ original, embed with SigLIP, write
<eventId>/photos/orig/<photoId>.<ext> ┘    <eventId>/outfit/{crops.npy,index.json}

                                          main.py: /detect scores that store
                                          against a sample prototype and/or a
                                          text embedding, z-scored and blended
```

**No detector runs here.** Boxes come from the manifest the indexer already
wrote, so this service adds no detection compute and reads only immutable
artifacts of a completed index run. It writes exclusively under `<eventId>/outfit/`.

Crops are cut from the **mirrored original**, not the ≤1600px `web` derivative:
manifest boxes are in original-image coordinates and the manifest records no
original dimensions, so there is no sound way to rescale them onto a web copy —
and downscaling is exactly what destroys the ear-region detail a `head` crop
exists to capture.

### The two modalities are normalized differently, and that matters

Image↔image cosines land around 0.5–0.9; image↔text cosines for a *correct*
description land around 0.05–0.15. A raw weighted sum is therefore almost entirely
the sample term, and `text_weight` would not mean what it says. So both sides are
mapped onto a common "std above background" scale — but not the same way:

- **Samples → cohort z-score.** Query and crops come from the same distribution,
  so test-normalizing against the event's own crops is sound (the transform the
  matcher already applies).
- **Text → calibration against a query-independent background.** *Not* a cohort
  z-score. Dividing by the per-query std removes exactly the relevance signal: an
  out-of-domain prompt is uniformly dissimilar to every crop, so its spread is tiny
  and noise becomes a large z, while a relevant prompt is broadly similar to all
  runner crops and its best hit sits fewer std above a higher mean. Text is instead
  scaled by the mean/std of the (background-prompt × crop) cosine population for
  the event — statistics that don't depend on the query.

**This was a real, shipped bug, caught by absurd-prompt controls** on event
`2622d5ab` (2,589 crops/region). Mean max score, plausible vs absurd prompts:

| | plausible | absurd control | |
|---|---|---|---|
| cohort z-score (before) | +3.36 | **+4.41** | inverted |
| calibrated (after) | **+3.20** | +1.04 | ~3× separation |

Because a z-score is affine it never reordered results *within* a query; what it
corrupted was magnitude — which is what `text_weight` and any threshold consume.
`test_scoring.py::test_fixed_scaling_preserves_cross_query_separation` pins the
corrected behaviour and asserts the old one is not restored.

## Files

| File | Role |
|---|---|
| `main.py` | Flask service: `/healthz`, `/status`, `/detect` |
| `job.py` | Cloud Run **Job**: prepare one event (one execution = one event) |
| `siglip.py` | ONNX vision + text towers; preprocessing read from recorded config |
| `crops.py` | Which regions to embed and how to cut them |
| `scoring.py` | Prototype building, per-modality z-scoring, fusion, per-photo ranking |
| `store.py` | `<eventId>/outfit/` vector store + blob IO (local / GCS / Azure) |
| `images.py` | Decode bytes → RGB, with EXIF transpose and a bomb guard |
| `scripts/export_siglip.py` | Export the towers **and verify them** (see below) |

## Setup

### 1. Export the model (once per model change)

```bash
pip install torch transformers sentencepiece onnx onnxruntime onnxscript
python scripts/export_siglip.py --dir model_files
```

**The `.onnx` files are not self-contained.** torch's exporter writes the weights
to sibling `siglip_*.onnx.data` files (~110 KB of graph + ~780 MB of weights), and
onnxruntime resolves them by path relative to the `.onnx`. Always move
`model_files/` as a whole — copying just `*.onnx` yields a load error at runtime.

This writes the two `.onnx` towers, the SentencePiece model, and — importantly —
`vision_config.json` / `text_config.json` recording the processor's real
preprocessing values. The runtime reads those instead of hardcoding constants,
because a wrong normalization or pad id produces embeddings that are confidently
wrong and raise nothing. The script refuses to finish unless:

1. our tokenizer produces byte-identical ids to the `transformers` tokenizer,
2. each exported graph has exactly ONE output of rank 2, and
3. the ONNX towers match the torch model to a cosine of ≥ 0.999.

Do not hand-assemble `model_files/`. Check (2) exists because it already caught a
real bug: in transformers 5.x `get_image_features` returns a
`BaseModelOutputWithPooling` rather than a tensor, and exporting that object
flattens it into **two** graph outputs with `last_hidden_state` first — so the
runtime, which reads `outputs[0]`, would have embedded a `[batch, 196, 768]`
patch-token tensor instead of the pooled vector. It loads, runs, raises nothing,
and ranks garbage. The towers now return `.pooler_output` explicitly.

### 2. Stage and deploy

```bash
gcloud storage cp -r model_files gs://<project-id>-models/outfit/
./infra/scripts/deploy-outfit-tagger.sh <project-id>
```

The staged path must end in `model_files` (hence the `outfit/` prefix): Cloud Build
pulls it with `cp -r`, which names the directory after the last path segment, and
the Dockerfile then does `COPY model_files/`.

The script deploys the service (private, `min-instances=0`) and the prepare job
from one image, and prints the remaining one-time IAM + `OUTFIT_URL` steps.

### 3. Prepare an event

```bash
gcloud run jobs execute outfit-prepare --region=us-central1 --project=<project-id> --update-env-vars=EVENT_ID=<eventId>
```

Re-runs are idempotent and skip an event already prepared under the same model +
source-manifest versions. `FORCE=1` re-embeds anyway; `LIMIT=N` caps photos.

## Local development

```bash
pip install -r requirements.txt -r requirements-test.txt
pytest
```

The tests stub the encoders, so they need only `numpy`, `Pillow`, `flask`, and
`pytest` — no model files and no ONNX. To run the service against a local store:

```bash
EMBEDDINGS_ROOT=./local_store MODEL_DIR=./model_files python main.py
```

## API

`GET /status?event_id=<id>` → `{prepared, crops, regions, photos, modelVersion, sourceModelVersion, skipped}`

`POST /detect` (multipart/form-data)

| Field | Meaning |
|---|---|
| `event_id` | required |
| `file` | 0..8 sample images, embedded **whole** — crop them tight |
| `sample_photo_ids` | event photoIds whose stored crops are reused (no inference, better framing) |
| `text` | description |
| `text_weight` | share of the fused score from text (default 0.35) |
| `region` | `person` \| `head` \| `auto` (default) |
| `top_k`, `min_score` | cap and optional z-score cutoff |
| `include_small` | include crops flagged too small to be meaningful |

Returns `{results: [{photoId, score, region, box, sampleScore, textScore}], cohortSize, scoreUnit: "zscore", …}`.

Reached through the api as `GET/POST /api/admin/outfit/:eventId/{status,detect}`
(super-admin only — an event-wide query is cross-club by nature). With
`OUTFIT_URL` unset those routes 503 and nothing else in the api changes.

## Operational notes

- **`min-instances=0`**, per the zero-idle-cost policy. First query after idle
  pays a model-load cold start.
- **The prepare pass is a Job, not an endpoint.** A 1,600-photo event is ~3,000
  crops — minutes of CPU-ONNX work, far past the 60s Hosting/Cloud Run request
  ceiling that has bitten three other features in this repo.
- **Changing weights changes the embedding space.** Bump `OUTFIT_MODEL_VERSION`
  and re-prepare every event; `/detect` refuses a version mismatch with `409`
  rather than ranking across two spaces.
- **Not yet swept on judged labels.** There is deliberately no default
  `min_score`: per the guardrails in `PEOPLE_RECOGNITION_QUALITY_PLAN.md`, a
  number should not gate anything before an offline sweep says where it belongs.
