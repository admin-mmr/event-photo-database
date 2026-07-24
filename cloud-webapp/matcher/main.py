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

# Fused-score cutoff to use when T-norm (§1.3) is on. T-normed scores are
# z-scores against the event cohort, not raw cosines, so the raw-cosine
# DEFAULT_THRESHOLD (0.25) does not apply — a match now sits several std above
# the cohort mean. Default 4.0 is eval-derived: the 2026-07-23 judged sweep on
# event 81a584f7 (91 users / 1516 pairs) put judged precision ≈0.93 at a z-score
# of ~4 (and ≈1.0 on the smaller event 34f3e38f at ~3), so 4.0 is the
# precision-first operating point (guardrails: precision-first while data
# accumulates). It is a GLOBAL default over two events — revisit per-event once
# more events clear the evidence bar (PEOPLE_RECOGNITION_QUALITY_PLAN.md Item 8).
# Now on by default via the api's FINDME_TNORM=1; override the env to retune.
NORM_THRESHOLD = float(os.environ.get("MATCHER_NORM_THRESHOLD", "4.0"))

# Capture-time-conditional outfit fusion. Off by default until swept on judged
# labels. When on, the person (outfit) weight for a candidate photo is scaled by
# how close its capture time is to the query selfie's — full within W_FULL,
# fading to FLOOR by W_ZERO. A missing capture time (query selfie has no EXIF
# DateTimeOriginal, or a candidate has no manifest takenAt) falls back to the
# static weight, so this can never regress events/photos without capture times.
# Anchor = the FIRST uploaded selfie's EXIF; candidate = manifest `photos` map,
# already written by the indexer, so no re-index is required. Fused mode only.
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
    """Returns (rgb_array, error_response)."""
    file = request.files.get("file")
    if file is None:
        return None, (jsonify({"error": "missing_file", "detail": "multipart field 'file' required"}), 400)
    try:
        img = decode_image(file.read())
    except Exception:
        logger.exception("image decode failed")
        return None, (jsonify({"error": "bad_image", "detail": "could not decode image"}), 400)
    return img, None


def _mean_unit(vectors: list[np.ndarray]) -> np.ndarray | None:
    """Centroid of L2-normalized vectors, itself L2-normalized (§1.1).

    Averaging unit embeddings and renormalizing is the standard multi-reference
    query: it cancels the pose/blur noise present in any single shot while
    keeping the result on the unit sphere so cosine == dot still holds. Returns
    None for an empty input (or a degenerate centroid at the origin)."""
    if not vectors:
        return None
    mat = np.stack([np.asarray(v, dtype=np.float32).reshape(-1) for v in vectors])
    mat = mat / np.maximum(np.linalg.norm(mat, axis=1, keepdims=True), 1e-12)
    centroid = mat.mean(axis=0)
    norm = float(np.linalg.norm(centroid))
    if norm < 1e-12:
        return None
    return (centroid / norm).astype(np.float32)


def _select_reference(result: dict) -> tuple[np.ndarray | None, np.ndarray | None, list[dict]]:
    """Pick one query face + its person crop from ONE reference image.

    A reference image may contain bystanders, so we take only the most confident
    *usable* face (not a centroid over the image — that would blend identities)
    and the person crop associated with it. Returns
    (face_embedding | None, person_embedding | None, faces_diag) where
    faces_diag is the per-face quality report used for the no_usable_face 422."""
    faces_diag = [{"box": f["box"], "quality": f["quality"]} for f in result["faces"]]
    usable = [f for f in result["faces"] if f["quality"]["usable"]]
    face = max(usable, key=lambda f: f["score"]) if usable else None

    person = None
    if result["persons"]:
        if face is not None:
            f_idx = result["faces"].index(face)
            person = next((p for p in result["persons"] if p["face_idx"] == f_idx), None)
        if person is None:
            person = max(result["persons"], key=lambda p: p["score"])

    return (
        face["embedding"] if face is not None else None,
        person["embedding"] if person is not None else None,
        faces_diag,
    )


def _fold_prf(event, kind: str, prf_ids: list[str], refs: list[np.ndarray], centroid):
    """Fold confirmed photos' own embeddings into the query centroid (§1.2).

    For each confirmed photoId, take the crop of `kind` most similar to the
    current centroid — a confirmed photo can contain other people, so we never
    blindly fold every crop — append it to `refs`, and return the recomputed
    centroid. No-op (returns `centroid` unchanged) if there is no centroid yet
    or nothing to fold."""
    if centroid is None or not prf_ids:
        return centroid
    for pid in prf_ids:
        crops = event.embeddings_for_photo(kind, pid)
        if crops.shape[0] == 0:
            continue
        best = crops[int(np.argmax(crops @ centroid))]
        refs.append(best)
    return _mean_unit(refs)


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True, "service": "matcher"})


@app.post("/embed")
def embed():
    img, err = _read_upload()
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
    """Form fields: file (image; may repeat for multiple reference selfies —
    §1.1), event_id, top_k?, mode? (fused|face|person), w_face?, w_person?,
    prf_photo_ids? (comma-separated photoIds the user confirmed — §1.2),
    normalize? (1/true to T-norm scores — §1.3). Returns the per-photo ranking
    for the event."""
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
    normalize = request.form.get("normalize", "").strip().lower() in ("1", "true", "yes")
    prf_ids = [p.strip() for p in request.form.get("prf_photo_ids", "").split(",") if p.strip()]

    files = request.files.getlist("file")
    if not files:
        return jsonify({"error": "missing_file", "detail": "multipart field 'file' required"}), 400

    # Embed every reference image and keep one query face + person crop each; the
    # centroid over several selfies is a stronger, less pose-sensitive query.
    face_refs: list[np.ndarray] = []
    person_refs: list[np.ndarray] = []
    faces_diag: list[dict] = []
    model_version = None
    anchor_ms: int | None = None
    for i, file in enumerate(files):
        data = file.read()
        # Capture-time anchor = the first selfie's EXIF (only read when the flag
        # is on). Multiple selfies of one search are assumed near-simultaneous,
        # so the first is a fine anchor for all of them.
        if i == 0 and FUSION_TIME_CONDITIONAL:
            anchor_ms = read_capture_time_ms(data)
        try:
            img = decode_image(data)
        except Exception:
            logger.exception("image decode failed")
            return jsonify({"error": "bad_image", "detail": "could not decode image"}), 400
        result = embed_image(img)
        model_version = result["model_version"]
        face_emb, person_emb, diag = _select_reference(result)
        faces_diag.extend(diag)
        if face_emb is not None:
            face_refs.append(face_emb)
        if person_emb is not None:
            person_refs.append(person_emb)

    if not face_refs and mode != "person":
        return jsonify({"error": "no_usable_face", "faces": faces_diag}), 422

    try:
        event = get_store().load_event(event_id)
    except FileNotFoundError:
        return jsonify({"error": "event_not_indexed", "eventId": event_id}), 404

    # Build the query centroids, then fold in confirmed photos (PRF). PRF picks
    # the crop in each confirmed photo closest to the current centroid, so it
    # needs the centroid built from the uploaded selfies first.
    face_query = _mean_unit(face_refs)
    person_query = _mean_unit(person_refs)
    if prf_ids:
        face_query = _fold_prf(event, "face", prf_ids, face_refs, face_query)
        person_query = _fold_prf(event, "person", prf_ids, person_refs, person_query)

    face_hits = (
        event.top_photos("face", face_query, k=retrieve_k, tnorm=normalize)
        if face_query is not None and mode in ("fused", "face")
        else []
    )
    person_hits = (
        event.top_photos("person", person_query, k=retrieve_k, tnorm=normalize)
        if person_query is not None and mode in ("fused", "person")
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

            def person_weight_fn(pid, _w=w_person):  # closure over anchor/config
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
            threshold=NORM_THRESHOLD if normalize else fusion_mod.DEFAULT_THRESHOLD,
            top_k=top_k,
            person_weight_fn=person_weight_fn,
        )

    return jsonify(
        {
            "eventId": event_id,
            "mode": mode,
            "modelVersion": model_version,
            "indexModelVersion": event.manifest.get("modelVersion"),
            "normalized": normalize,
            "numReferences": len(files),
            "numPrfPhotos": len(prf_ids),
            "results": ranked if top_k is None else ranked[:top_k],
        }
    )


if __name__ == "__main__":  # local dev only; Cloud Run uses gunicorn (Dockerfile)
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8081)), debug=True)
