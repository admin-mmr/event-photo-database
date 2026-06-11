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
COPY model_file[s]/ model_files/

COPY models/ models/
COPY main.py pipeline.py store.py fusion.py quality.py ./

ENV PORT=8080 MODEL_DIR=/app/model_files
# 1 worker × few threads: model + event-embedding cache is per-process.
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "120", "main:app"]
