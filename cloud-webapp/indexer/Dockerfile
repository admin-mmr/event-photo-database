# indexer — Cloud Run Job image. Build context = cloud-webapp/ (repo subdir),
# because the job reuses the matcher's pipeline/model modules:
#
#   docker build -f indexer/Dockerfile .
#
# Model weights are baked in, same rationale as matcher/Dockerfile (fetch
# them first: cd matcher && python scripts/fetch_models.py --dir model_files).

FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libheif1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY indexer/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Matcher modules (pipeline, models, quality, store) — imported via MATCHER_DIR.
COPY matcher/models/ matcher/models/
COPY matcher/pipeline.py matcher/quality.py matcher/store.py matcher/fusion.py matcher/
COPY matcher/model_file[s]/ matcher/model_files/

COPY indexer/job.py indexer/drive.py indexer/blobs.py indexer/derivatives.py ./

ENV MATCHER_DIR=/app/matcher \
    MODEL_DIR=/app/matcher/model_files \
    DERIVATIVES_ROOT=gs://mmr-data-pipeline-derivatives

# One execution = one event: pass EVENT_ID (and optionally DRIVE_FOLDER_ID,
# FORCE_REINDEX, LIMIT) via `gcloud run jobs execute --update-env-vars`.
CMD ["python", "job.py"]
