FROM python:3.12-slim

# libheif for HEIC reference uploads (same rationale as cloud-run/Dockerfile)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libheif1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Model weights are baked into the image (dev plan §9: pin model files in the
# image to avoid slow cold starts). Build with the models already fetched:
#   python scripts/fetch_models.py --dir model_files && docker build .
# OSNET_URL/YOLO_URL can also be passed as build args to fetch during build.
ARG FETCH_MODELS=0
ARG OSNET_URL=""
ARG YOLO_URL=""
COPY scripts/ scripts/
RUN if [ "$FETCH_MODELS" = "1" ]; then \
      OSNET_URL="$OSNET_URL" YOLO_URL="$YOLO_URL" python scripts/fetch_models.py --dir model_files; \
    fi
# Bake the ONNX weights into the image. The models must be present in the
# build context — deploy-matcher.sh guarantees this by syncing them from GCS
# (MODELS_GCS) before the build. A plain COPY is used deliberately: the old
# `COPY model_file[s]/` glob trick only skips-when-missing under BuildKit, and
# Cloud Build's legacy Docker builder fails it with "no source files were
# specified" even when model_files/ is present.
COPY model_files/ model_files/

COPY models/ models/
# Glob all matcher modules, not a hand-kept filename list — a curated list
# silently omits any new module that main.py starts importing, crashing only at
# runtime. Tests are kept out by .dockerignore (**/test_*.py, **/conftest.py).
COPY *.py ./

ENV PORT=8080 MODEL_DIR=/app/model_files
# 1 worker × few threads: model + event-embedding cache is per-process.
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "120", "main:app"]
