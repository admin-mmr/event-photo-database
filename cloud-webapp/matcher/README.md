# matcher/ — "Find Me" face + person matching service (M0 spike)

Python Cloud Run service implementing dev plan M0 (`FACE_MATCHING_DEV_PLAN.md` §5):
face embeddings (SCRFD + ArcFace, InsightFace buffalo_l ONNX), person/outfit
embeddings (OSNet ReID), the zero-cost flat-file vector store on GCS, and the
Precision@K eval harness.

## Layout

```
main.py              Flask app: /healthz, /embed, /search
pipeline.py          image → faces + persons embeddings (shared with future indexer)
store.py             flat-file embedding store (local dir or gs://) + cosine top-k
fusion.py            face+outfit score fusion (reference impl for api's fusion.ts)
quality.py           reference-photo quality checks (no-face / small / blurry)
models/              ONNX wrappers: scrfd.py, arcface.py, person.py, registry.py
scripts/fetch_models.py   download model files → model_files/
scripts/embed_folder.py   M0 indexer stand-in: photos dir → embeddings store
eval/run_eval.py     M0.3 harness: Precision@20 / Recall / FP, fusion-weight sweep
test_main.py         pytest suite (fake models — no weights needed in CI)
```

## M0 quickstart

```bash
cd cloud-webapp/matcher
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -r requirements-test.txt
pytest -v                                  # should be green without models

# 1. Models (~300 MB). OSNet needs a one-time ONNX export — see fetch_models.py.
python scripts/fetch_models.py --dir model_files
export MODEL_DIR=$PWD/model_files

# 2. Index a sample of real event photos (M0.1/M0.2, target ~500)
python scripts/embed_folder.py ~/event-sample-photos --event-id ev_sample --out ./local_store

# 3. Label + evaluate (M0.3). Copy eval/labels.example.csv → eval/labels.csv,
#    label ~10 known attendees; put reference selfies in eval/queries/<person>/.
python eval/run_eval.py --store ./local_store --event-id ev_sample \
    --labels eval/labels.csv --queries eval/queries --report eval/report.json

# 4. Run the service locally
EMBEDDINGS_ROOT=./local_store python main.py
curl -F file=@selfie.jpg -F event_id=ev_sample localhost:8081/search
```

**M0 gate (go/no-go):** best fusion Precision@20 ≥ 0.8 on the labeled sample.

## Notes

- **Person detector is optional.** Without `yolov8n.onnx`, person crops come
  from face-box expansion — fine for fused scoring, but outfit-only recall on
  back-of-head shots needs the real detector. Get one before trusting the
  outfit-only eval numbers.
- **Env vars:** `MODEL_DIR`, `EMBEDDINGS_ROOT` (`gs://mmr-data-pipeline-derivatives`
  in prod, local dir in dev), `MODEL_VERSION`, `MAX_UPLOAD_BYTES`.
- **Deploy (M2):** private Cloud Run, `--service-account matcher-runtime@…`,
  no `--allow-unauthenticated`; only api-runtime gets `roles/run.invoker`.
  `infra/scripts/deploy-matcher.sh` lands with M2 per the dev plan.
- Store layout + cosine search replace the original pgvector design — see the
  decision banner in `FACE_MATCHING_DEV_PLAN.md` and runbook Phase F.
