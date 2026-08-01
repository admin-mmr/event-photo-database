FROM python:3.12-slim

# libheif so a HEIC sample upload (and a HEIC mirrored original) decodes — same
# rationale as matcher/Dockerfile.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libheif1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ONE image serves both deployables: the Cloud Run *service* (gunicorn, CMD
# below) and the prepare *job* (same image, command overridden to
# `python job.py` — see infra/scripts/deploy-outfit-tagger.sh). They share every
# module and both need the encoders baked in, so a second image would only be a
# second thing to keep in sync.

# The ONNX weights + their recorded preprocessing config. Must be present in the
# build context; deploy-outfit-tagger.sh guarantees it by syncing them from GCS
# in-cloud before the build. A plain COPY, deliberately: the `COPY model_file[s]/`
# skip-when-missing glob only works under BuildKit and Cloud Build's legacy
# builder fails it outright (lesson from matcher/Dockerfile).
COPY model_files/ model_files/

# Glob every module rather than a hand-kept filename list — a curated list
# silently omits any new module and crashes only at runtime with
# ModuleNotFoundError (that has shipped once in this repo already). Tests are kept
# out by .dockerignore (**/test_*.py, **/conftest.py).
COPY *.py ./
COPY scripts/ scripts/

ENV PORT=8080 MODEL_DIR=/app/model_files
# 1 worker × few threads: the encoders and the per-event index cache are
# per-process, so extra workers would duplicate both in memory.
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "120", "main:app"]
