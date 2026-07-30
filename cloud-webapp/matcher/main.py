"""
main.py — "Find Me" matcher service (Cloud Run, private).

Endpoints:
  GET  /healthz  — liveness (no model load, so cold instances answer fast)
  POST /quality  — multipart image(s) → per-selfie quality verdict (detect only)
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
import quality
from pipeline import assess_faces, decode_image, embed_image, face_in_person, read_capture_time_ms
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

# ── Anchor promotion (in-domain re-query) ────────────────────────────────────
# A selfie is out of domain: different camera, lighting, distance, and — for the
# outfit half of the query — often different clothes than the event. Once a
# search has found the person, one of the event's OWN photos of them is a better
# reference on both counts, so `/search` reports the most suitable result as
# `anchorSuggestion` and accepts it back as `anchor_photo_ids` on the next call.
# Nothing is re-embedded: the anchor's crops are already rows in the store.
#
# Suggestion is diagnostic-only (the caller decides whether to offer it), so it
# is on by default; applying an anchor is always explicit.
ANCHOR_SUGGEST = os.environ.get("ANCHOR_SUGGEST", "true").lower() == "true"
# How far down the result list to look for an anchor. The suggestion must be a
# photo the caller actually received, so this is an index into the response.
ANCHOR_CANDIDATE_POOL = int(os.environ.get("ANCHOR_CANDIDATE_POOL", "40"))
# Gates. A crowd shot's matched crop can be a bystander who merely scores well,
# so an anchor must be a near-solo photo with a confident, front-facing, decently
# sized face. Frontality/face_frac only exist on manifests written after the
# indexer started persisting per-face quality; an older event skips those two
# gates (and says so via `qualityKnown`) rather than suggesting nothing at all.
ANCHOR_MAX_FACES = int(os.environ.get("ANCHOR_MAX_FACES", "2"))
ANCHOR_MIN_FRONTALITY = float(os.environ.get("ANCHOR_MIN_FRONTALITY", "0.55"))
ANCHOR_MIN_FACE_FRAC = float(os.environ.get("ANCHOR_MIN_FACE_FRAC", "0.05"))
ANCHOR_MIN_FACE_PX = float(os.environ.get("ANCHOR_MIN_FACE_PX", "110"))
ANCHOR_MIN_FACE_SCORE = float(os.environ.get("ANCHOR_MIN_FACE_SCORE", "0.45"))
ANCHOR_MIN_FACE_Z = float(os.environ.get("ANCHOR_MIN_FACE_Z", "6.0"))
# Size that counts as "full marks" when ranking candidates (fraction of the
# image's short side, and the px fallback for quality-less manifests).
ANCHOR_FULL_FACE_FRAC = float(os.environ.get("ANCHOR_FULL_FACE_FRAC", "0.20"))
ANCHOR_FULL_FACE_PX = float(os.environ.get("ANCHOR_FULL_FACE_PX", "400"))
# Weight of an anchor's face in the query centroid, relative to 1.0 per selfie.
ANCHOR_FACE_WEIGHT = float(os.environ.get("ANCHOR_FACE_WEIGHT", "1.0"))
# 'replace' (default) drops the selfie's outfit from the person query entirely:
# the anchor is a photo from THIS event, so its clothing is the event-day
# clothing, while the selfie's may be from another day — averaging the two
# halves the signal that capture-time fusion (Item 1) exists to exploit.
# 'blend' keeps both (the PRF behaviour) for A/B.
ANCHOR_PERSON_MODE = os.environ.get("ANCHOR_PERSON_MODE", "replace")

# Item 5 (candidate-side quality weighting): attenuate a candidate crop's score
# by its own frontality × size when the indexer recorded them. 0.0 = off, which
# is the default until the offline sweep on judged labels picks a value — it
# trades recall (a legitimate side-on photo of you ranks lower) for precision
# (a back-row face that drifts onto the wrong identity ranks lower too).
FACE_QUALITY_WEIGHT = float(os.environ.get("FACE_QUALITY_WEIGHT", "0"))

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


def _mean_unit(vectors: list[np.ndarray], weights: list[float] | None = None) -> np.ndarray | None:
    """Centroid of L2-normalized vectors, itself L2-normalized (§1.1).

    Averaging unit embeddings and renormalizing is the standard multi-reference
    query: it cancels the pose/blur noise present in any single shot while
    keeping the result on the unit sphere so cosine == dot still holds. Returns
    None for an empty input (or a degenerate centroid at the origin).

    `weights` (same length as `vectors`) lets an anchor count for more than one
    selfie; omitted means a plain mean, bit-identical to the unweighted path."""
    if not vectors:
        return None
    mat = np.stack([np.asarray(v, dtype=np.float32).reshape(-1) for v in vectors])
    mat = mat / np.maximum(np.linalg.norm(mat, axis=1, keepdims=True), 1e-12)
    if weights is None:
        centroid = mat.mean(axis=0)
    else:
        w = np.asarray(weights, dtype=np.float32).reshape(-1)
        if w.shape[0] != mat.shape[0]:
            raise ValueError(f"weights/vectors length mismatch: {w.shape[0]} vs {mat.shape[0]}")
        total = float(w.sum())
        if total <= 1e-12:
            return None
        centroid = (mat * w[:, None]).sum(axis=0) / total
    norm = float(np.linalg.norm(centroid))
    if norm < 1e-12:
        return None
    return (centroid / norm).astype(np.float32)


def _norm_box(box, width: int, height: int) -> list[float] | None:
    """Pixel box → fractions of the image (0–1), clamped.

    The api/browser never sees the reference image's pixel dimensions, so boxes
    cross the wire normalized: the client can then outline the matched face over
    its own <img> with plain percentage offsets. EXIF orientation is already
    baked in by decode_image, and the browser orients the same way, so the two
    coordinate spaces agree."""
    if box is None or width <= 0 or height <= 0:
        return None
    x1, y1, x2, y2 = (float(v) for v in box)
    clamp = lambda v: max(0.0, min(1.0, v))  # noqa: E731
    return [clamp(x1 / width), clamp(y1 / height), clamp(x2 / width), clamp(y2 / height)]


def _select_reference(
    result: dict,
) -> tuple[np.ndarray | None, np.ndarray | None, list[dict], dict | None]:
    """Pick one query face + its person crop from ONE reference image.

    A reference image may contain bystanders, so we take only the most confident
    *usable* face (not a centroid over the image — that would blend identities)
    and the person crop associated with it. Returns
    (face_embedding | None, person_embedding | None, faces_diag, selected_face)
    where faces_diag is the per-face quality report used for the no_usable_face
    422 and selected_face is the face this query actually used (None when none
    was usable) — the api surfaces its box and quality warnings so a searcher
    who uploaded a group shot can see WHICH face we matched, and one who
    uploaded a small or turned-away face is told so."""
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
        face,
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


def _person_row_for_face(event, photo_id: str, face_box, person_query) -> int | None:
    """The outfit row belonging to the person whose face is `face_box`.

    The manifest keeps face and person boxes but not the pairing the pipeline
    computed, so recover it by geometry first (the face centre lies inside the
    person box — `face_in_person`, the same rule the indexer used). Similarity to
    the current person query is only a tie-break, and an ambiguous photo returns
    None: no outfit reference is better than a bystander's shirt."""
    rows = event.rows_for_photo("person", photo_id)
    if not rows:
        return None
    if face_box is not None:
        inside = [
            r for r in rows
            if event.crop_meta("person", r).get("box") is not None
            and face_in_person(face_box, event.crop_meta("person", r)["box"])
        ]
        if len(inside) == 1:
            return inside[0]
        if inside:
            rows = inside
    if len(rows) == 1:
        return rows[0]
    if person_query is not None:
        vecs = event.vectors["person"][rows]
        return rows[int(np.argmax(vecs @ person_query))]
    return None


def _apply_anchors(
    event,
    anchor_ids: list[str],
    face_refs: list[np.ndarray],
    person_refs: list[np.ndarray],
    face_query,
    person_query,
):
    """Fold caller-chosen anchor photos into the query. Returns
    (face_query, person_query, applied_ids).

    Runs AFTER PRF so `ANCHOR_PERSON_MODE=replace` has the last word on the
    outfit reference. Which crop in the anchor is "the person" is decided by
    similarity to the current face centroid — the anchor came from this user's
    own results, but a two-face photo still has to pick a side."""
    applied: list[str] = []
    face_weights = [1.0] * len(face_refs)
    anchor_person_vecs: list[np.ndarray] = []
    for pid in anchor_ids:
        rows = event.rows_for_photo("face", pid)
        if not rows:
            continue  # not indexed / no face in it → nothing to anchor on
        if face_query is not None:
            row = rows[int(np.argmax(event.vectors["face"][rows] @ face_query))]
        elif len(rows) == 1:
            row = rows[0]
        else:
            continue  # no face query to disambiguate a multi-face anchor
        face_refs.append(event.vectors["face"][row])
        face_weights.append(ANCHOR_FACE_WEIGHT)
        person_row = _person_row_for_face(
            event, pid, event.crop_meta("face", row).get("box"), person_query
        )
        if person_row is not None:
            anchor_person_vecs.append(event.vectors["person"][person_row])
        applied.append(pid)

    if not applied:
        return face_query, person_query, applied

    # Explicit None checks, not `or`: these are numpy arrays, whose truthiness
    # raises. A degenerate centroid leaves the previous query in place.
    face_centroid = _mean_unit(face_refs, face_weights)
    if face_centroid is not None:
        face_query = face_centroid
    if anchor_person_vecs:
        if ANCHOR_PERSON_MODE == "replace":
            # Mutate person_refs in place: the caller's list is what any later
            # fold would extend, so leaving the selfie's outfit in it would let
            # the discarded clothing back into the query.
            person_refs[:] = list(anchor_person_vecs)
        else:
            person_refs.extend(anchor_person_vecs)
        person_centroid = _mean_unit(person_refs)
        if person_centroid is not None:
            person_query = person_centroid
    return face_query, person_query, applied


def _anchor_candidate(event, face_hit: dict, min_face_score: float) -> dict | None:
    """Score one result as a potential anchor, or None if it fails a gate."""
    pid = face_hit["photoId"]
    if face_hit["score"] < min_face_score:
        return None
    faces = event.face_count(pid)
    if faces > ANCHOR_MAX_FACES:
        return None
    q = face_hit.get("quality") or {}
    if q.get("usable") is False:
        return None
    front = q.get("frontality")
    frac = q.get("face_frac")
    if front is not None and front < ANCHOR_MIN_FRONTALITY:
        return None
    if frac is not None and frac < ANCHOR_MIN_FACE_FRAC:
        return None
    box = face_hit.get("box") or [0.0, 0.0, 0.0, 0.0]
    face_px = float(min(box[2] - box[0], box[3] - box[1]))
    if frac is None and face_px < ANCHOR_MIN_FACE_PX:
        return None

    if frac is not None:
        size_term = min(1.0, frac / max(ANCHOR_FULL_FACE_FRAC, 1e-9))
    else:
        size_term = min(1.0, face_px / max(ANCHOR_FULL_FACE_PX, 1e-9))
    # An unmeasured frontality can't be assumed frontal, so it scores below a
    # face we know is head-on but above one we know is turned away.
    front_term = 0.6 if front is None else front
    solo_term = 1.0 if faces <= 1 else 0.5
    conf_term = min(1.0, max(0.0, (face_hit["score"] - min_face_score) / max(min_face_score, 1e-9)))
    return {
        "photoId": pid,
        # Deliberately NOT ranked by match score: the top hit is the photo most
        # like the selfie, which adds the least new information. What makes a
        # good anchor is a clean, large, solo, front-facing face — score only
        # breaks near-ties (and gates entry above).
        "suitability": round(
            0.40 * front_term + 0.30 * size_term + 0.20 * solo_term + 0.10 * conf_term, 4
        ),
        "faceScore": round(float(face_hit["score"]), 4),
        "faceCount": faces,
        "facePx": round(face_px, 1),
        "frontality": None if front is None else round(float(front), 3),
        "faceFrac": None if frac is None else round(float(frac), 4),
        "qualityKnown": front is not None or frac is not None,
    }


def _suggest_anchor(event, ranked: list[dict], face_hits: list[dict], tnorm: bool, exclude: set[str]):
    """Best anchor among the results we are about to return, or None.

    Restricted to `ranked` (post-threshold, post-top_k) so the suggestion is
    always a photo the caller can show the user, and to photos not already used
    as a reference this run."""
    if not ANCHOR_SUGGEST or not face_hits:
        return None
    min_face_score = ANCHOR_MIN_FACE_Z if tnorm else ANCHOR_MIN_FACE_SCORE
    by_photo = {h["photoId"]: h for h in face_hits}
    best = None
    for hit in ranked[:ANCHOR_CANDIDATE_POOL]:
        pid = hit["photoId"]
        if pid in exclude:
            continue
        face_hit = by_photo.get(pid)
        if face_hit is None:
            continue
        cand = _anchor_candidate(event, face_hit, min_face_score)
        if cand is not None and (best is None or cand["suitability"] > best["suitability"]):
            best = cand
    return best


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True, "service": "matcher"})


@app.post("/quality")
def check_quality():
    """Grade reference selfies at PICK time, before any search.

    Form fields: file (image; may repeat — one verdict per part). Detection only:
    no embeddings are computed, so this is cheap enough to run on every file the
    user picks, and it answers the question the old flow could only answer after
    a full search came back ("no clear face found — try again").

    Returns {modelVersion, files: [{index, filename, usable, faceCount,
    selfieScore, advisories[], reasons[], faceScore, faceBox, frontality,
    faceFrac, facePx, blur}], bestIndex, anyUsable}. `reasons` are hard failures;
    `advisories` are non-blocking hints.

    `reasons` here is the `/search` gate PLUS `multiple_faces`: a reference
    selfie with a bystander in it is refused outright, because which face gets
    searched for would otherwise be decided by detector confidence alone.
    """
    files = request.files.getlist("file")
    if not files:
        return jsonify({"error": "missing_file", "detail": "multipart field 'file' required"}), 400

    reports = []
    model_version = None
    for i, file in enumerate(files):
        entry: dict = {"index": i, "filename": file.filename or f"file{i}"}
        try:
            img = decode_image(file.read())
        except Exception:
            logger.exception("image decode failed")
            reports.append({**entry, "usable": False, "faceCount": 0, "selfieScore": 0.0,
                            "advisories": [], "reasons": ["bad_image"]})
            continue
        result = assess_faces(img)
        model_version = result["model_version"]
        faces = result["faces"]
        # Same choice /search makes: the most confident usable face, falling back
        # to the most confident face at all so a rejected selfie can still say
        # WHY (too small / too blurry) instead of "no face".
        usable = [f for f in faces if f["quality"]["usable"]]
        best = max(usable or faces, key=lambda f: f["score"], default=None)
        if best is None:
            reports.append({**entry, "usable": False, "faceCount": 0, "selfieScore": 0.0,
                            "advisories": [], "reasons": ["no_face"]})
            continue
        q = best["quality"]
        # More than one face in a REFERENCE selfie is a hard failure, not a hint.
        # The matcher would silently query with whichever face it is most
        # confident about, and on a group shot that is a coin flip between the
        # searcher and their friend — which surfaces as "it found someone else's
        # photos". There is no safe way to guess, so we refuse the photo and ask
        # for one with only them in it.
        #
        # Scoped to THIS endpoint on purpose: `assess_face` is shared with the
        # indexer, where a photo full of faces is the normal case and must stay
        # perfectly usable.
        reasons = list(q["reasons"])
        if len(faces) > 1:
            reasons.insert(0, "multiple_faces")
        img_h, img_w = img.shape[:2]
        reports.append({
            **entry,
            "usable": not reasons,
            "faceCount": len(faces),
            "selfieScore": quality.selfie_score(q),
            # face_advisories, not selfie_advisories: the multi-face case is a
            # `reason` here, and reporting it in both lists would show the user
            # the same complaint twice.
            "advisories": quality.face_advisories(q),
            "reasons": reasons,
            "faceScore": round(float(best["score"]), 4),
            # Normalized box of the graded face, so the client can show a crop of
            # it ("is this you?") without knowing the image's pixel size. Same
            # convention as /search's referenceFaces.selectedFace.
            "faceBox": _norm_box(best["box"], img_w, img_h),
            "frontality": None if q["frontality"] is None else round(float(q["frontality"]), 3),
            "faceFrac": round(float(q["face_frac"]), 4),
            "facePx": q["face_px"],
            "blur": round(float(q["blur"]), 1),
        })

    ranked = [r for r in reports if r["usable"]]
    best_index = (
        max(ranked, key=lambda r: r["selfieScore"])["index"] if ranked else None
    )
    return jsonify({
        "modelVersion": model_version,
        "files": reports,
        # Which of the picked photos to lead with. None when none is usable —
        # the caller should ask for a different photo rather than search.
        "bestIndex": best_index,
        "anyUsable": bool(ranked),
    })


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
    anchor_photo_ids? (comma-separated photoIds to re-query from, folded in from
    the index — anchor promotion), normalize? (1/true to T-norm scores — §1.3).
    Returns the per-photo ranking for the event, plus `anchorSuggestion`: the
    most suitable result to anchor a follow-up search on."""
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
    anchor_ids = [p.strip() for p in request.form.get("anchor_photo_ids", "").split(",") if p.strip()]

    files = request.files.getlist("file")
    if not files:
        return jsonify({"error": "missing_file", "detail": "multipart field 'file' required"}), 400

    # Embed every reference image and keep one query face + person crop each; the
    # centroid over several selfies is a stronger, less pose-sensitive query.
    face_refs: list[np.ndarray] = []
    person_refs: list[np.ndarray] = []
    faces_diag: list[dict] = []
    # Per-reference-image face census, in upload order. A selfie with more than
    # one face means we silently chose one of them, so the api relays this and
    # the web app warns the searcher instead of letting them trust results that
    # may belong to a bystander.
    reference_faces: list[dict] = []
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
        face_emb, person_emb, diag, selected = _select_reference(result)
        faces_diag.extend(diag)
        img_h, img_w = img.shape[:2]
        reference_faces.append(
            {
                "faces": len(result["faces"]),
                "usableFaces": sum(1 for f in result["faces"] if f["quality"]["usable"]),
                "selectedFace": _norm_box(
                    selected["box"] if selected is not None else None, img_w, img_h
                ),
                # Advisory problems with the face we queried with (small /
                # turned away), and — when nothing was usable — the reasons the
                # faces were rejected. The api turns both into plain language so
                # the searcher is told what is wrong right after uploading.
                "selectedWarnings": list(selected["quality"]["warnings"]) if selected else [],
                "blockingReasons": (
                    []
                    if selected is not None
                    else sorted({r for f in result["faces"] for r in f["quality"]["reasons"]})
                ),
            }
        )
        if face_emb is not None:
            face_refs.append(face_emb)
        if person_emb is not None:
            person_refs.append(person_emb)

    if not face_refs and mode != "person":
        return (
            jsonify(
                {"error": "no_usable_face", "faces": faces_diag, "referenceFaces": reference_faces}
            ),
            422,
        )

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
    anchors_applied: list[str] = []
    if anchor_ids:
        face_query, person_query, anchors_applied = _apply_anchors(
            event, anchor_ids, face_refs, person_refs, face_query, person_query
        )

    face_hits = (
        event.top_photos(
            "face", face_query, k=retrieve_k, tnorm=normalize,
            quality_weight=FACE_QUALITY_WEIGHT,
        )
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

    results = ranked if top_k is None else ranked[:top_k]
    return jsonify(
        {
            "eventId": event_id,
            "mode": mode,
            "modelVersion": model_version,
            "indexModelVersion": event.manifest.get("modelVersion"),
            "normalized": normalize,
            "referenceFaces": reference_faces,
            "numReferences": len(files),
            "numPrfPhotos": len(prf_ids),
            "anchorPhotoIds": anchors_applied,
            # Suggested anchor for a follow-up search. Excludes photos already
            # folded in as a reference this run — re-anchoring on the same photo
            # would change nothing.
            "anchorSuggestion": _suggest_anchor(
                event, results, face_hits, normalize, {*anchors_applied, *prf_ids}
            ),
            "faceQualityWeight": FACE_QUALITY_WEIGHT,
            "results": results,
        }
    )


if __name__ == "__main__":  # local dev only; Cloud Run uses gunicorn (Dockerfile)
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8081)), debug=True)
