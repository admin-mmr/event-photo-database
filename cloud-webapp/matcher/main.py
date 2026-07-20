"""
main.py — "Find Me" matcher service (Cloud Run, private).

Endpoints:
  GET  /healthz  — liveness (no model load, so cold instances answer fast)
  POST /embed    — multipart image → face + person embeddings + quality
  POST /search   — multipart image + event_id → fused per-photo ranking

Auth model: the service deploys WITHOUT --allow-unauthenticated; only
api-runtime@ holds roles/run.invoker, and Cloud Run's IAM layer verifies the
caller's ID token before requests reach this code (dev plan §2.2/§2.3).

Embeddings come from the zero-cost flat-file store (store.py); searching is
in-memory cosine similarity, event-scoped (PRD §5).
"""

from __future__ import annotations

import logging
import os

import numpy as np
from flask import Flask, jsonify, request

import fusion as fusion_mod
from pipeline import decode_image, embed_image, read_capture_time_ms
from store import EmbeddingStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("MAX_UPLOAD_BYTES", 25 * 1024 * 1024))

# Safety cap for the single-modality modes ('face' / 'person'), which have NO
# score threshold — without a cap an outfit-only search would return the entire
# event ranked by similarity. Fused mode (the default Find-Me path) is gated by
# the fusion threshold instead and is returned uncapped when no top_k is given.
UNGATED_TOP_K = int(os.environ.get("MATCHER_UNGATED_TOP_K", "500"))

# Capture-time-conditional outfit fusion (PEOPLE_RECOGNITION_QUALITY_PLAN.md
# Item 1). Off by default until swept on judged labels. When on, the person
# (outfit) weight for a candidate photo is scaled by how close its capture time
# is to the query selfie's — full within W_FULL, fading to FLOOR by W_ZERO. A
# missing capture time (query or candidate) falls back to the static weight, so
# this can never regress events/photos without EXIF times.
FUSION_TIME_CONDITIONAL = os.environ.get("FUSION_TIME_CONDITIONAL", "false").lower() == "true"
PERSON_TIME_W_FULL_MS = float(os.environ.get("PERSON_TIME_W_FULL_MIN", "45")) * 60_000
PERSON_TIME_W_ZERO_MS = float(os.environ.get("PERSON_TIME_W_ZERO_MIN", "180")) * 60_000
PERSON_TIME_FLOOR = float(os.environ.get("PERSON_TIME_FLOOR", "0.0"))

# EMBEDDINGS_ROOT: gs://<proj>-derivatives in prod; a local dir in dev/tests.
_store: EmbeddingStore | None = None


def get_store() -> EmbeddingStore:
    global _store
    if _store is None:
        root = os.environ.get("EMBEDDINGS_ROOT")
        if not root:
            raise RuntimeError("EMBEDDINGS_ROOT env var not set")
        _store = EmbeddingStore(root)
    return _store


def _read_upload():
    """Returns (rgb_array, raw_bytes, error_response). Raw bytes are handed back
    so callers can read EXIF (e.g. the capture-time anchor) without re-reading
    the request stream, which is already consumed here."""
    file = request.files.get("file")
    if file is None:
        return None, None, (jsonify({"error": "missing_file", "detail": "multipart field 'file' required"}), 400)
    data = file.read()
    try:
        img = decode_image(data)
    except Exception:
        logger.exception("image decode failed")
        return None, None, (jsonify({"error": "bad_image", "detail": "could not decode image"}), 400)
    return img, data, None


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True, "service": "matcher"})


@app.post("/embed")
def embed():
    img, _data, err = _read_upload()
    if err:
        return err
    result = embed_image(img)
    return jsonify(
        {
            "modelVersion": result["model_version"],
            "faces": [
                {
                    "box": f["box"],
                    "score": f["score"],
                    "quality": f["quality"],
                    "embedding": f["embedding"].tolist(),
                }
                for f in result["faces"]
            ],
            "persons": [
                {
                    "box": p["box"],
                    "score": p["score"],
                    "source": p["source"],
                    "faceIdx": p["face_idx"],
                    "embedding": p["embedding"].tolist(),
                }
                for p in result["persons"]
            ],
        }
    )


@app.post("/search")
def search():
    """Form fields: file (image), event_id, top_k?, mode? (fused|face|person),
    w_face?, w_person?. Returns the per-photo ranking for the event."""
    event_id = request.form.get("event_id", "").strip()
    if not event_id:
        return jsonify({"error": "missing_event_id"}), 400
    mode = request.form.get("mode", "fused")
    if mode not in ("fused", "face", "person"):
        return jsonify({"error": "bad_mode"}), 400
    # top_k is optional. Omitted (or <= 0) means "no cap": fused results are
    # bounded by the fusion score threshold, so everyone who appears in more
    # than the old 50/200 photos now gets all of their matches back.
    raw_top_k = request.form.get("top_k")
    top_k = int(raw_top_k) if raw_top_k not in (None, "") else None
    if top_k is not None and top_k <= 0:
        top_k = None
    # The single-modality modes have no quality gate, so cap their candidate
    # retrieval even when uncapped overall; fused retrieves everything and lets
    # the threshold decide.
    retrieve_k = None if mode == "fused" else (top_k if top_k is not None else UNGATED_TOP_K)

    img, data, err = _read_upload()
    if err:
        return err

    anchor_ms = read_capture_time_ms(data) if FUSION_TIME_CONDITIONAL else None
    result = embed_image(img)
    usable_faces = [f for f in result["faces"] if f["quality"]["usable"]]
    if not usable_faces and mode != "person":
        return (
            jsonify(
                {
                    "error": "no_usable_face",
                    "faces": [{"box": f["box"], "quality": f["quality"]} for f in result["faces"]],
                }
            ),
            422,
        )

    # Query = most confident usable face and its associated person crop.
    query_face = max(usable_faces, key=lambda f: f["score"]) if usable_faces else None
    query_person = None
    if result["persons"]:
        if query_face is not None:
            qf_idx = result["faces"].index(query_face)
            query_person = next(
                (p for p in result["persons"] if p["face_idx"] == qf_idx), None
            )
        if query_person is None:
            query_person = max(result["persons"], key=lambda p: p["score"])

    try:
        event = get_store().load_event(event_id)
    except FileNotFoundError:
        return jsonify({"error": "event_not_indexed", "eventId": event_id}), 404

    face_hits = (
        event.top_photos("face", query_face["embedding"], k=retrieve_k)
        if query_face is not None and mode in ("fused", "face")
        else []
    )
    person_hits = (
        event.top_photos("person", query_person["embedding"], k=retrieve_k)
        if query_person is not None and mode in ("fused", "person")
        else []
    )

    if mode == "face":
        ranked = [{"photoId": h["photoId"], "score": h["score"], "faceScore": h["score"], "personScore": None} for h in face_hits]
    elif mode == "person":
        ranked = [{"photoId": h["photoId"], "score": h["score"], "faceScore": None, "personScore": h["score"]} for h in person_hits]
    else:
        w_person = float(request.form.get("w_person", fusion_mod.DEFAULT_PERSON_WEIGHT))
        # Capture-time-conditional outfit weight: scale w_person per candidate by
        # how close its capture time is to the query selfie's. Only engages when
        # the flag is on AND the query has a parseable capture time; a candidate
        # with no takenAt decays to 1.0 (static weight) inside time_decay.
        person_weight_fn = None
        if FUSION_TIME_CONDITIONAL and anchor_ms is not None:
            photo_time = {
                pid: event.taken_at_ms(pid)
                for pid in {h["photoId"] for h in (*face_hits, *person_hits)}
            }

            def person_weight_fn(pid, _w=w_person):  # noqa: E731 - closure over anchor/config
                t = photo_time.get(pid)
                return _w * fusion_mod.time_decay(
                    None if t is None else (t - anchor_ms),
                    PERSON_TIME_W_FULL_MS,
                    PERSON_TIME_W_ZERO_MS,
                    PERSON_TIME_FLOOR,
                )

        ranked = fusion_mod.fuse(
            face_hits,
            person_hits,
            w_face=float(request.form.get("w_face", fusion_mod.DEFAULT_FACE_WEIGHT)),
            w_person=w_person,
            top_k=top_k,
            person_weight_fn=person_weight_fn,
        )

    return jsonify(
        {
            "eventId": event_id,
            "mode": mode,
            "modelVersion": result["model_version"],
            "indexModelVersion": event.manifest.get("modelVersion"),
            "results": ranked if top_k is None else ranked[:top_k],
        }
    )


if __name__ == "__main__":  # local dev only; Cloud Run uses gunicorn (Dockerfile)
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8081)), debug=True)
