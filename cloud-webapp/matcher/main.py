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

# T-norm cohort score normalization (PEOPLE_RECOGNITION_QUALITY_PLAN.md Item 2).
# Off by default until swept. When on, subtract TNORM_ALPHA × (query's mean face
# similarity to the whole event) from each face score before fusion, so a
# generically-similar ("looks like everyone") query must clear a higher bar
# while a distinctive one is unaffected. Enabling it shifts the score scale, so
# the fused threshold must be re-tuned in the same sweep (per the guardrails).
FUSION_TNORM = os.environ.get("FUSION_TNORM", "false").lower() == "true"
TNORM_ALPHA = float(os.environ.get("TNORM_ALPHA", "1.0"))

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


def _mean_unit(embs: list) -> "np.ndarray | None":
    """L2-normalize each embedding, then average into a query centroid (Item 3
    multi-reference / PRF). Per-ref normalization keeps one large-norm reference
    from dominating. None for an empty list. The store re-normalizes the query,
    so the returned mean need not be unit-length."""
    if not embs:
        return None
    arr = np.stack([np.asarray(e, dtype=np.float32).reshape(-1) for e in embs])
    arr = arr / np.maximum(np.linalg.norm(arr, axis=1, keepdims=True), 1e-12)
    return arr.mean(axis=0)


def _select_prf_face(embs: list, centroid) -> "np.ndarray | None":
    """Pick the ONE face embedding from a confirmed photo to fold into the query
    (Item 3 PRF). A confirmed photo may be a group shot, so folding every face
    would pollute the centroid with bystanders. With a selfie centroid, choose
    the face most similar to it (the confirming user's). Without a centroid, only
    a lone face is unambiguous — multi-face photos return None (skip) rather than
    guess."""
    if not embs:
        return None
    if len(embs) == 1:
        return embs[0]
    if centroid is None:
        return None
    c = np.asarray(centroid, dtype=np.float32).reshape(-1)
    c = c / max(np.linalg.norm(c), 1e-12)

    def _sim(e) -> float:
        e = np.asarray(e, dtype=np.float32).reshape(-1)
        return float(np.dot(e / max(np.linalg.norm(e), 1e-12), c))

    return max(embs, key=_sim)


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

    # Multi-reference query (Item 3): embed every uploaded selfie, keep each
    # one's most-confident usable face + its associated person crop, and average
    # them into a query centroid — averaging out pose/blur in any single shot.
    # Single-file uploads (the common case) fall through as a centroid-of-one,
    # identical to the previous behavior.
    files = request.files.getlist("file")
    if not files:
        return jsonify({"error": "missing_file", "detail": "multipart field 'file' required"}), 400

    face_refs, person_refs = [], []
    all_faces_seen = []  # only for the no_usable_face diagnostic
    anchor_ms = None
    query_model_version = None
    for f in files:
        try:
            fdata = f.read()
            img = decode_image(fdata)
        except Exception:
            logger.exception("image decode failed")
            return jsonify({"error": "bad_image", "detail": "could not decode image"}), 400
        if anchor_ms is None and FUSION_TIME_CONDITIONAL:
            anchor_ms = read_capture_time_ms(fdata)
        res = embed_image(img)
        query_model_version = res["model_version"]
        all_faces_seen.extend(res["faces"])
        usable = [x for x in res["faces"] if x["quality"]["usable"]]
        qf = max(usable, key=lambda x: x["score"]) if usable else None
        if qf is not None:
            face_refs.append(qf["embedding"])
        qp = None
        if res["persons"]:
            if qf is not None:
                qf_idx = res["faces"].index(qf)
                qp = next((p for p in res["persons"] if p["face_idx"] == qf_idx), None)
            if qp is None:
                qp = max(res["persons"], key=lambda p: p["score"])
        if qp is not None:
            person_refs.append(qp["embedding"])

    try:
        event = get_store().load_event(event_id)
    except FileNotFoundError:
        return jsonify({"error": "event_not_indexed", "eventId": event_id}), 404

    # Pseudo-relevance feedback (Item 3): fold confirmed photos' faces into the
    # query centroid — clean, in-domain references that sharpen recall. A
    # confirmed photo may be a GROUP photo, so fold only the confirming user's
    # face (the one matching the selfie centroid), never every face in it.
    selfie_centroid = _mean_unit(face_refs)
    prf_used, prf_skipped = 0, 0
    for pid in (s.strip() for s in request.form.get("confirm_photo_ids", "").split(",")):
        if not pid:
            continue
        embs = event.embeddings_for_photo("face", pid)
        if not embs:
            continue
        chosen = _select_prf_face(embs, selfie_centroid)
        if chosen is None:  # multi-face photo with no anchor to disambiguate
            prf_skipped += 1
            continue
        face_refs.append(chosen)
        prf_used += 1

    if not face_refs and mode != "person":
        return (
            jsonify(
                {
                    "error": "no_usable_face",
                    "faces": [{"box": f["box"], "quality": f["quality"]} for f in all_faces_seen],
                }
            ),
            422,
        )

    face_query = _mean_unit(face_refs)
    person_query = _mean_unit(person_refs)

    face_hits = (
        event.top_photos("face", face_query, k=retrieve_k)
        if face_query is not None and mode in ("fused", "face")
        else []
    )
    person_hits = (
        event.top_photos("person", person_query, k=retrieve_k)
        if person_query is not None and mode in ("fused", "person")
        else []
    )

    if mode == "face":
        ranked = [{"photoId": h["photoId"], "score": h["score"], "faceScore": h["score"], "personScore": None} for h in face_hits]
    elif mode == "person":
        ranked = [{"photoId": h["photoId"], "score": h["score"], "faceScore": None, "personScore": h["score"]} for h in person_hits]
    else:
        # T-norm (Item 2): shift face scores down by the query's cohort mean so
        # a non-distinctive face doesn't ride a uniformly-high similarity into
        # false positives. In-place on the local hit list; preserves the pre-norm
        # value as rawFaceScore for eval. No-op when the event has no faces.
        if FUSION_TNORM and face_query is not None and face_hits:
            mu, _sigma, n = event.cohort_stats("face", face_query)
            if n > 0:
                for h in face_hits:
                    h["rawFaceScore"] = h["score"]
                    h["score"] = h["score"] - TNORM_ALPHA * mu

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
            "modelVersion": query_model_version,
            "indexModelVersion": event.manifest.get("modelVersion"),
            # Query provenance (Item 3): how many selfie references and confirmed
            # (PRF) photos went into the centroid — surfaced for eval/debug.
            # prfSkipped = confirmed group photos we couldn't disambiguate.
            "queryRefs": len(face_refs),
            "prfRefs": prf_used,
            "prfSkipped": prf_skipped,
            "results": ranked if top_k is None else ranked[:top_k],
        }
    )


if __name__ == "__main__":  # local dev only; Cloud Run uses gunicorn (Dockerfile)
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8081)), debug=True)
