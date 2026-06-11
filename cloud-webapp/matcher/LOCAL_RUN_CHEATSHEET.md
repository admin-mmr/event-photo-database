# Matcher — local run cheatsheet (M0)

All commands use `python3`, run from `cloud-webapp/matcher/`.

## One-time setup

```bash
cd cloud-webapp/matcher
python3 -m venv .venv
source .venv/bin/activate            # then python3 = the venv's python
python3 -m pip install -r requirements.txt -r requirements-test.txt

# Model files (~300 MB, gitignored). buffalo_l downloads automatically;
# OSNet needs a one-time ONNX export or a trusted URL — see scripts/fetch_models.py.
python3 scripts/fetch_models.py --dir model_files
export MODEL_DIR=$PWD/model_files
```

Every new shell: `cd cloud-webapp/matcher && source .venv/bin/activate && export MODEL_DIR=$PWD/model_files`

## Tests

```bash
python3 -m pytest -v        # green without model files (real-model tests self-skip)
```

## M0 spike workflow

```bash
# 1. Pull ~500 sample photos from a Drive event folder (keyless DWD, needs gcloud login)
python3 scripts/sample_drive_folder.py <EVENT_FOLDER_ID> --out ~/event-sample-photos --n 500

# 2. Embed them into a local store
python3 scripts/embed_folder.py ~/event-sample-photos --event-id ev_sample --out ./local_store

# 3. Label: generates label_sheet.html inside the photos folder — open in a
#    browser, tick people, "Download labels.csv", save as eval/labels.csv
python3 eval/make_label_sheet.py ~/event-sample-photos --people alice,bob

# 4. Reference selfies → eval/queries/<person>/  (see eval/queries/README.md)

# 5. Evaluate (M0 gate: best fusion Precision@20 ≥ 0.8)
python3 eval/run_eval.py --store ./local_store --event-id ev_sample \
    --labels eval/labels.csv --queries eval/queries --k 20 --report eval/report.json
```

## Run the service locally

```bash
EMBEDDINGS_ROOT=./local_store python3 main.py     # serves on :8081

curl localhost:8081/healthz
curl -F file=@selfie.jpg localhost:8081/embed
curl -F file=@selfie.jpg -F event_id=ev_sample localhost:8081/search
curl -F file=@selfie.jpg -F event_id=ev_sample -F mode=face -F top_k=20 \
     -F w_face=0.7 -F w_person=0.3 localhost:8081/search
```

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `MODEL_DIR` | `./model_files` | ONNX model files location |
| `EMBEDDINGS_ROOT` | (required for /search) | local store dir, or `gs://mmr-data-pipeline-derivatives` |
| `MODEL_VERSION` | `scrfd10g+arcface_r50+osnet_x0_25@m0` | tag written to manifests |
| `MAX_UPLOAD_BYTES` | 25 MB | upload size cap |
| `DWD_SA` / `DWD_SUBJECT` | indexer-runtime@… / admin@mmrunners.org | Drive sample puller auth |

## Common errors

- `Required model file missing` → run `python3 scripts/fetch_models.py`, check `MODEL_DIR`.
- `event_not_indexed` (404) → run `scripts/embed_folder.py` for that event id, check `EMBEDDINGS_ROOT`.
- `no_usable_face` (422) → reference photo is blurry/small/faceless (thresholds in quality.py).
- Drive puller 403 → `gcloud auth login`; needs `roles/iam.serviceAccountTokenCreator` on indexer-runtime@; fresh DWD grants take up to 1h to propagate.
- HEIC photos don't show in label sheet → browsers can't render HEIC; convert to JPG first.
